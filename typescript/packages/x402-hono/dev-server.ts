// packages/x402-hono/dev-server.ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { randomUUID } from "crypto";

import { verifyNativeExactByTxHash, verifyErc20ExactByTxHash } from "../x402/src/verify/evmVerify";
import { createPublicClient, http } from "viem";
import { bsc, bscTestnet } from "viem/chains";

const b64urlToJson = (s: string) => {
  const pad = (x: string) => x + "===".slice((x.length + 3) % 4);
  const b64 = pad(s.replace(/-/g, "+").replace(/_/g, "/"));
  const raw = Buffer.from(b64, "base64").toString("utf8");
  return JSON.parse(raw);
};

const app = new Hono();

// ---- settings & idempotency ----
const RELAXED_TXID_ONLY = process.env.X402_RELAXED_TXID_ONLY === "1";

// Optional Redis store for idempotency; fallback to in-memory Set
type IdemStore = {
  addIfNew: (txid: string) => Promise<{ ok: true } | { ok: false; reason: "REPLAY" | "STORE_ERR" }>;
  has: (txid: string) => Promise<boolean>;
};

/**
 *
 */
function createIdemStore(): IdemStore {
  const mem = new Set<string>();
  const ns = process.env.X402_IDEM_NAMESPACE || "x402:used_txids";
  const redisUrl = process.env.REDIS_URL;
  let redis: any = null;
  if (redisUrl) {
    try {
      const Redis = require("ioredis");
      redis = new Redis(redisUrl);
    } catch {
      redis = null;
    }
  }

  return {
    async addIfNew(txid: string) {
      try {
        if (redis) {
          const added = await redis.sadd(ns, txid);
          return added === 1 ? { ok: true } : ({ ok: false, reason: "REPLAY" } as const);
        }
        if (mem.has(txid)) return { ok: false, reason: "REPLAY" } as const;
        mem.add(txid);
        return { ok: true } as const;
      } catch {
        return { ok: false, reason: "STORE_ERR" } as const;
      }
    },
    async has(txid: string) {
      try {
        if (redis) {
          const isMember = await redis.sismember(ns, txid);
          return isMember === 1;
        }
        return mem.has(txid);
      } catch {
        return mem.has(txid);
      }
    },
  };
}

const idemStore = createIdemStore();

// ---- basic rate limiting (in-memory, per IP) ----
const RL_WINDOW_MS = Number(process.env.X402_RATE_WINDOW_MS ?? 10_000); // 10s
const RL_MAX = Number(process.env.X402_RATE_MAX ?? 30); // 30 requests/window
const rl = new Map<string, { t: number; c: number }>();

app.use("*", async (c, next) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const cur = rl.get(ip);
  if (!cur || now - cur.t > RL_WINDOW_MS) {
    rl.set(ip, { t: now, c: 1 });
  } else {
    if (cur.c >= RL_MAX) {
      c.header("Retry-After", Math.ceil((RL_WINDOW_MS - (now - cur.t)) / 1000).toString());
      return c.text("Too Many Requests", 429);
    }
    cur.c++;
  }
  await next();
});

// ---- request id middleware ----
app.use("*", async (c, next) => {
  const rid = randomUUID();
  // store in context
  // @ts-ignore - Hono Context has set/get via Map-like API
  c.set("requestId", rid);
  await next();
});

