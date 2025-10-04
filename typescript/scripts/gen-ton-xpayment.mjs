// Usage examples:
//   node scripts/gen-ton-xpayment.mjs \
//     --scheme exact --network TON --txid abc123
//
//   node scripts/gen-ton-xpayment.mjs \
//     --scheme exact --network TON \
//     --to UQ... --amountAtomic 1000000000 --memo x402:test001 --networkId ton:mainnet
//
// Output: a single line you can paste into curl, e.g.:
//   X-PAYMENT eyJzY2hlbWU...
//
// NOTE: This mirrors buildTonPaymentHeader from your tests: "X-PAYMENT <base64url(JSON)>"

function parseArgs() {
  const args = process.argv.slice(2)
  const out = {}
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]
    const v = args[i + 1]
    if (!k?.startsWith('--')) continue
    out[k.slice(2)] = v
  }
  return out
}

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function buildHeader(payload) {
  const encoded = base64url(JSON.stringify(payload))
  return `X-PAYMENT ${encoded}`
}

;(function main() {
  const a = parseArgs()

  // Minimal payload variant used in your test:
  //   { scheme: 'exact', network: 'TON', txid: 'abc123' }
  // Ale dorzuciłem też bogatszy wariant z TON params, gdy chcesz przekazać więcej danych (to,to,amount,memo,networkId).
  // Serwer może użyć tego do weryfikacji.
  let payload

  if (a.to && a.amountAtomic && a.memo && a.networkId) {
    // bogatszy payload – wygodne do integracji TON
    payload = {
      scheme: a.scheme || 'exact',
      network: a.network || 'TON',
      ton: {
        network: a.networkId, // "ton:mainnet" | "ton:testnet"
        to: a.to, // address (raw/user-friendly)
        amountAtomic: a.amountAtomic, // string
        memo: a.memo, // "x402:..."
      },
    }
  } else {
    // minimalny payload kompatybilny z Twoim testem
    payload = {
      scheme: a.scheme || 'exact',
      network: a.network || 'TON',
      ...(a.txid ? { txid: a.txid } : {}),
    }
  }

  const header = buildHeader(payload)
  console.log(header)
})()
