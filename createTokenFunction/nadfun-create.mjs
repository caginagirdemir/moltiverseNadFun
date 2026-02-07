import { initSDK } from "@nadfun/sdk";
import { parseEther, formatEther } from "ethers";
import fs from "node:fs";


import path from "node:path";
import { fileURLToPath } from "node:url";

async function loadImageBytes(imagePathOrUrl) {
  if (!imagePathOrUrl) return null;

  if (/^https?:\/\//i.test(imagePathOrUrl)) {
    const res = await fetch(imagePathOrUrl);
    if (!res.ok) throw new Error(`Image download failed: ${res.status} ${res.statusText}`);
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  }

  return fs.readFileSync(imagePathOrUrl);
}

console.error("SCRIPT STARTED");

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

let raw = "";
if (process.argv[2]) {
  raw = fs.readFileSync(process.argv[2], "utf8").trim();
} else {
  raw = fs.readFileSync(0, "utf8").trim();
}

if (!raw) throw new Error("No JSON input");
const data = JSON.parse(raw);

const nadSDK = initSDK({
  rpcUrl: must("RPC_URL"),
  privateKey: must("PRIVATE_KEY"),
  network: process.env.NETWORK || "testnet",
});

const name = data.name || "My Token";
const symbol = data.symbol || "MTK";
const description = data.description || "A token created with NadFun SDK";
const website = data.website || "";
const twitter = data.twitter || "";
const telegram = data.telegram || "";
const imagePathOrUrl = data.imagePath || "";
const imageBytes = await loadImageBytes(imagePathOrUrl); 
const initialBuy = data.initialBuy || "0.0001";

const feeConfig = await nadSDK.getFeeConfig();

const initialBuyAmount = parseEther(String(initialBuy));
const expectedTokens = await nadSDK.getInitialBuyAmountOut(initialBuyAmount);


const result = await nadSDK.createToken({
  name,
  symbol,
  description,
  image: imageBytes,
  imageContentType: "image/png",
  website,
  twitter,
  telegram,
  initialBuyAmount,
});

const out = {
  deployFeeMON: formatEther(feeConfig.deployFeeAmount),
  expectedTokens: formatEther(expectedTokens),
  ...result,
};

console.log(JSON.stringify(out));
