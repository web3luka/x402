// packages/x402-hono/dev-server.ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";

// ↓ importy z Twojej biblioteki (dostosuj ścieżki jeśli inne)
import { verifyTONExact } from "../x402/src/ton/verify";
import { createTonApiRpc } from "../x402/src/ton/rpc";
import type { TonAsset } from "../x402/src/ton/types";

// small helpers
const b64urlToJson = (s: string) => {
  const pad = (x: string) => x + "===".slice((x.length + 3) % 4);
  const b64 = pad(s.replace(/-/g, "+").replace(/_/g, "/"));
  const raw = Buffer.from(b64, "base64").toString("utf8");
  return JSON.parse(raw);
};

const app = new Hono();

app.get("/weather", async c => {
  const xpay = c.req.header("x-payment"); // format: "X-PAYMENT <token>" lub tylko <token>
  let receipt: any = { ok: false, reason: "MISSING_HEADER" };

  try {
    if (!xpay) {
      c.header("X-Payment-Response", JSON.stringify(receipt));
      return c.json({ report: { weather: "sunny", temperature: 70 } });
    }

    // przyjmujemy oba warianty: "X-PAYMENT <token>" i sam <token>
    const token = xpay.startsWith("X-PAYMENT ") ? xpay.slice("X-PAYMENT ".length) : xpay;
    const payload = b64urlToJson(token);

    // Oczekiwany układ:
    // payload = {
    //   scheme: 'exact',
    //   network: 'TON',
    //   ton: { network: 'ton:mainnet', to: 'UQ...', amountAtomic: '1000', memo: 'x402:...' }
    // }  // albo minimalny z txid
    const ton = payload.ton;
    if (!ton?.to || !ton?.amountAtomic || !ton?.memo || !ton?.network) {
      receipt = { ok: false, reason: "BAD_PAYLOAD" };
      c.header("X-Payment-Response", JSON.stringify(receipt));
      return c.json({ report: { weather: "sunny", temperature: 70 } });
    }

    const asset: TonAsset = { kind: "native", symbol: "TON", decimals: 9 };
    const rpc = createTonApiRpc(process.env.TONAPI_KEY); // opcjonalny api key

    const res = await verifyTONExact({
      memo: ton.memo,
      to: ton.to,
      asset,
      amountAtomic: BigInt(ton.amountAtomic),
      network: ton.network, // 'ton:mainnet' | 'ton:testnet'
      rpc,
      validUntil: Date.now() + 5 * 60_000,
    });

    receipt = res;
  } catch (e: any) {
    receipt = { ok: false, reason: e?.message ?? "SERVER_ERROR" };
  }

  c.header("X-Payment-Response", JSON.stringify(receipt));
  return c.json({ report: { weather: "sunny", temperature: 70 } });
});

const port = Number(process.env.PORT || 4021);
serve({ fetch: app.fetch, port });
console.log(`✅ Hono dev server listening on http://localhost:${port}`);
