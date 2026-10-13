import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ExchangeChangeNow, units } from "../server/services/exchangeProviders";
import { ExchangeLifecycle, PostgresSwapRepository, type SwapOrder, type SwapQuote, type SwapRepository } from "../server/services/exchangeLifecycle";
import { createExchangePreparationRouter, productionExchangeEnabled } from "../server/exchangePreparationRoutes";
import { liveCopy } from "../client/src/pages/exchange-live-copy";

// Only injected transports; no actual provider, credentials, DB or funds.
const trx = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const bsc = "0x" + "b".repeat(40);
const pair = { fromCurrency: "usdt", toCurrency: "usdt", fromNetwork: "trx", toNetwork: "bsc", flow: "standard" };
const response = (body: any) => new Response(JSON.stringify(body), { status: 200 });

test("production-only execution requires all explicit gates", () => {
  const names = ["NODE_ENV", "REPLIT_DEPLOYMENT", "EXCHANGE_CUSTOMER_SWAPS_ENABLED", "CHANGENOW_API_KEY"] as const;
  const saved = names.map(k => process.env[k]);
  try {
    process.env.CHANGENOW_API_KEY = "mock-only";
    process.env.EXCHANGE_CUSTOMER_SWAPS_ENABLED = "true";
    process.env.REPLIT_DEPLOYMENT = "1";
    process.env.NODE_ENV = "development";
    assert.equal(productionExchangeEnabled(), false);
    process.env.NODE_ENV = "production";
    assert.equal(productionExchangeEnabled(), true);
    for (const name of names.slice(1)) {
      const value = process.env[name]; delete process.env[name];
      assert.equal(productionExchangeEnabled(), false); process.env[name] = value;
    }
  } finally { names.forEach((key, i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i]); }
});

test("provider quote preserves precise decimal output and authoritative fees, rejects mismatches and minimum", async () => {
  let wrongPair = false;
  let creates = 0;
  const api = new ExchangeChangeNow(() => "mock", () => true, (async (url: any, init: any) => {
    if (init.method === "POST") { creates++; throw new Error("NO_MUTATIONS_IN_QUOTE"); }
    if (String(url).includes("/currencies")) return response(["trx", "bsc"].map(network =>
      ({ ticker: "usdt", network, buy: true, sell: true, isFiat: false })));
    if (String(url).includes("/range")) return response({ ...pair, minAmount: "10", maxAmount: "100" });
    return new Response(`{"fromCurrency":"usdt","toCurrency":"usdt","fromNetwork":"trx","toNetwork":"${wrongPair ? "eth" : "bsc"}","flow":"standard","type":"direct","fromAmount":25.000001,"toAmount":2.4123456789123456789e1,"depositFee":1e-7,"withdrawalFee":0.1}`);
  }) as typeof fetch);
  const quote = await api.quote("trx", "bsc", "25.000001");
  assert.equal(quote.toAmount, "24.123456789123456789");
  assert.equal(quote.depositFee, "0.0000001");
  assert.equal(units(quote.toAmount, 18).toString(), "24123456789123456789");
  await assert.rejects(api.quote("trx", "bsc", "9"), /BELOW_MINIMUM/);
  await assert.rejects(api.quote("trx", "bsc", "101"), /INVALID_INPUT/);
  wrongPair = true;
  await assert.rejects(api.quote("trx", "bsc", "25.000001"), /PROVIDER_UNAVAILABLE/);
  assert.equal(creates, 0);
});

