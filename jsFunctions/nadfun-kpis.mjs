// nadfun-kpis.mjs
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import "dotenv/config"; // .env otomatik okunur (dotenv dependency gerekiyor)
import { initSDK } from "@nadfun/sdk";
import { parseEther, formatUnits } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function safeWriteJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

// RPC helpers to compute fromBlock by timestamp (last 5 minutes)
async function rpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function getBlock(rpcUrl, blockNumberBigInt) {
  const hex = "0x" + blockNumberBigInt.toString(16);
  return rpc(rpcUrl, "eth_getBlockByNumber", [hex, false]);
}

function blockTimestampSec(block) {
  return Number(BigInt(block.timestamp));
}

async function findFromBlockByTime(rpcUrl, latestBlockNum, cutoffSec) {
  let hi = latestBlockNum;
  let hiBlock = await getBlock(rpcUrl, hi);
  let hiTs = blockTimestampSec(hiBlock);

  if (hiTs <= cutoffSec) return hi;

  let step = 500n;
  let lo = hi > step ? hi - step : 0n;

  while (true) {
    const blk = await getBlock(rpcUrl, lo);
    const loTs = blockTimestampSec(blk);
    if (loTs <= cutoffSec || lo === 0n) break;

    hi = lo;
    step = step * 2n;
    lo = hi > step ? hi - step : 0n;
  }

  let left = lo;
  let right = hi;

  while (left + 1n < right) {
    const mid = (left + right) / 2n;
    const midBlk = await getBlock(rpcUrl, mid);
    const midTs = blockTimestampSec(midBlk);

    if (midTs <= cutoffSec) left = mid;
    else right = mid;
  }

  return left;
}

function pickBigInt(obj, keys) {
  for (const k of keys) {
    if (!obj || obj[k] == null) continue;
    const v = obj[k];
    try {
      if (typeof v === "bigint") return v;
      if (typeof v === "number") return BigInt(Math.floor(v));
      if (typeof v === "string") return BigInt(v); // decimal or 0x...
    } catch {}
  }
  return 0n;
}

function normalizeTokenList(tokensJson) {
  // tokens.json için esnek okuma:
  // 1) ["0x..","0x.."]
  // 2) { "tokens": ["0x.."] }
  // 3) [{ "address":"0x.." }, ...]
  if (Array.isArray(tokensJson)) {
    if (tokensJson.every((x) => typeof x === "string")) return tokensJson;
    if (tokensJson.every((x) => typeof x === "object" && x?.address)) return tokensJson.map((x) => x.address);
  }
  if (tokensJson && Array.isArray(tokensJson.tokens)) return tokensJson.tokens;
  throw new Error("tokens.json format not recognized. Use an array of addresses or { tokens: [...] }.");
}