app.get("/weather", async c => {
  const reqId = (c as any).get?.("requestId") || randomUUID();
  const xpay = c.req.header("x-payment");
  let receipt: any = { ok: false, reason: "MISSING_HEADER" };

  try {
    if (!xpay) {
      c.header("X-Request-Id", reqId);
      c.header("X-Payment-Response", JSON.stringify(receipt));
      return c.json({ report: { weather: "sunny", temperature: 70 } });
    }
    const header = xpay as string; // narrowed by early return above
    const token = header.startsWith("X-PAYMENT ") ? header.slice("X-PAYMENT ".length) : header;
    const payload = b64urlToJson(token);
    console.log("x402.request", { requestId: reqId, payload });

    //
    // EVM / BSC VERIFICATION
    //
    if (payload.evm) {
      const evm = payload.evm;
      if (!evm?.txid || !evm?.network) {
        receipt = { ok: false, reason: "BAD_PAYLOAD" };
      } else {
        // network allowlist
        if (evm.network !== "bsc:mainnet" && evm.network !== "bsc:testnet") {
          receipt = { ok: false, reason: "BAD_NETWORK" };
          c.header("X-Request-Id", reqId);
          c.header("X-Payment-Response", JSON.stringify(receipt));
          return c.json({ report: { weather: "sunny", temperature: 70 } });
        }

        // idempotency guard
        if (await idemStore.has(evm.txid)) {
          receipt = { ok: false, reason: "REPLAY" };
          c.header("X-Request-Id", reqId);
          c.header("X-Payment-Response", JSON.stringify(receipt));
          return c.json({ report: { weather: "sunny", temperature: 70 } });
        }

        const chain = evm.network === "bsc:testnet" ? bscTestnet : bsc;
        const client = createPublicClient({ chain, transport: http() });

        // ERC-20 strict
        if (evm.asset?.kind === "erc20" && evm.to && evm.amountAtomic && evm.txid) {
          const res = await verifyErc20ExactByTxHash([client], evm.txid, {
            token: evm.asset.contract,
            to: evm.to,
            amountAtomic: BigInt(evm.amountAtomic),
            finalityConfirmations: Number(process.env.EVM_FINALITY ?? 12),
          });
          receipt = res.isValid
            ? { ok: true, txid: res.txHash, explorerUrl: res.explorerUrl }
            : { ok: false, reason: res.reason };
        }
        // Native strict
        else if (evm.to && evm.amountWei) {
          const strict = await verifyNativeExactByTxHash([client], evm.txid, {
            to: evm.to,
            amountWei: BigInt(evm.amountWei),
            requireEmptyInput: true,
            finalityConfirmations: 12,
          });
          receipt = strict.isValid
            ? { ok: true, txid: strict.txHash, explorerUrl: strict.explorerUrl }
            : { ok: false, reason: strict.reason };
        } else {
          // Relaxed txid-only mode gated by env
          if (RELAXED_TXID_ONLY) {
            const relaxed = await verifyTxIdFinality(client, evm.txid, 12);
            receipt = relaxed.ok
              ? { ok: true, txid: evm.txid, explorerUrl: `https://bscscan.com/tx/${evm.txid}` }
              : { ok: false, reason: "reason" in relaxed ? relaxed.reason : "VERIFY_FAILED" };
          } else {
            receipt = { ok: false, reason: "TX_REQUIRED_FOR_EXACT" };
          }
        }

        // idempotency: mark tx as used on success
        if ((receipt as any).ok === true) {
          await idemStore.addIfNew(evm.txid);
        }
      }
    } else {
      receipt = { ok: false, reason: "UNKNOWN_NETWORK" };
    }
  } catch (e: any) {
    receipt = { ok: false, reason: e?.message ?? "SERVER_ERROR" };
  }

  console.log("x402.result", { requestId: reqId, receipt });
  c.header("X-Request-Id", reqId);
  c.header("X-Payment-Response", JSON.stringify(receipt));
  return c.json({ report: { weather: "sunny", temperature: 70 } });
});

const port = Number(process.env.PORT || 4021);
serve({ fetch: app.fetch, port });
console.log(`✅ Hono dev server running on http://localhost:${port}`);
/**
 *
 * @param client
 * @param txHash
 * @param minConf
 */
async function verifyTxIdFinality(
  client: ReturnType<typeof createPublicClient>,
  txHash: `0x${string}`,
  minConf: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return { ok: false, reason: "TX_REVERTED" };
    const head = await client.getBlockNumber();
    const minedAt =
      typeof receipt.blockNumber === "bigint" ? receipt.blockNumber : BigInt(receipt.blockNumber);
    const confirmations = head - minedAt;
    if (confirmations < BigInt(minConf)) return { ok: false, reason: "INSUFFICIENT_FINALITY" };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? "VERIFY_FAILED" };
  }
}
