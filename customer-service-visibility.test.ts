import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HIDDEN_CUSTOMER_SERVICE_ROUTES, isCustomerServiceVisible } from "../client/src/lib/customerServiceVisibility";
import { isUnavailableSEOPath, getWelcomeSEOContent } from "../client/src/utils/seoTranslations";

test("gift purchase/catalog routes are hidden, with neutral SEO but preserved records", () => {
  for (const path of ["/gift-cards", "/gift-card-brands", "/gift-card-categories"]) {
    assert.equal(isCustomerServiceVisible(`${path}/?brand=Amazon#buy`), false);
    assert.equal(isUnavailableSEOPath(path), true);
  }
  for (const path of ["/gift-card-delivery", "/history", "/admin/transactions-simple", "/api/giftcards/history"]) {
    assert.equal(isCustomerServiceVisible(path), true);
    assert.equal(isUnavailableSEOPath(path), false);
  }
  for (const language of ["en", "fr", "ht", "es"]) {
    assert.doesNotMatch(JSON.stringify(getWelcomeSEOContent(language)), /gift cards|cartes cadeaux|kat kado|tarjetas de regalo/i);
  }
  assert.doesNotMatch(readFileSync("client/index.html", "utf8"), /gift.cards/i);
});

test("hidden service aliases stay hidden, including query strings and trailing slashes", () => {
  for (const path of HIDDEN_CUSTOMER_SERVICE_ROUTES) {
    assert.equal(isCustomerServiceVisible(path), false);
    assert.equal(isCustomerServiceVisible(`${path}/?amount=25`), false);
  }
});

test("history, administration, fulfillment, funding and unrelated services remain available", () => {
  for (const path of ["/history", "/transactions", "/admin/moncash-transfers",
    "/admin/natcash-transfers", "/admin/deposit-center", "/agent-portal",
    "/central-agent", "/payment-success", "/add-funds", "/wallet", "/topup",
    "/gift-card-delivery", "/admin/gift-cards", "/bill-payment", "/exchange/natcash-moncash"]) {
    assert.equal(isCustomerServiceVisible(path), true, path);
  }
});

test("discovery surfaces use the shared policy, not payment visibility flags", () => {
  for (const path of ["pages/dashboard.tsx", "pages/services.tsx", "pages/send-money-haiti.tsx",
    "components/DailyPromoPopup.tsx"]) {
    assert.match(readFileSync(`client/src/${path}`, "utf8"), /isCustomerServiceVisible/);
  }
  for (const path of ["pages/welcome.tsx", "components/Footer.tsx", "components/SupportedOperators.tsx"]) {
    const source = readFileSync(`client/src/${path}`, "utf8");
    for (const route of ["/moncash-transfer", "/natcash-transfer", "/cash-pick", "/gift-cards"]) {
      assert.ok(source.includes(`<CustomerServiceEntry route="${route}">`), `${path}: ${route}`);
    }
  }
});

test("new-order routes are guarded while transfer history is retained", () => {
  const app = readFileSync("client/src/App.tsx", "utf8");
  for (const route of ["/moncash-transfer", "/natcash-transfer", "/cash-pick"]) {
    assert.ok(app.includes(`if (!isCustomerServiceVisible("${route}")) return <CustomerServiceUnavailable />;`));
  }
  assert.match(app, /HIDDEN_CUSTOMER_SERVICE_ROUTES\.filter/);
  const deposit = readFileSync("client/src/pages/deposit-center.tsx", "utf8");
  assert.match(deposit, /tab === "new" && !isCustomerServiceVisible\("\/deposit-center"\)/);
  assert.match(deposit, /<HistoryTab history=\{history\}/);
  assert.match(deposit, /get\("tab"\) === "history"/);
});