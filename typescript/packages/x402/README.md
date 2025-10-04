# x402

Core TypeScript implementation of the x402 Payment Protocol. This package provides the foundational types, schemas, and utilities that power all x402 integrations.

## Installation

```bash
npm install x402
```

## Overview

The x402 package provides the core building blocks for implementing the x402 Payment Protocol in TypeScript. It's designed to be used by:

- Middleware implementations (Express, Hono, Next.js)
- Client-side payment handlers (fetch wrapper)
- Facilitator services
- Custom integrations

## Integration Packages

This core package is used by the following integration packages:

- `x402-express`: Express.js middleware
- `x402-hono`: Hono middleware
- `x402-next`: Next.js middleware
- `x402-fetch`: Fetch API wrapper
- `x402-axios`: Axios interceptor

## BSC (BNB Smart Chain) Support

This package includes production-ready helpers for BSC (mainnet/testnet):

- **Networks**: `bsc` (56), `bsc-testnet` (97)
- **Default asset (mainnet)**: USDC at `0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d`
- **RPC clients with fallback & timeout**: see `x402/src/verify/evmClient.ts`
- **Verify helpers for ERC20 exact payments**: see `x402/src/verify/evmVerify.ts`

> Testnet note: On `bsc-testnet` we use a development mock token **SDT** at
> `0x64544969ed7EBf5f083679233325356EbE738930`. This is intended strictly for
> development/testing and is not a production stablecoin.

### Environment Variables

Set RPC endpoints (primary + fallbacks). Public endpoints are fine for dev, use provider keys in prod.

```bash
# BSC mainnet
BSC_RPC_PRIMARY=https://rpc.ankr.com/bsc
BSC_RPC_FALLBACK_1=https://bsc.quiknode.pro/KEY/
BSC_RPC_FALLBACK_2=https://bsc.nodereal.io/v1/KEY

# Optional: BSC testnet
# BSC_TESTNET_RPC_PRIMARY=...
# BSC_TESTNET_RPC_FALLBACK_1=...
# BSC_TESTNET_RPC_FALLBACK_2=...
```

### Creating EVM Clients (with fallback)

```ts
import { makeBscClients, withEvmClientsRetry } from "x402/verify";

const clients = makeBscClients();
const latestBlock = await withEvmClientsRetry(clients, c => c.getBlockNumber());
```

### Verifying ERC-20 Exact Payment on BSC

```ts
import { makeBscClients } from "x402/verify";
import { verifyErc20ExactByTxHash, verifyErc20ExactByLogs } from "x402/verify";

const clients = makeBscClients();

// 1) By known tx hash
const res1 = await verifyErc20ExactByTxHash(clients, "0x...", {
  token: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC on BSC
  to: "0xYourPayTo",
  amountAtomic: 100_000n, // 0.1 USDC (6 decimals)
});

// 2) By scanning logs (define sensible block range)
const res2 = await verifyErc20ExactByLogs(clients, {
  token: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
  to: "0xYourPayTo",
  amountAtomic: 100_000n,
  fromBlock: 0n,
});
```

### Verifying Native BNB Exact Payment on BSC

Use the native helper to validate value transfers in BNB by transaction hash. By default it enforces
empty calldata (EOA → EOA), which avoids counting internal transfers from contracts.

```ts
import { makeBscClients } from "x402/verify";
import { verifyNativeExactByTxHash } from "x402/verify";

const clients = makeBscClients();

const res = await verifyNativeExactByTxHash(clients, "0x...", {
  to: "0xYourPayTo",
  amountWei: 10_000_000_000_000_000n, // 0.01 BNB in wei
  // requireEmptyInput: false, // set to false if you explicitly allow contract calls with value
});

if (res.isValid) {
  // ok
}
```

> Note: Without trace APIs, internal value transfers from contracts cannot be reliably attributed.
> Keep `requireEmptyInput` enabled in most cases for stronger guarantees.

## Manual Server Integration

If you're not using one of our server middleware packages, you can implement the x402 protocol manually. Here's what you'll need to handle:

1. Return 402 error responses with the appropriate response body
2. Use the facilitator to validate payments
3. Use the facilitator to settle payments
4. Return the appropriate response header to the caller

For a complete example implementation, see our [advanced server example](https://github.com/coinbase/x402/tree/main/examples/typescript/servers/advanced) which demonstrates both synchronous and asynchronous payment processing patterns.

## Manual Client Integration

If you're not using our `x402-fetch` or `x402-axios` packages, you can manually integrate the x402 protocol in your client application. Here's how:

1. Make a request to a x402-protected endpoint. The server will respond with a 402 status code and a JSON object containing:
   - `x402Version`: The version of the x402 protocol being used
   - `accepts`: An array of payment requirements you can fulfill

2. Select the payment requirement you wish to fulfill from the `accepts` array

3. Create the payment header using the selected payment requirement

4. Retry your network call with:
   - The payment header assigned to the `X-PAYMENT` field
   - The `Access-Control-Expose-Headers` field set to `"X-PAYMENT-RESPONSE"` to receive the server's transaction response

For implementation examples, we recommend reviewing our official client packages:
- [x402-fetch implementation](https://github.com/coinbase/x402/blob/main/typescript/packages/x402-fetch/src/index.ts)
- [x402-axios implementation](https://github.com/coinbase/x402/blob/main/typescript/packages/x402-axios/src/index.ts)