test("mocked customer HTTP path binds quote, authorizes create, persists deposit, polls to completion, never recreates", async () => {
  let quote: SwapQuote | undefined;
  let order: SwapOrder | null = null;
  let creates = 0, kyc = "verified", blocked = false, status = "waiting";
  const repo: SwapRepository = {
    saveQuote: async (_user, value) => { quote = value; },
    claim: async (userId, quoteId, key, address, refundAddress) => {
      if (order) return { order, claimed: false };
      assert.equal(quoteId, quote?.id); assert.equal(address, quote?.address); assert.equal(refundAddress, quote?.refundAddress);
      order = { id: "53aee34e-ad8f-4b04-8332-d70cc6d844c2", userId, quoteId, idempotencyKey: key,
        purpose: "user_funded_swap", status: "submitting", version: 0, createdAt: new Date().toISOString(),
        data: { from: "usdt-trx", to: "usdt-bsc", amount: "25", address, refundAddress } };
      return { order, claimed: true };
    },
    update: async (previous, next, _reason, patch) => {
      assert.equal(previous.version, order?.version);
      order = { ...previous, ...patch, status: next, version: previous.version + 1 };
      return order;
    },
    get: async (user, id) => order?.userId === user && order.id === id ? order : null,
    list: async user => order?.userId === user ? [order] : [],
  };
  const provider = new ExchangeChangeNow(() => "mock", () => true, (async (_url: any, init: any) => {
    if (init.method === "POST") {
      creates++;
      const payload = JSON.parse(init.body);
      assert.equal(payload.refundAddress, trx); assert.equal(payload.address, bsc);
      return response({ ...pair, id: "mock-provider", payinAddress: trx, payoutAddress: bsc, refundAddress: trx, fromAmount: "25" });
    }
    return response({ ...pair, id: "mock-provider", status, expectedAmountFrom: "25",
      amountFrom: status === "waiting" ? null : "25", amountTo: status === "finished" ? "24" : null,
      payinAddress: trx, payoutAddress: bsc, refundAddress: trx, payinHash: "mock-deposit", payoutHash: "mock-payout" });
  }) as typeof fetch);
  const lifecycle = new ExchangeLifecycle(repo, provider, () => true);
  const app = express(); app.use(express.json());
  app.use(createExchangePreparationRouter({
    user: async id => ({ id, isBlocked: blocked }), token: async token => token,
    kyc: async () => ({ kycStatus: kyc }), rate: async () => null, configured: () => true,
    estimate: async () => ({ toAmount: 24, minimum: 10 }),
    executableEstimate: async () => ({ toAmount: "24", minimum: "10", maximum: null, depositFee: "0.1", withdrawalFee: "0.1" }),
    enabled: () => true, repository: repo, lifecycle,
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = (path: string, body?: any, user = "owner") => fetch(base + path, {
    method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${user}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const payload = { from: "usdt-trx", to: "usdt-bsc", amount: "25", address: bsc, refundAddress: trx };
    kyc = "pending"; assert.equal((await call("/quote", payload)).status, 403); kyc = "verified";
    blocked = true; assert.equal((await call("/quote", payload)).status, 403); blocked = false;
    assert.equal((await call("/quote", { ...payload, address: trx })).status, 400);
    assert.equal((await call("/quote", { ...payload, amount: "2e1" })).status, 400);
    const quoted = await (await call("/quote", payload)).json();
    assert.equal(quoted.indicative, false); assert.equal(quoted.amount, "25");
    const submission = { quoteId: quoted.id, idempotencyKey: quoted.id, address: bsc, refundAddress: trx, confirmed: true };
    assert.equal((await call("/orders", { ...submission, confirmed: false })).status, 400);
    assert.equal((await call("/orders", { ...submission, providerId: "injected" })).status, 400);
    const created = await (await call("/orders", submission)).json();
    assert.equal(created.status, "awaiting_deposit"); assert.equal(created.data.payinAddress, trx);
    assert.equal((await (await call("/orders")).json()).orders.length, 1);
    assert.equal((await call(`/orders/${created.id}`, undefined, "other")).status, 404);
    assert.equal((await (await call(`/orders/${created.id}/reconcile`, {})).json()).status, "awaiting_deposit");
    status = "verifying";
    assert.equal((await (await call(`/orders/${created.id}/reconcile`, {})).json()).status, "processing");
    status = "finished";
    const completed = await (await call(`/orders/${created.id}/reconcile`, {})).json();
    assert.equal(completed.status, "completed");
    assert.equal(completed.data.receivedAmount, "24");
    assert.equal(completed.data.payinHash, "mock-deposit");
    assert.equal(completed.data.payoutHash, "mock-payout");
    await call("/orders", submission);
    assert.equal(creates, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("provider range requires explicit maximum, permits null, and fails closed on inconsistent limits", async () => {
  let range: any = { ...pair, minAmount: "10", maxAmount: null };
  const api = new ExchangeChangeNow(() => "mock", () => false, (async (url: any) => {
    if (String(url).includes("/currencies")) return response(["trx", "bsc"].map(network =>
      ({ ticker: "usdt", network, buy: true, sell: true, isFiat: false })));
    if (String(url).includes("/range")) return response(range);
    return response({ ...pair, type: "direct", fromAmount: "25", toAmount: "24", depositFee: "0", withdrawalFee: "1" });
  }) as typeof fetch);
  assert.equal((await api.quote("trx", "bsc", "25")).maximum, null);
  for (const bad of [
    { ...pair, minAmount: "10" },
    { ...pair, minAmount: "10", maxAmount: "9" },
    { ...pair, minAmount: "0", maxAmount: null },
    { ...pair, minAmount: "10", maxAmount: null, toNetwork: "eth" },
  ]) {
    range = bad;
    await assert.rejects(api.quote("trx", "bsc", "25"), /PROVIDER_UNAVAILABLE/);
  }
});

test("SQL claim rejects expired, altered address and consumed quotes before provider mutation", async () => {
  const validQuote = { id: "quote", from: "usdt-trx", to: "usdt-bsc", amount: "25", toAmount: "24",
    expiresAt: new Date(Date.now() + 30000).toISOString(), indicative: false, address: bsc, refundAddress: trx };
  for (const mode of ["expired", "address", "consumed", "active"] as const) {
    const queries: string[] = [];
    const client = { release() {}, query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("idempotency_key")) return { rows: [] };
      if (sql.includes("status NOT IN")) return { rows: mode === "active" ? [{ id: "existing" }] : [] };
      if (sql.includes("exchange_quotes")) return { rows: [{ data: validQuote,
        expires_at: mode === "expired" ? new Date(0) : new Date(Date.now() + 30000) }] };
      if (sql.includes("WHERE quote_id")) return { rows: mode === "consumed" ? [{ id: "existing" }] : [] };
      if (sql.startsWith("INSERT")) throw new Error("UNSAFE_INSERT");
      return { rows: [] };
    } };
    const repo = new PostgresSwapRepository({ connect: async () => client, query: client.query });
    await assert.rejects(repo.claim("owner", "quote", "idempotent-key", mode === "address" ? "0x" + "c".repeat(40) : bsc, trx),
      /QUOTE_EXPIRED|INVALID_INPUT|IDEMPOTENCY_CONFLICT/);
    assert.ok(queries.includes("ROLLBACK")); assert.ok(!queries.some(q => q.startsWith("INSERT")));
  }
});

test("customer live notices and deposit copy cover all four locales", () => {
  for (const locale of Object.values(liveCopy)) {
    assert.deepEqual(Object.keys(locale).sort(), Object.keys(liveCopy.en).sort());
    assert.ok(Object.values(locale).every(v => v.length > 0));
  }
});