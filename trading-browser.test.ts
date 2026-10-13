import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium, type Route } from "@playwright/test";
import type { TradingMarket, TradingOrder, TradingState } from "../shared/trading";
import { tradingCopy, productionTradingCopy } from "../client/src/pages/trading-copy";

// Uses the already-running preview. All trading requests are intercepted; no
// brokerage, exchange, wallet, deposit, or real customer funds are involved.
test("internal trading demo: initialize, retry idempotently, trade, cancel, locales and mobile", { timeout: 120_000 }, async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const user = { id: "synthetic-internal-demo-browser", email: "demo-fixture@example.invalid", firstName: "Demo", isActive: true, isBlocked: false, isAdmin: false, emailVerified: true, kycStatus: "verified" };
    await context.addInitScript(userFixture => {
      localStorage.setItem("buyfast_session_user", JSON.stringify({ data: userFixture }));
      localStorage.setItem("i18nextLng", "en");
      localStorage.setItem("promo_last_shown", String(Date.now()));
      localStorage.setItem("buyfast_notif_banner_dismissed", JSON.stringify({ ts: Date.now() }));
    }, user);

    let state: TradingState = {
      initialized: true,
      main: "0.000000",
      balances: {
        USDT: { available: "10000.000000", reserved: "0.000000" },
        BTC: { available: "0.000000", reserved: "0.000000" },
        ETH: { available: "0.000000", reserved: "0.000000" },
      },
      orders: [],
    };
    let abortFirstOrder = true;
    let orderNumber = 0;
    const actionAttempts: Record<string, unknown>[] = [];
    const completed = new Map<string, TradingState>();
    const json = (route: Route, data: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });

    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/auth/session-user") return json(route, user);
      if (url.pathname === "/api/auth/blocked-status") return json(route, { isBlocked: false });
      if (url.pathname === "/api/onboarding") return json(route, { required: false, completed: true });
      if (url.pathname.includes("kyc")) return json(route, { kycStatus: "verified", documentVerified: true });
      if (url.pathname.includes("notifications") || url.pathname.includes("promotions")) return json(route, []);
      if (url.pathname === "/api/trading/sandbox/state") return json(route, state);
      if (url.pathname === "/api/trading/sandbox/market") {
        const symbol = url.searchParams.get("symbol");
        const market: TradingMarket = {
          symbol: symbol === "ETHUSDT" ? "ETHUSDT" : "BTCUSDT",
          price: symbol === "ETHUSDT" ? "2500.00" : "50000.00",
          source: "BuyFast synthetic simulator",
          updatedAt: new Date().toISOString(),
          candles: Array.from({ length: 30 }, (_, i) => ({ time: 1800000000 + i * 900, open: 49900, high: 50100, low: 49800, close: 50000 })),
        };
        return json(route, market);
      }
      if (url.pathname === "/api/trading/sandbox/action" && route.request().method() === "POST") {
        const input = route.request().postDataJSON() as Record<string, unknown>;
        actionAttempts.push(input);
        const idempotencyKey = route.request().headers()["idempotency-key"];
        assert.equal(typeof idempotencyKey, "string");
        if (input.action === "order" && abortFirstOrder) {
          abortFirstOrder = false;
          return route.abort("connectionreset");
        }
        const prior = completed.get(idempotencyKey);
        if (prior) return json(route, prior);
        if (input.action === "faucet") {
          state = { ...state, initialized: true, main: "10000.000000" };
        } else if (input.action === "transfer") {
          assert.equal(input.direction, "toTrading");
          const amount = Number(input.amount);
          state = {
            ...state,
            main: (Number(state.main) - amount).toFixed(6),
            balances: { ...state.balances, USDT: { ...state.balances.USDT, available: (Number(state.balances.USDT.available) + amount).toFixed(6) } },
          };
        } else if (input.action === "order") {
          const order: TradingOrder = {
            id: `demo-${++orderNumber}`,
            symbol: input.symbol === "ETHUSDT" ? "ETHUSDT" : "BTCUSDT",
            side: input.side === "sell" ? "sell" : "buy",
            type: input.type === "limit" ? "limit" : "market",
            quantity: String(input.quantity),
            limitPrice: input.type === "limit" ? String(input.limitPrice) : null,
            status: input.type === "limit" ? "open" : "filled",
            reserved: input.type === "limit" ? "40.040000" : "0.000000",
            createdAt: new Date().toISOString(),
            ...(input.type === "market" ? { fillPrice: "50000.000000", fee: "0.050000" } : {}),
          };
          state = { ...state, orders: [order, ...state.orders] };
        } else if (input.action === "cancel") {
          state = { ...state, orders: state.orders.map(order => order.id === input.orderId ? { ...order, status: "cancelled", reserved: "0.000000" } : order) };
        }
        completed.set(idempotencyKey, state);
        return json(route, state);
      }
      return json(route, {});
    });

    await page.goto("http://127.0.0.1:5000/trading?lang=en");
    await page.getByRole("heading", { name: tradingCopy("en").title, exact: true }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: productionTradingCopy("en").production, exact: true }).click();
    await page.getByRole("heading", { name: productionTradingCopy("en").title, exact: true }).waitFor();
    await page.getByRole("button", { name: productionTradingCopy("en").demo, exact: true }).click();
    await page.getByText(tradingCopy("en").tradingBalance, { exact: true }).waitFor();
    assert.equal(state.balances.USDT.available, "10000.000000");

    // An ambiguous first submission is retried with the exact same payload and key.
    await page.getByLabel(`${tradingCopy("en").quantity} (BTC)`, { exact: true }).fill("0.001");
    await page.getByRole("button", { name: tradingCopy("en").submit, exact: true }).click();
    await page.getByRole("alert").filter({ hasText: tradingCopy("en").network }).waitFor();
    await page.getByRole("button", { name: tradingCopy("en").retry, exact: true }).click();
    await page.getByText(tradingCopy("en").orderAccepted, { exact: true }).waitFor();
    const orderAttempts = actionAttempts.filter(input => input.action === "order");
    assert.equal(orderAttempts.length, 2);
    assert.deepEqual(orderAttempts[1], orderAttempts[0]);

    await page.getByRole("button", { name: tradingCopy("en").sell, exact: true }).click();
    await page.getByLabel(`${tradingCopy("en").quantity} (BTC)`, { exact: true }).fill("0.001");
    await page.getByRole("button", { name: tradingCopy("en").submit, exact: true }).click();
    await page.getByRole("button", { name: tradingCopy("en").buy, exact: true }).click();
    await page.getByLabel(tradingCopy("en").type, { exact: true }).selectOption("limit");
    await page.getByLabel(tradingCopy("en").price, { exact: true }).fill("40000");
    await page.getByLabel(`${tradingCopy("en").quantity} (BTC)`, { exact: true }).fill("0.001");
    await page.getByRole("button", { name: tradingCopy("en").submit, exact: true }).click();
    await page.getByRole("button", { name: tradingCopy("en").cancel, exact: true }).click();
    await page.getByRole("cell", { name: tradingCopy("en").status_cancelled, exact: true }).waitFor();
    assert.ok(await page.locator("canvas").count() > 0);
    await page.getByText(tradingCopy("en").rules, { exact: true }).waitFor();
    assert.match(tradingCopy("en").rules, /internal simulator, not Alpaca/, "disclose simulation rather than provider execution");

    mkdirSync("screenshot", { recursive: true });
    await page.screenshot({ path: "screenshot/trading-internal-demo.jpg", type: "jpeg", quality: 85 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "mobile demo must not overflow");
    assert.ok(await page.locator("canvas").first().evaluate(canvas => canvas.getBoundingClientRect().width <= window.innerWidth), "chart must resize to the mobile viewport");
    const canvasCount = await page.locator("canvas").count();
    await page.getByLabel(tradingCopy("en").pair, { exact: true }).selectOption("ETHUSDT");
    await page.getByLabel(`${tradingCopy("en").quantity} (ETH)`, { exact: true }).waitFor();
    await page.getByLabel(tradingCopy("en").pair, { exact: true }).selectOption("BTCUSDT");
    assert.equal(await page.locator("canvas").count(), canvasCount, "changing pair must not leak canvases");

    for (const language of ["ht", "fr"]) {
      await page.goto(`http://127.0.0.1:5000/trading?lang=${language}`);
      await page.getByRole("heading", { name: tradingCopy(language).title, exact: true }).waitFor();
      await page.getByText(tradingCopy(language).warning, { exact: true }).waitFor();
    }
    await context.close();
  } finally {
    await browser.close();
  }
});