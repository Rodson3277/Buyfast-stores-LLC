import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ExchangeChangeNow, ExchangeMonCash, verifiedMonCashPayment, units } from "../server/services/exchangeProviders";
import { ExchangeLifecycle, verifiedSwapStatus, type SwapOrder, type SwapRepository } from "../server/services/exchangeLifecycle";
import { createExchangePreparationRouter } from "../server/exchangePreparationRoutes";
import { integrationCopy } from "../client/src/pages/exchange-integration-copy";

const trx = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"; // Public token contract, mocked transport only.
const bsc = "0x" + "b".repeat(40);
const order = (): SwapOrder => ({
  id: "53aee34e-ad8f-4b04-8332-d70cc6d844c2", userId: "owner", purpose: "user_funded_swap",
  quoteId: "63aee34e-ad8f-4b04-8332-d70cc6d844c2", idempotencyKey: "unique-request-key",
  createdAt: new Date(Date.now() - 120000).toISOString(), status: "submitting", version: 0,
  data: { from: "usdt-trx", to: "usdt-bsc", amount: "25", address: bsc, refundAddress: trx },
});
function repository() {
  let current: SwapOrder | null = null;
  const events: string[] = [];
  const repo: SwapRepository = {
    saveQuote: async () => {},
    claim: async (userId, quoteId, key, address, refundAddress) => {
      if (current) {
        assert.equal(current.userId, userId);
        if (current.quoteId !== quoteId || current.data.address !== address || current.data.refundAddress !== refundAddress)
          throw new Error("IDEMPOTENCY_CONFLICT");
        return { order: structuredClone(current), claimed: false };
      }
      current = order();
      return { order: structuredClone(current), claimed: true };
    },
    update: async (previous, status, reason, patch = {}) => {
      if (!current || current.version !== previous.version) throw new Error("ORDER_CHANGED");
      current = { ...current, ...patch, status, version: current.version + 1 };
      events.push(reason);
      return structuredClone(current);
    },
    get: async (userId, id) => current?.userId === userId && current.id === id ? structuredClone(current) : null,
    list: async userId => current?.userId === userId ? [structuredClone(current)] : [],
  };
  return { repo, events };
}
const input = { quoteId: order().quoteId, idempotencyKey: "unique-request-key", address: bsc, refundAddress: trx };

test("both provider mutation adapters and lifecycle default locked before any network call", async () => {
  const never = (async () => { throw new Error("NETWORK_MUST_NOT_RUN"); }) as typeof fetch;
  const crypto = new ExchangeChangeNow(() => "test", undefined, never);
  const moncash = new ExchangeMonCash(() => ({ clientId: "test", clientSecret: "test" }), "sandbox", undefined, never);
  await assert.rejects(crypto.create({ fromNetwork: "trx", toNetwork: "bsc", amount: "25", address: bsc, refundAddress: trx }), /EXECUTION_LOCKED/);
  await assert.rejects(moncash.createPayment("order", "25"), /EXECUTION_LOCKED/);
  await assert.rejects(moncash.payout({ reference: "order", amount: "25", receiver: "50937007294", desc: "test" }), /EXECUTION_LOCKED/);
  await assert.rejects(new ExchangeLifecycle(repository().repo, crypto).create("owner", input), /EXECUTION_LOCKED/);
});

test("official MonCash host, POST retrieval and prefunded methods; no speculative capture endpoint", async () => {
  const calls: { url: string; method: string; body: any }[] = [];
  const transport = (async (url: any, options: any) => {
    calls.push({ url: String(url), method: options.method, body: options.body });
    return new Response(JSON.stringify(String(url).endsWith("/oauth/token")
      ? { access_token: "mock-only", expires_in: 59 } : { status: 200 }), { status: 200 });
  }) as typeof fetch;
  const api = new ExchangeMonCash(() => ({ clientId: "mock", clientSecret: "mock" }), "sandbox", () => false, transport);
  await api.payment("stored-order");
  await api.payoutStatus("stored-reference");
  await api.balance();
  assert.equal(calls.length, 4);
  assert.ok(calls.every(c => c.url.startsWith("https://sandbox.moncashbutton.digicelgroup.com/Api/")));
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1].body), { orderId: "stored-order" });
  assert.ok(calls[2].url.endsWith("/PrefundedTransactionStatus"));
  assert.equal(calls[3].method, "GET");
  assert.ok(!calls.some(c => c.url.includes("Transfert")));
});

