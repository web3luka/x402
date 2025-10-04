// Test script to debug TON RPC
import { createTonApiRpc } from "../x402/src/ton/rpc";
import { normalizeTonAddress } from "../x402/src/ton/utils";

/**
 *
 */
async function testRpc() {
  const rpc = createTonApiRpc(process.env.TONAPI_KEY);

  const to = "UQAKd9dE5QxdHkjS82BkaUH9jmz-wwSEv2hyEaazIjKuVSHJ";
  const memo = "x402:ton-demo-002";

  console.log("🔍 Testing TON RPC...");
  console.log("To address:", to);
  console.log("Normalized:", normalizeTonAddress(to));
  console.log("Memo:", memo);
  console.log("");

  try {
    console.log("📡 Calling findIncomingByMemo...");
    const tx = await rpc.findIncomingByMemo(to, memo);

    if (tx) {
      console.log("✅ Transaction found!");
      console.log("Hash:", tx.hash);
      console.log("To:", tx.to);
      console.log("Amount:", tx.amount);
      console.log("Comment:", tx.comment);
    } else {
      console.log("❌ Transaction NOT found");
    }
  } catch (error) {
    console.error("💥 Error:", error);
  }
}

testRpc();
