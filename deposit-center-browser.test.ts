import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

// Already-running preview only. Every API response is a fixture; external
// traffic and non-GET asset requests are blocked. No DB/provider mutations.
test("mobile Deposit Center cancellation filter and manual actions", { timeout: 120_000 }, async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true, args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const user = { id: "deposit-admin-fixture", email: "fixture@example.invalid", firstName: "Fixture",
      isAdmin: true, isOwner: true, isActive: true, isBlocked: false, emailVerified: true, language: "en" };
    await context.addInitScript(user => {
      localStorage.setItem("buyfast_session_user", JSON.stringify({ data: user }));
      localStorage.setItem("i18nextLng", "en");
      localStorage.setItem("buyfast_language", "en");
      localStorage.setItem("promo_last_shown", String(Date.now()));
      localStorage.setItem("buyfast_notif_banner_dismissed", JSON.stringify({ ts: Date.now() }));
    }, user);
    const orders = ["cancel-target", "complete-target", "already-cancelled"].map((id, index) => ({
      id, userId: "customer-fixture", orderId: id, service: "zelle",
      recipientName: id, recipientContact: "fixture@example.invalid", recipientCurrency: "USD",
      paymentMethod: "wallet", amountUsd: "100.00", totalCharged: "102.00",
      feeAmount: "2.00", feePercent: "2", status: index === 2 ? "cancelled" : "pending",
      createdAt: "2026-01-01T00:00:00Z",
    }));
    const mutations: string[] = [];
    let release: (() => void) | undefined;
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
      if (!url.pathname.startsWith("/api/")) {
        return route.request().method() === "GET" ? route.continue() : route.abort();
      }
      const send = (json: unknown, status = 200) => route.fulfill({ json, status });
      const action = url.pathname.match(/^\/api\/admin\/deposits\/([^/]+)\/(complete|fail)$/);
      if (action) {
        assert.equal(route.request().method(), "PATCH");
        mutations.push(url.pathname);
        const order = orders.find(order => order.id === action[1])!;
        if (order.status !== "pending") return send({ message: "Already processed" }, 409);
        await new Promise<void>(resolve => { release = resolve; });
        order.status = action[2] === "complete" ? "completed" : "failed";
        return send({ success: true, refunded: action[2] === "fail", refundAmount: action[2] === "fail" ? 102 : 0 });
      }
      switch (url.pathname) {
        case "/api/admin/deposits": return send(orders.map(deposit => ({ deposit, userName: "Fixture" })));
        case "/api/admin/deposits/stats": return send({ total: 3, pending: orders.filter(o => o.status === "pending").length, completed: orders.filter(o => o.status === "completed").length, failed: orders.filter(o => o.status === "failed").length });
        case "/api/admin/deposit-settings": return send([]);
        case "/api/deposits/center-status": return send({ enabled: true });
        case "/api/auth/session-user": return send(user);
        case "/api/auth/blocked-status": return send({ isBlocked: false });
        case "/api/onboarding": return send({ required: false, completed: true });
        case "/api/user/currency-preference": return send({ currency: "USD" });
        case "/api/payment-visibility": return send([]);
        default: return send({});
      }
    });
    const page = await context.newPage();
    const recipient = (id: string) => page.locator("p").filter({ hasText: new RegExp(`^To: ${id} ·`) });
    await page.goto("http://127.0.0.1:5000/admin/deposit-center");
    const filter = page.locator("select").filter({ has: page.locator('option[value="cancelled"]') });
    await filter.selectOption("cancelled");
    await expect(recipient("already-cancelled")).toBeVisible();
    await expect(recipient("cancel-target")).toHaveCount(0);
    await expect(page.locator("span").filter({ hasText: /^Cancelled$/ })).toBeVisible();
    await page.screenshot({ path: "/tmp/deposit-center-mobile-cancelled.png", fullPage: true });
    await filter.selectOption("pending");
    for (const [id, action, result] of [
      ["cancel-target", "Cancel / Mark Failed", "Failed"],
      ["complete-target", "Mark Complete", "Completed"],
    ]) {
      await recipient(id).click();
      const complete = page.getByRole("button", { name: /Mark Complete/ });
      const fail = page.getByRole("button", { name: /Cancel \/ Mark Failed/ });
      await fail.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/deposit-center-mobile-${id}.png`, fullPage: true });
      await page.getByRole("button", { name: new RegExp(action) }).click();
      await expect(complete).toBeDisabled();
      await expect(fail).toBeDisabled();
      await expect.poll(() => mutations.length).toBe(id === "cancel-target" ? 1 : 2);
      // DOM clicks on disabled controls must not send a competing/repeat action.
      await complete.evaluate((button: HTMLButtonElement) => button.click());
      await fail.evaluate((button: HTMLButtonElement) => button.click());
      release!();
      await expect(recipient(id)).toHaveCount(0);
      await filter.selectOption(result.toLowerCase());
      await recipient(id).click();
      await expect(complete).toHaveCount(0);
      await expect(fail).toHaveCount(0);
      if (result === "Failed") await expect(page.getByText("User refunded $102.00 to wallet.", { exact: true })).toBeVisible();
      await page.screenshot({ path: `/tmp/deposit-center-mobile-${result.toLowerCase()}.png`, fullPage: true });
      await filter.selectOption("pending");
    }
    assert.deepEqual(mutations, ["/api/admin/deposits/cancel-target/fail", "/api/admin/deposits/complete-target/complete"]);
    await context.close();
  } finally {
    await browser.close();
  }
});