test("MonCash collection evidence rejects wrong reference, amount, currency and pending", () => {
  const evidence = { status: 200, payment: { reference: "stored-order", cost: 25, transaction_id: "tx", message: "successful" } };
  assert.equal(verifiedMonCashPayment(evidence, "stored-order", "25.00"), "tx");
  for (const patch of [{ reference: "other" }, { cost: 24.99 }, { cost: 26 }, { currency: "USD" }, { message: "pending" }, { transaction_id: null }]) {
    assert.equal(verifiedMonCashPayment({ ...evidence, payment: { ...evidence.payment, ...patch } }, "stored-order", "25"), null);
  }
  assert.equal(units("1.000001"), 1000001n);
  assert.throws(() => units("1e3"));
});

test("MonCash mutation contracts are mocked only and uncertain payouts are not automatically retried", async () => {
  const calls: { url: string; body: any }[] = [];
  let timeout = false;
  const api = new ExchangeMonCash(() => ({ clientId: "mock", clientSecret: "mock" }), "sandbox", () => true,
    (async (url: any, options: any) => {
      const path = String(url);
      calls.push({ url: path, body: options.body });
      if (path.endsWith("/oauth/token")) return new Response(JSON.stringify({ access_token: "mock", expires_in: 59 }));
      if (path.endsWith("/CreatePayment")) return new Response(JSON.stringify({
        status: 202, mode: "sandbox", payment_token: { token: "mock token" },
      }));
      if (timeout) throw new Error("timeout after provider accepted request");
      return new Response(JSON.stringify({ status: 200, transfer: { transaction_id: "mock-transfer" } }));
    }) as typeof fetch);
  const created = await api.createPayment("stored-order", "25.50");
  assert.equal(created.redirectUrl, "https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware/Payment/Redirect?token=mock%20token");
  assert.deepEqual(JSON.parse(calls[1].body), { orderId: "stored-order", amount: 25.5 });
  const input = { reference: "persisted-reference", receiver: "50937007294", amount: "25.50", desc: "Exchange" };
  await api.payout(input);
  assert.ok(calls[2].url.endsWith("/Api/v1/Transfert"));
  assert.deepEqual(JSON.parse(calls[2].body), { ...input, amount: 25.5 });
  timeout = true;
  await assert.rejects(api.payout({ ...input, reference: "different-persisted-reference" }), (error: any) =>
    error.code === "PROVIDER_OUTCOME_UNKNOWN" && error.uncertain === true);
  assert.equal(calls.length, 4);
});

test("concurrent duplicate submissions create one provider exchange; replay has no mutation", async () => {
  let calls = 0;
  const provider = new ExchangeChangeNow(() => "mock", () => true, (async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Response(JSON.stringify({ id: "provider-id", payinAddress: trx, fromCurrency: "usdt", toCurrency: "usdt",
      fromNetwork: "trx", toNetwork: "bsc", fromAmount: "25", payoutAddress: bsc, refundAddress: trx }), { status: 200 });
  }) as typeof fetch);
  const { repo, events } = repository();
  const lifecycle = new ExchangeLifecycle(repo, provider, () => true);
  await Promise.all([lifecycle.create("owner", input), lifecycle.create("owner", input)]);
  assert.equal(calls, 1);
  assert.equal((await lifecycle.create("owner", input)).status, "awaiting_deposit");
  assert.equal(calls, 1);
  assert.deepEqual(events, ["PROVIDER_CREATED"]);
  await assert.rejects(lifecycle.create("owner", { ...input, address: "0x" + "c".repeat(40) }), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(lifecycle.reconcile("other-user", order().id), /ORDER_NOT_FOUND/);
});

