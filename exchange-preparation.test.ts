import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createExchangePreparationRouter } from "../server/exchangePreparationRoutes";
import { exchangeCopy } from "../client/src/pages/exchange-copy";
import { integrationCopy } from "../client/src/pages/exchange-integration-copy";
import { liveCopy } from "../client/src/pages/exchange-live-copy";
import { previewExchange } from "../server/services/changeNowService";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("production UI displays bound addresses, consent, fees and customer deposit instructions in four locales", () => {
  const compiled = transformSync(readFileSync("client/src/pages/exchange.tsx", "utf8"), {
    loader: "tsx", format: "cjs", jsx: "automatic",
  }).code;
  const require = createRequire(import.meta.url);
  for (const lang of ["ht", "en", "fr", "es"] as const) {
    let index = 0;
    const quote = { id: "quote", executionEnabled: true, from: "usdt-trx", to: "usdt-bsc", amount: "25",
      address: "destination-test", refundAddress: "refund-test", expiresAt: new Date(Date.now() + 30000).toISOString(),
      toAmount: "24", minimum: "10", depositFee: "0.000001", withdrawalFee: "0.1" };
    const state = ["usdt-trx", "usdt-bsc", "25", quote, "", false, "", "", false, false, Date.now()];
    const module = { exports: {} as any };
    const mockRequire = (name: string): any => {
      if (name === "react") return { ...React, useEffect: () => {}, useRef: () => ({ current: false }), useState: () => [state[index++], () => {}] };
      if (name === "react-i18next") return { useTranslation: () => ({ i18n: { language: lang } }) };
      if (name === "@tanstack/react-query") return { useQuery: ({ queryKey }: any) => ({ data: queryKey[0].endsWith("orders")
        ? { orders: [{ id: "order", status: "awaiting_deposit", data: { from: "usdt-trx", to: "usdt-bsc", amount: "25",
          payinAddress: "mock-deposit-address", payinExtraId: "mock-memo" } }] }
        : { executionEnabled: true, kycVerified: true, cryptoEstimatesConfigured: true } }) };
      if (name === "wouter") return { Link: (props: any) => React.createElement("a", props) };
      if (name === "@/lib/queryClient") return { apiRequest: () => { throw new Error("NO_NETWORK"); } };
      if (name === "./exchange-copy") return { exchangeCopy };
      if (name.startsWith("@assets/")) return "/test-icon.png";
      if (name === "./exchange-integration-copy") return { integrationCopy };
      if (name === "./exchange-live-copy") return { liveCopy };
      if (name === "./manual-exchange") return { __esModule: true, default: () => null, manualCopy: { en: { mode: "Manual" } } };
      return require(name);
    };
    new Function("require", "module", "exports", compiled)(mockRequire, module, module.exports);
    const html = renderToStaticMarkup(React.createElement(module.exports.default));
    for (const key of ["confirm", "create", "deposit", "network", "memo", "fee"] as const)
      assert.ok(html.includes(liveCopy[lang][key]), `${lang}: ${key}`);
    for (const value of ["destination-test", "refund-test", "mock-deposit-address", "mock-memo", "TRC20", "0.000001"])
      assert.ok(html.includes(value));
    assert.match(html, /type="checkbox"/);
    assert.ok(!html.includes(exchangeCopy[lang].EXECUTION_LOCKED));
  }
});

