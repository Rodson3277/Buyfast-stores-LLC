import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { adminExchangeRouter, manualAction, manualCreate, checkManualAction } from "../server/adminExchangeRoutes";
import { adminExchangeCopy } from "../client/src/pages/admin/exchange-copy";
import { manualRequestInput, manualRequestRouter } from "../server/manualExchangeRequests";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { integrationCopy } from "../client/src/pages/exchange-integration-copy";

test("manual tracking validates evidence, transitions and stale versions; never settles automatic orders", () => {
  const base = { version: 2, note: "Independent review" };
  const manual = { version: 2, purpose: "manual_tracking", status: "processing", data: { from: "natcash", to: "moncash" } };
  assert.throws(() => checkManualAction(manual, { ...base, action: "completed" }), /EVIDENCE_REQUIRED/);
  checkManualAction(manual, { ...base, action: "completed", acknowledged: true, paymentReference: "pay123", deliveryReference: "tx123" });
  assert.throws(() => checkManualAction(manual, { ...base, version: 1, action: "failed" }), /ORDER_CHANGED/);
  for (const action of ["completed", "cancelled", "failed", "processing"] as const)
    assert.throws(() => checkManualAction({ ...manual, purpose: "user_funded_swap", status: "review_required" }, { ...base, action }), /ACTION_BLOCKED/);
  checkManualAction({ ...manual, purpose: "user_funded_swap" }, { ...base, action: "review_required" });
  assert.throws(() => checkManualAction({ ...manual, status: "completed" }, { ...base, action: "cancelled" }), /ACTION_BLOCKED/);
  checkManualAction({ ...manual, status: "completed" }, { ...base, action: "note" });
  assert.equal(manualAction.safeParse({ ...base, action: "refunded" }).success, false);
  assert.equal(manualAction.safeParse({ ...base, action: "note", actor: "spoof" }).success, false);
  assert.equal(manualCreate.safeParse({ userId: "u", from: "natcash", to: "moncash", amount: "1", toAmount: "2", note: "test", idempotencyKey: crypto.randomUUID() }).success, true);
});
test("new MonCash and Natcash user/admin requests fail in both directions before KYC, user lookup or persistence", async () => {
  let sideEffects = 0;
  const unavailablePool = {
    query: async () => { sideEffects++; return { rows: [] }; },
    connect: async () => { sideEffects++; throw new Error("must not connect"); },
  };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { id: "owner" }; next(); });
  app.use("/requests", manualRequestRouter(unavailablePool, async () => { sideEffects++; return { kycStatus: "verified" }; }));
  app.use("/admin", adminExchangeRouter((req: any, _res, next) => { req.adminUser = { id: "admin" }; next(); },
    unavailablePool, async () => { sideEffects++; return {}; }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = async (path: string, body: any) => {
    const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    for (const pair of [{ from: "natcash", to: "usdt-trx" }, { from: "usdt-bsc", to: "natcash" }]) {
      const user = await post("/requests", { ...pair, amount: "100", destination: "+50912345678", idempotencyKey: crypto.randomUUID() });
      assert.equal(user.status, 409); assert.equal(user.body.code, "NATCASH_COMING_SOON");
      const admin = await post("/admin", { userId: "u", ...pair, amount: "100", toAmount: "95", note: "manual exchange", idempotencyKey: crypto.randomUUID() });
      assert.equal(admin.status, 409); assert.equal(admin.body.code, "NATCASH_COMING_SOON");
    }
    for (const pair of [{ from: "moncash", to: "usdt-trx" }, { from: "usdt-bsc", to: "moncash" }]) {
      const user = await post("/requests", { ...pair, amount: "100", destination: "+50912345678", idempotencyKey: crypto.randomUUID() });
      assert.equal(user.status, 409); assert.equal(user.body.code, "MONCASH_COMING_SOON");
      const admin = await post("/admin", { userId: "u", ...pair, amount: "100", toAmount: "95", note: "manual exchange", idempotencyKey: crypto.randomUUID() });
      assert.equal(admin.status, 409); assert.equal(admin.body.code, "MONCASH_COMING_SOON");
    }
    assert.equal(sideEffects, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
test("admin router denies all unauthenticated/nonadmin paths before database access", async () => {
  const app = express(); app.use(express.json());
  let calls = 0;
  app.use("/admin", adminExchangeRouter((req, res, next) => {
    if (!req.headers.authorization) { res.status(401).end(); return; }
    if (req.headers.authorization !== "admin") { res.status(403).end(); return; }
    (req as any).adminUser = { id: "admin-1" }; next();
  }, { query: async () => { calls++; return { rows: [] }; } }, async () => null));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/admin`;
  try {
    for (const method of ["GET", "POST", "PATCH"]) {
      const url = method === "PATCH" ? `${base}/${crypto.randomUUID()}` : base;
      assert.equal((await fetch(url, { method })).status, 401);
      assert.equal((await fetch(url, { method, headers: { authorization: "user" } })).status, 403);
    }
    assert.equal(calls, 0);
    assert.equal((await fetch(base, { headers: { authorization: "admin" } })).status, 200);
    assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
test("admin tracking labels cover all four languages", () => {
  for (const locale of ["ht", "en", "fr", "es"] as const)
    for (const key of Object.keys(adminExchangeCopy.en))
      assert.ok((adminExchangeCopy[locale] as any)[key], `${locale}.${key}`);
});
test("user request cannot inject owner, provider status or amounts; final proposal approval gates completion", () => {
  const valid = { from: "moncash", to: "natcash", amount: "100", destination: "+50912345678", idempotencyKey: crypto.randomUUID() };
  assert.equal(manualRequestInput.safeParse(valid).success, true);
  for (const extra of [{ userId: "victim" }, { status: "completed" }, { toAmount: "500" }, { providerId: "fake" }])
    assert.equal(manualRequestInput.safeParse({ ...valid, ...extra }).success, false);
  assert.equal(manualRequestInput.safeParse({ ...valid, from: "usdt-trx", to: "usdt-bsc" }).success, false);
  assert.equal(manualRequestInput.safeParse({ ...valid, to: "usdt-bsc", destination: "wrong-network" }).success, false);
  const order = { version: 0, purpose: "manual_tracking", status: "review_required", data: { userRequested: true } };
  const complete = { version: 0, action: "completed" as const, note: "verified", paymentReference: "pay123", deliveryReference: "tx123", acknowledged: true };
  assert.throws(() => checkManualAction(order, complete), /ACTION_BLOCKED/);
  checkManualAction({ ...order, data: { userRequested: true, approvedProposal: { toAmount: "95", fees: "5 HTG" } } }, complete);
});
test("owner-scoped version guard permits one proposal approval and rejects wrong user / concurrent replay", async () => {
  let version = 0, status = "review_required", events = 0;
  const id = crypto.randomUUID();
  const client = { release() {}, query: async (sql: string, values: any[] = []) => {
    if (sql.startsWith("UPDATE exchange_orders")) {
      assert.match(sql, /user_id=\$2/); assert.match(sql, /version=\$3/); assert.match(sql, /purpose='manual_tracking'/);
      if (values[0] !== id || values[1] !== "owner" || values[2] !== version || status !== "review_required") return { rows: [] };
      version++; status = "processing"; return { rows: [{ id }] };
    }
    if (sql.startsWith("INSERT INTO exchange_order_events")) events++;
    return { rows: [] };
  } };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { id: req.headers.authorization }; next(); });
  app.use("/requests", manualRequestRouter({ connect: async () => client }, async () => ({ kycStatus: "verified" })));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/requests/${id}/approve`;
  const call = (owner: string) => fetch(url, { method: "POST", headers: { authorization: owner, "content-type": "application/json" }, body: JSON.stringify({ version: 0, acknowledged: true }) });
  try {
    assert.equal((await call("other")).status, 409);
    const responses = await Promise.all([call("owner"), call("owner")]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    assert.equal(events, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
test("admin and user manual UI render localized requests, proposals and destination in four languages", () => {
  const require = createRequire(import.meta.url);
  for (const lang of ["ht", "en", "fr", "es"] as const) {
    const compiled = transformSync(readFileSync("client/src/pages/manual-exchange.tsx", "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
    const module = { exports: {} as any };
    const mock = (name: string): any => {
      if (name === "react") return { ...React, useState: (initial: any) => [typeof initial === "function" ? initial() : initial, () => {}] };
      if (name === "@/lib/queryClient") return { apiRequest: () => { throw new Error("No live calls"); } };
      if (name === "@tanstack/react-query") return { useQuery: () => ({ data: { orders: [{ id: "manual-id", status: "review_required", version: 1, data: { from: "usdt-trx", to: "moncash", amount: "25", destination: "+50912345678", proposal: { toAmount: "3000", fees: "100 HTG" } } }] } }) };
      if (name === "./admin/exchange-copy") return { adminExchangeCopy };
      return require(name);
    };
    new Function("require", "module", "exports", compiled)(mock, module, module.exports);
    const html = renderToStaticMarkup(React.createElement(module.exports.default, { lang, from: "usdt-trx", to: "moncash", amount: "25", eligible: true }));
    const copy = module.exports.manualCopy[lang];
    assert.ok(html.includes(copy.approve)); assert.ok(html.includes(copy.request));
    assert.ok(html.includes("+50912345678")); assert.ok(html.includes("3000")); assert.ok(html.includes("100 HTG"));
    assert.ok(html.includes(copy.request));
    const adminCompiled = transformSync(readFileSync("client/src/pages/admin/exchange-orders.tsx", "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
    const admin = { exports: {} as any };
    const adminMock = (name: string): any => {
      if (name === "react-i18next") return { useTranslation: () => ({ i18n: { language: lang } }) };
      if (name === "@/components/AdminLayout") return { __esModule: true, default: ({ children }: any) => children };
      if (name === "./exchange-copy") return { adminExchangeCopy };
      if (name === "../exchange-integration-copy") return { integrationCopy };
      if (name === "../manual-exchange") return module.exports;
      return mock(name);
    };
    new Function("require", "module", "exports", adminCompiled)(adminMock, admin, admin.exports);
    const adminHtml = renderToStaticMarkup(React.createElement(admin.exports.default));
    assert.ok(adminHtml.includes(adminExchangeCopy[lang].title));
    assert.ok(adminHtml.includes(adminExchangeCopy[lang].create));
    assert.ok(adminHtml.includes("manual-id"));
    assert.ok((adminExchangeCopy[lang] as any).natcashUnavailable);
  }
  const adminSource = readFileSync("client/src/pages/admin/exchange-orders.tsx", "utf8");
  assert.match(adminSource, /option value="natcash" disabled/);
  assert.match(adminSource, /option value="moncash" disabled/);
});