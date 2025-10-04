import { mnemonicToWalletKey } from "ton-crypto";

async function main() {
  // Wklej swój seed (24 słowa) z Tonkeeper/Tonhub
  const mnemonic = [
    "word1", "word2", "word3", /* ... aż do 24 */
  ];

  const keyPair = await mnemonicToWalletKey(mnemonic);

  console.log("Your TON keys:");
  console.log("  Public:", keyPair.publicKey.toString("hex"));
  console.log("  Private:", keyPair.secretKey.toString("hex")); // to jest TON_PRIVATE_KEY
}

main();
