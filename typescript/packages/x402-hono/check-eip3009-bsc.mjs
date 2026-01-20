import { createPublicClient, http, toFunctionSelector } from "viem";
import { bsc } from "viem/chains";

// ---- config ----
const TOKENS = [
  { symbol: "USDT", addr: "0x55d398326f99059fF775485246999027B3197955" },
  { symbol: "USDC", addr: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d" },
  { symbol: "BUSD", addr: "0xe9e7cea3dedca5984780bafc599bd69add087d56" },
  { symbol: "CAKE", addr: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82" },
  { symbol: "WBNB", addr: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" },
];

const RPC = process.env.BSC_RPC || "https://bsc-dataseed1.binance.org";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || ""; // opcjonalnie ustaw klucz

const client = createPublicClient({ chain: bsc, transport: http(RPC) });

// EIP-3009 target signature
const SIG =
  "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)";
const SELECTOR = toFunctionSelector(SIG).toLowerCase(); // "0x7b04a2d0" (wyliczane runtime)
const SELECTOR_RAW = SELECTOR.slice(2); // bez "0x"
const PUSH4_PREFIX = "63"; // PUSH4 opcode in EVM bytecode

async function fetchAbiFromBscScan(address) {
  if (!BSCSCAN_API_KEY) return null;
  const url = `https://api.bscscan.com/api?module=contract&action=getabi&address=${address}&apikey=${BSCSCAN_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const j = await res.json();
  if (j.status !== "1" || !j.result) return null;
  try {
    return JSON.parse(j.result);
  } catch {
    return null;
  }
}

function abiHasEip3009(abi) {
  try {
    return abi.some(
      e =>
        e?.type === "function" &&
        e?.name === "transferWithAuthorization" &&
        Array.isArray(e?.inputs) &&
        e.inputs.length === 9 &&
        e.inputs[0]?.type === "address" &&
        e.inputs[1]?.type === "address" &&
        e.inputs[2]?.type === "uint256" &&
        e.inputs[3]?.type === "uint256" &&
        e.inputs[4]?.type === "uint256" &&
        e.inputs[5]?.type === "bytes32" &&
        e.inputs[6]?.type === "uint8" &&
        e.inputs[7]?.type === "bytes32" &&
        e.inputs[8]?.type === "bytes32",
    );
  } catch {
    return false;
  }
}

// Bytecode heuristic: szukamy wystąpienia selektora oraz wzorca PUSH4 <selector>
function bytecodeSuggestsEip3009(bytecode) {
  if (!bytecode) return false;
  const code = bytecode.toLowerCase().replace(/^0x/, "");
  const hasSelector = code.includes(SELECTOR_RAW);
  const hasPush4 = code.includes(PUSH4_PREFIX + SELECTOR_RAW);
  // wymagaj przynajmniej samego selektora; PUSH4 wzmacnia pewność
  return hasSelector || hasPush4;
}

async function checkOne({ symbol, addr }) {
  // 1) spróbuj ABI
  let viaAbi = null;
  if (BSCSCAN_API_KEY) {
    try {
      const abi = await fetchAbiFromBscScan(addr);
      if (abi) viaAbi = abiHasEip3009(abi);
    } catch {
      viaAbi = null;
    }
  }

  // 2) fallback: bytecode
  let viaCode = null;
  try {
    const code = await client.getBytecode({ address: addr });
    viaCode = bytecodeSuggestsEip3009(code || "");
  } catch {
    viaCode = null;
  }

  // Werdykt
  let verdict;
  if (viaAbi === true) verdict = "✅ YES (ABI)";
  else if (viaAbi === false) verdict = "❌ NO (ABI)";
  else if (viaCode === true) verdict = "⚠️ Likely YES (bytecode)";
  else if (viaCode === false) verdict = "❌ NO (bytecode)";
  else verdict = "🤷 Unknown";

  console.log(
    `${symbol.padEnd(6)} ${addr}  ->  transferWithAuthorization: ${verdict}  (selector=${SELECTOR})`,
  );
}

async function main() {
  console.log(`RPC: ${RPC}`);
  if (BSCSCAN_API_KEY) console.log(`Using BscScan ABI check with key: YES\n`);
  else console.log(`BscScan ABI check: NO KEY (using bytecode heuristic only)\n`);

  const addrs = process.argv.slice(2).filter(Boolean);
  if (addrs.length) {
    for (const addr of addrs) await checkOne({ symbol: "TOKEN", addr });
  } else {
    for (const t of TOKENS) await checkOne(t);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
