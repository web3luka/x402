// gen-ton-header.mjs
// Usage:
//   TON_PRIVATE_KEY=<hex> TON_ADDRESS=<UQ...> node scripts/gen-ton-header.mjs
//
// This script tries to use your x402 local createTonPayer implementation.
// If import fails, it will print instructions how to adapt.

import fs from 'fs'
import path from 'path'

async function tryImportCreateTonPayer() {
  // Adjust path if your createTonPayer is exported from a different module
  const possible = [
    '../packages/x402/src/ton', // repo root -> packages/x402/src/ton
    '../packages/x402/src/ton/index.js',
    '../packages/x402/src/ton/index.mjs',
    '../packages/x402/src/ton/ton.js',
  ]
  for (const p of possible) {
    try {
      const full = path.resolve(process.cwd(), p)
      if (fs.existsSync(full) || fs.existsSync(full + '.js') || fs.existsSync(full + '.mjs')) {
        const mod = await import(full)
        // try common export names
        if (mod.createTonPayer) return { createTonPayer: mod.createTonPayer, modPath: full }
        if (mod.default) return { createTonPayer: mod.default, modPath: full }
      }
    } catch (e) {
      // ignore, continue
    }
  }
  return null
}

async function main() {
  const TON_PRIVATE_KEY = process.env.TON_PRIVATE_KEY
  const TON_ADDRESS = process.env.TON_ADDRESS
  const ENDPOINT = process.env.ENDPOINT ?? 'http://localhost:4021/weather'

  if (!TON_PRIVATE_KEY || !TON_ADDRESS) {
    console.error('Set TON_PRIVATE_KEY and TON_ADDRESS env vars. Example:')
    console.error('  TON_PRIVATE_KEY=<hex> TON_ADDRESS=UQ... node scripts/gen-ton-header.mjs')
    process.exit(1)
  }

  const importer = await tryImportCreateTonPayer()
  if (!importer) {
    console.error(
      'Could not find createTonPayer export in your local repo under packages/x402/src/ton.'
    )
    console.error(
      'If your createTonPayer is in a different path/export name, either adjust the possible[] list'
    )
    console.error(
      'or use your own small signer to create the header. Example fallback steps are printed below.'
    )
    process.exit(2)
  }

  const { createTonPayer, modPath } = importer
  console.log('Using createTonPayer from:', modPath)

  // create payer instance (adjust parameters if your API differs)
  const payer = await createTonPayer({
    privateKeyHex: TON_PRIVATE_KEY,
    address: TON_ADDRESS,
    network: 'ton:mainnet',
  })

  // We expect payer to implement x402 payer interface (signRequest or signPayment / wrapFetchWithPayment)
  // Try common helpers:
  if (typeof payer.signPayment === 'function') {
    // hypothetical: signPayment returns base64url header
    const header = await payer.signPayment({ method: 'GET', url: ENDPOINT })
    console.log('\nX-Payment:', header)
    console.log('\nYou can now curl like:')
    console.log(`curl -H "X-Payment: ${header}" ${ENDPOINT}`)
    process.exit(0)
  }

  // if repo exposes wrapFetchWithPayment we can use it
  try {
    const wrapMod = await import('../packages/x402/src/ton/wrapFetchWithPayment.js').catch(
      () => null
    )
    if (wrapMod && typeof wrapMod.wrapFetchWithPayment === 'function') {
      const { wrapFetchWithPayment } = wrapMod
      const f = wrapFetchWithPayment(fetch, payer)
      const req = new Request(ENDPOINT, { method: 'GET' })
      // call wrapper which should attach header to req internally and return Response
      await f(req)
      // many implementations attach header to the Request object; try to read it
      const hdr = req.headers.get('x-payment') || req.headers.get('X-Payment')
      if (hdr) {
        console.log('\nX-Payment:', hdr)
        console.log(`\ncurl -H "X-Payment: ${hdr}" ${ENDPOINT}`)
        process.exit(0)
      } else {
        // fallback: maybe wrapper returns header in response
        console.log(
          'Request was sent via wrapper; check response headers or adjust wrapper to expose header.'
        )
        process.exit(0)
      }
    }
  } catch (e) {
    // no-op
  }

  console.error(
    'No known header-generation method found on payer. Inspect payer object and adapt the script.'
  )
  console.error('Payer object keys:', Object.keys(payer))
  process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