test("unknown provider mutation outcome is durably held, never retried on replay/reconcile", async () => {
  let calls = 0;
  const provider = new ExchangeChangeNow(() => "mock", () => true, (async () => { calls++; throw new Error("timeout"); }) as typeof fetch);
  const { repo } = repository();
  const lifecycle = new ExchangeLifecycle(repo, provider, () => true);
  assert.equal((await lifecycle.create("owner", input)).status, "review_required");
  assert.equal((await lifecycle.create("owner", input)).status, "review_required");
  assert.equal((await lifecycle.reconcile("owner", order().id)).status, "review_required");
  assert.equal(calls, 1);
});

test("authoritative crypto evidence binds stored provider, assets, networks, addresses, amount and hashes", () => {
  const stored = { ...order(), providerId: "provider-id", data: { ...order().data, payinAddress: trx } };
  const body = { id: "provider-id", fromCurrency: "usdt", toCurrency: "usdt", fromNetwork: "trx", toNetwork: "bsc",
    amountFrom: 25, amountTo: 24, refundAddress: trx, payoutAddress: bsc, payinAddress: trx, payinHash: "deposit-hash", payoutHash: "payout-hash", status: "finished" };
  assert.equal(verifiedSwapStatus(stored, body), "completed");
  for (const patch of [{ amountFrom: 24 }, { id: "other" }, { fromCurrency: "btc" }, { toNetwork: "eth" },
    { payoutAddress: trx }, { payinHash: "" }, { payoutHash: "" }, { amountTo: 0 }, { refundAddress: bsc },
    { amountFrom: null, expectedAmountFrom: "25" }, { amountFrom: "0.000", expectedAmountFrom: "25" }])
    assert.equal(verifiedSwapStatus(stored, { ...body, ...patch }), "review_required");
  for (const [status, expected] of [["waiting", "awaiting_deposit"], ["confirming", "processing"], ["failed", "failed"],
    ["expired", "expired"], ["refunded", "review_required"], ["verifying", "processing"], ["refunding", "processing"]])
    assert.equal(verifiedSwapStatus(stored, { ...body, status }), expected);
  assert.equal(verifiedSwapStatus(stored, { ...body, status: "waiting", amountFrom: "0.000", expectedAmountFrom: "25" }), "awaiting_deposit");
  const refund = { ...body, status: "refunded", refundHash: "mock-refund", refundAmount: "24.5" };
  assert.equal(verifiedSwapStatus(stored, refund), "refunded");
  for (const patch of [{ refundAmount: null }, { refundAmount: "0" }, { refundAmount: "26" },
    { amountFrom: null, expectedAmountFrom: "25" }, { refundHash: "" }])
    assert.equal(verifiedSwapStatus(stored, { ...refund, ...patch }), "review_required");
});

test("order routes enforce ownership; callbacks cannot supply payment evidence or unlock execution", async () => {
  const { repo } = repository();
  await repo.claim("owner", input.quoteId, input.idempotencyKey, bsc, trx);
  const app = express(); app.use(express.json());
  app.use(createExchangePreparationRouter({
    user: async id => ({ id }), token: async token => token, kyc: async () => ({ kycStatus: "verified" }),
    rate: async () => null, configured: () => true, estimate: async () => ({ toAmount: 24, minimum: 10 }), repository: repo,
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const headers = { Authorization: "Bearer other-user", "Content-Type": "application/json" };
    assert.equal((await fetch(`${base}/orders/${order().id}`, { headers })).status, 404);
    for (const path of ["/orders", "/execute"]) assert.equal((await fetch(base + path, {
      method: "POST", headers, body: JSON.stringify({ ...input, executionEnabled: true, providerId: "spoof" }),
    })).status, 423);
    assert.equal((await fetch(base + "/webhook", { method: "POST", headers, body: '{"status":"finished"}' })).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("new copy has every key in all four supported languages", () => {
  const keys = Object.keys(integrationCopy.en).sort();
  for (const locale of Object.values(integrationCopy)) {
    assert.deepEqual(Object.keys(locale).sort(), keys);
    assert.ok(Object.values(locale).every(v => typeof v === "string" && v.length > 0));
  }
});