async function main() {
  //console.error("SCRIPT STARTED");

  const rpcUrl = must("RPC_URL");
  const privateKey = must("PRIVATE_KEY");
  const network = (process.env.NETWORK || "testnet").toLowerCase();

  const tokensPath = path.join(__dirname, "tokens.json");
  const cachePath = path.join(__dirname, "nadfun-kpis-cache.json");

  const tokensJson = readJson(tokensPath);
  const TOKENS = normalizeTokenList(tokensJson).map((t) => t.trim()).filter(Boolean);

  const SPIKE_PCT = Number(process.env.SPIKE_PCT ?? "10"); // istersen .env'ye koy

  const nadSDK = initSDK({
    rpcUrl,
    privateKey,
    network: network === "mainnet" ? "mainnet" : "testnet",
  });

  const indexer = nadSDK.createCurveIndexer();

  const latestBlock = await indexer.getLatestBlock();
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffSec = nowSec - 300;

  //const fromBlock = await findFromBlockByTime(rpcUrl, latestBlock, cutoffSec);
  const fromBlock = latestBlock > 200n ? (latestBlock - 200n) : 0n;

  const cache = safeReadJson(cachePath);
  const prevPrices = cache?.prices || {};
  const nextPrices = {};

  // "Price" için 1 MON -> token quote (yaklaşık)
  const oneMonIn = parseEther("1");

  let totalTrades5m = 0;
  let totalVolumeMon5m = 0;

  let mostActiveToken = null;
  let mostActiveTradeCount = -1;

  let spikeTokenCount5m = 0;

  const perToken = [];

  for (const token of TOKENS) {
    // 5dk Buy/Sell eventleri
    const events = await indexer.getEvents({
      fromBlock,
      toBlock: latestBlock,
      eventTypes: ["Buy", "Sell"],
      tokens: [token],
    });

    let buyCount = 0;
    let sellCount = 0;

    // Best-effort MON volume: Buy: MON in, Sell: MON out
    let volMonWei = 0n;

    for (const ev of events) {
      const t = ev?.eventType || ev?.type || ev?.name || ev?.event;

      const isBuy = t === "Buy" || ev?.eventType === "Buy";
      const isSell = t === "Sell" || ev?.eventType === "Sell";

      if (isBuy) buyCount++;
      if (isSell) sellCount++;

      if (isBuy) {
        // olası alan adları
        volMonWei += pickBigInt(ev, ["amountIn", "monIn", "value", "nativeIn", "ethIn"]);
      } else if (isSell) {
        volMonWei += pickBigInt(ev, ["amountOut", "monOut", "value", "nativeOut", "ethOut"]);
      }
    }

    const tradeCount = buyCount + sellCount;
    totalTrades5m += tradeCount;

    // MON volume
    const volMon = Number(formatUnits(volMonWei, 18));
    totalVolumeMon5m += volMon;

    if (tradeCount > mostActiveTradeCount) {
      mostActiveTradeCount = tradeCount;
      mostActiveToken = token;
    }

    // Price (yaklaşık): 1 MON ile kaç token alınır => tokensPerMon
    const quote = await nadSDK.getAmountOut(token, oneMonIn, true); // buy quote
    const tokensOut = quote?.amount ?? 0n;

    // Burada decimals her token için 18 olmayabilir.
    // Ama spike için "aynı metotla ölçülen göreli değişim" yeterli.
    const tokensPerMon = Number(formatUnits(tokensOut, 18)); // best-effort
    const priceMonPerToken = tokensPerMon > 0 ? 1 / tokensPerMon : null;

    const prev = prevPrices[token]?.priceMonPerToken;
    let deltaPct = null;

    if (priceMonPerToken != null && typeof prev === "number" && prev > 0) {
      deltaPct = ((priceMonPerToken - prev) / prev) * 100;
      if (Math.abs(deltaPct) >= SPIKE_PCT) spikeTokenCount5m++;
    }

    nextPrices[token] = { priceMonPerToken, ts: nowSec };

    perToken.push({
      token,
      buyCount5m: buyCount,
      sellCount5m: sellCount,
      tradeCount5m: tradeCount,
      volumeMon5m: volMon,
      priceMonPerToken,
      deltaPct,
    });
  }

  safeWriteJson(cachePath, {
    updatedAt: new Date().toISOString(),
    windowSec: 300,
    fromBlock: fromBlock.toString(),
    toBlock: latestBlock.toString(),
    spikeThresholdPct: SPIKE_PCT,
    prices: nextPrices,
  });

  const out = {
    windowSec: 300,
    fromBlock: fromBlock.toString(),
    toBlock: latestBlock.toString(),
    generatedAt: new Date().toISOString(),
    spikeThresholdPct: SPIKE_PCT,
    kpis: {
      totalTrades5m,
      totalVolumeMon5m,
      mostActiveToken5m: mostActiveToken,
      mostActiveTradeCount5m: mostActiveTradeCount,
      spikeTokenCount5m,
    },
    perToken,
  };

  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  process.stderr.write(String(err?.stack || err));
  process.exit(1);
});