test("authenticated preparation API fails closed and only quotes validated crypto", async () => {
  let calls = 0;
  let verified = true;
  const app = express();
  app.use(express.json());
  app.use("/api/exchange", createExchangePreparationRouter({
    user: async id => ({ id, isBlocked: id === "blocked", isActive: true }),
    token: async token => token,
    kyc: async () => ({ kycStatus: verified ? "verified" : "pending_review" }),
    rate: async () => null,
    configured: () => true,
    estimate: async (from, to, amount) => {
      calls++;
      assert.equal(from, "trx"); assert.equal(to, "bsc"); assert.equal(amount, 25);
      return { toAmount: 24, minimum: 10 };
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const request = async (path: string, body?: any, token = "user") => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/exchange/${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal((await request("readiness", undefined, "")).status, 401);
    assert.equal((await request("readiness", undefined, "blocked")).status, 403);
    const ready = (await request("readiness")).body;
    assert.equal(ready.executionEnabled, false); assert.equal(ready.htgReference, null);
    const valid = { from: "usdt-trx", to: "usdt-bsc", amount: "25" };
    for (const body of [
      { ...valid, amount: -3 }, { ...valid, amount: "NaN" }, { ...valid, amount: "1e3" },
      { ...valid, amount: "0" }, { ...valid, network: "eth" }, { ...valid, amount: "1.1234567" },
      { ...valid, to: "usdt-eth" },
    ]) assert.equal((await request("quote", body)).status, 400);
    assert.equal((await request("quote", { ...valid, to: "natcash" })).body.code, "NATCASH_COMING_SOON");
    assert.equal((await request("quote", { ...valid, from: "natcash" })).body.code, "NATCASH_COMING_SOON");
    assert.equal((await request("quote", { ...valid, to: "moncash" })).body.code, "MONCASH_COMING_SOON");
    assert.equal((await request("quote", { ...valid, from: "moncash" })).body.code, "MONCASH_COMING_SOON");
    assert.equal((await request("quote", { ...valid, to: valid.from })).body.code, "SAME_ASSET");
    verified = false;
    assert.equal((await request("quote", { ...valid, to: "moncash" })).body.code, "MONCASH_COMING_SOON");
    assert.equal((await request("quote", { ...valid, from: "moncash" })).body.code, "MONCASH_COMING_SOON");
    assert.equal((await request("quote", valid)).body.code, "KYC_REQUIRED");
    assert.equal((await request("execute", { ...valid, force: true, production: true })).status, 423);
    verified = true;
    const quote = (await request("quote", valid)).body;
    assert.equal(quote.toAmount, 24); assert.equal(quote.executionEnabled, false);
    assert.equal(quote.platformFee, null);
    assert.ok(Date.parse(quote.expiresAt) > Date.now());
    assert.equal(calls, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("ChangeNOW preparation uses GET only, validates catalog and minimum", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (url: any, options: any) => {
    assert.ok(!options.method || options.method === "GET");
    paths.push(String(url));
    const body = String(url).includes("/currencies")
      ? [{ ticker: "usdt", network: "trx", sell: true, buy: true }, { ticker: "usdt", network: "bsc", sell: true, buy: true }]
      : String(url).includes("min-amount") ? { minAmount: 10 } : { toAmount: 24 };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(previewExchange("eth", "bsc", 25), /PAIR_UNAVAILABLE/);
    await assert.rejects(previewExchange("trx", "bsc", 1), /BELOW_MINIMUM/);
    assert.equal((await previewExchange("trx", "bsc", 25)).toAmount, 24);
    assert.equal((await previewExchange("bsc", "trx", 25)).toAmount, 24);
    assert.ok(paths.some(p => p.includes("fromNetwork=bsc")));
  } finally { globalThis.fetch = original; }
});

test("mocked UI renders all four locales, disables MonCash and Natcash in both selectors, and explains API availability", () => {
  const compiled = transformSync(readFileSync("client/src/pages/exchange.tsx", "utf8"), {
    loader: "tsx", format: "cjs", jsx: "automatic",
  }).code;
  const require = createRequire(import.meta.url);
  for (const lang of ["ht", "en", "fr", "es"] as const) {
    assert.deepEqual(Object.keys(exchangeCopy[lang]).sort(), Object.keys(exchangeCopy.en).sort());
    let index = 0;
    const state = ["usdt-trx", "usdt-bsc", "25", { expiresAt: "2000-01-01", toAmount: 24 }, "HTG_PRICING", false, "", "", false, false, Date.now()];
    const module = { exports: {} as any };
    const mockRequire = (name: string) => {
      if (name === "react") return { ...React, useEffect: () => {}, useRef: () => ({ current: 0 }), useState: () => [state[index++], () => {}] };
      if (name === "react-i18next") return { useTranslation: () => ({ i18n: { language: lang } }) };
      if (name === "@tanstack/react-query") return { useQuery: () => ({ data: { kycVerified: true, cryptoEstimatesConfigured: false, htgReference: null } }) };
      if (name === "wouter") return { Link: (props: any) => React.createElement("a", props) };
      if (name === "@/lib/queryClient") return { apiRequest: () => { throw new Error("No live requests in UI tests"); } };
      if (name === "./exchange-copy") return { exchangeCopy };
      if (name.startsWith("@assets/")) return "/test-icon.png";
      if (name === "./exchange-live-copy") return require("../client/src/pages/exchange-live-copy");
      if (name === "./exchange-integration-copy") return { integrationCopy };
      if (name === "./manual-exchange") return { __esModule: true, default: () => null, manualCopy: { en: { mode: "Manual" } } };
      return require(name);
    };
    new Function("require", "module", "exports", compiled)(mockRequire, module, module.exports);
    const html = renderToStaticMarkup(React.createElement(module.exports.default));
    for (const key of ["title", "EXECUTION_LOCKED", "expired", "HTG_PRICING"] as const)
      assert.ok(html.includes(exchangeCopy[lang][key]), `${lang}: ${key}`);
    assert.equal((html.match(/value="natcash" disabled=""/g) || []).length, 2);
    assert.equal((html.match(/value="moncash" disabled=""/g) || []).length, 2);
    assert.ok(html.includes(exchangeCopy[lang].NATCASH_UNAVAILABLE));
    assert.ok(html.includes(exchangeCopy[lang].MONCASH_COMING_SOON));
    assert.equal((html.match(/<select /g) || []).length, 2);
    assert.ok(!html.includes("/api/exchange/execute"));
    assert.ok(html.includes(integrationCopy[lang].safety));
    assert.ok(html.includes(integrationCopy[lang].history));
  }
});