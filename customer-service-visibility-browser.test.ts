import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium, expect } from "@playwright/test";
import { HIDDEN_CUSTOMER_SERVICE_ROUTES } from "../client/src/lib/customerServiceVisibility";

// Already-running preview only; no real API or provider requests are permitted.
test("customer navigation and new-order guards on mobile and desktop", { timeout: 180_000 }, async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true, args: ["--no-sandbox"],
  });
  mkdirSync("screenshots/customer-gift-visibility", { recursive: true });
  try {
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: "block" });
      const user = { id: "visibility-fixture", email: "fixture@example.invalid", firstName: "Fixture",
        isAdmin: false, isOwner: false, isActive: true, isBlocked: false, emailVerified: true, language: "en" };
      await context.addInitScript(user => {
        localStorage.setItem("buyfast_session_user", JSON.stringify({ data: user }));
        localStorage.setItem("i18nextLng", "en");
        localStorage.setItem("buyfast_language", "en");
        localStorage.removeItem("promo_last_shown");
        localStorage.removeItem("buyfast_query_cache_v3");
        localStorage.setItem(`buyfast_app_download_v1_${user.id}`, "1");
        localStorage.setItem("buyfast_app_download_v1", "1");
        localStorage.setItem("buyfast_notif_banner_dismissed", JSON.stringify({ ts: Date.now() }));
      }, user);
      const giftRequests: string[] = [];
      const giftPromo = { code: "HIDDEN-GIFT-PROMO", applicableTo: "gift-card", discountValue: "10", discountType: "percentage", expiresAt: "2099-01-01T00:00:00Z" };
      let promoCodes = [giftPromo];
      await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
        if (!url.pathname.startsWith("/api/")) {
          return route.request().method() === "GET" ? route.continue() : route.abort();
        }
        const send = (json: unknown) => route.fulfill({ json });
        if (/giftcards/.test(url.pathname)) giftRequests.push(url.pathname);
        if (url.pathname.includes("notifications")) return send([]);
        switch (url.pathname) {
          case "/api/auth/session-user": return send(user);
          case "/api/auth/blocked-status": return send({ isBlocked: false });
          case "/api/onboarding": return send({ required: false, completed: true });
          case "/api/user/currency-preference": return send({ currency: "USD" });
          case "/api/wallet/balance": return send({ balance: "100.00", currency: "USD" });
          case "/api/fees": return send({ moncashEnabled: true, natcashEnabled: true, cashPickEnabled: true });
          case "/api/deposits/center-status": return send({ enabled: true });
          case "/api/kyc/status": return send({ kycStatus: "verified", documentVerified: true });
          case "/api/daily-promo": return send({ codes: promoCodes });
          case "/api/giftcards/history": return send([{
            id: "past-gift-fixture", productName: "Past Gift Receipt", brand: "Amazon",
            amount: "10.00", totalAmount: "10.00", currency: "USD", quantity: 1,
            status: "completed", createdAt: "2026-01-01T12:00:00Z",
          }]);
          case "/api/social-proof/activity": return send({ items: [] });
          case "/api/public/hero-slides":
          case "/api/guest/promotions":
          case "/api/payment-visibility":
          case "/api/transactions":
          case "/api/deposits/my-requests":
          case "/api/deposits/settings": return send([]);
          default: return send({});
        }
      });
      const page = await context.newPage();
      for (const path of ["/", "/services", "/welcome"]) {
        await page.goto(`http://127.0.0.1:5000${path}`);
        await expect(page.getByText("Mobile Top-Up / Airtime Recharge", { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 15000 });
        await expect(page.getByRole("button", { name: /Gift Cards/i })).toHaveCount(0);
        await expect(page.getByTestId("service-giftcard")).toHaveCount(0);
        await page.waitForTimeout(2100);
        await expect(page.getByTestId("daily-promo")).toHaveCount(0);
        await expect(page.getByText("HIDDEN-GIFT-PROMO", { exact: true })).toHaveCount(0);
        for (const route of HIDDEN_CUSTOMER_SERVICE_ROUTES) {
          await expect(page.locator(`a[href="${route}"]`)).toHaveCount(0);
        }
        if (path === "/") {
          await expect(page.getByRole("button", { name: /MonCash|NatCash|Buyfast Pick|Cash Pick|Bank & wallet deposits/i })).toHaveCount(0);
          await page.screenshot({ path: `screenshots/customer-gift-visibility/dashboard-${width}.png`, fullPage: true });
        }
      }
      assert.equal(giftRequests.length, 0, "Discovery and blocked routes must not fetch gift catalog or purchase APIs");
      // A hidden gift offer must also be removed when a visible airtime offer exists.
      promoCodes = [giftPromo, { ...giftPromo, code: "VISIBLE-AIRTIME", applicableTo: "topup" }];
      await page.goto("http://127.0.0.1:5000/dashboard");
      await expect(page.getByTestId("daily-promo")).toBeVisible();
      await expect(page.getByText("VISIBLE-AIRTIME", { exact: true })).toBeVisible();
      await expect(page.getByText("HIDDEN-GIFT-PROMO", { exact: true })).toHaveCount(0);
      await page.screenshot({ path: `screenshots/customer-gift-visibility/promo-${width}.png`, fullPage: true });
      promoCodes = [];
      await page.evaluate(() => localStorage.setItem("promo_last_shown", String(Date.now())));
      await page.goto("http://127.0.0.1:5000/history");
      await expect(page.getByTestId("service-unavailable")).toHaveCount(0);
      await expect(page.getByText("Past Gift Receipt", { exact: false }).first()).toBeVisible();
      await page.screenshot({ path: `screenshots/customer-gift-visibility/history-${width}.png`, fullPage: true });
      await page.evaluate(() => sessionStorage.setItem("giftCardDelivery", JSON.stringify({
        transactionId: "past-gift-fixture", productName: "Past Gift Receipt", brand: "Amazon",
        amount: "10.00", totalAmount: "10.00", currency: "USD", quantity: 1,
        status: "completed", paymentMethod: "wallet", timestamp: "2026-01-01T12:00:00Z",
        giftCodes: [{ code: "PAST-CODE-TEST", pin: "1234" }],
      })));
      await page.goto("http://127.0.0.1:5000/gift-card-delivery");
      await expect(page.getByText("PAST-CODE-TEST", { exact: true })).toBeVisible();
      await expect(page.getByTestId("button-download-receipt")).toBeVisible();
      await expect(page.getByTestId("button-buy-more")).toHaveCount(0);
      const receiptDownload = page.waitForEvent("download");
      await page.getByTestId("button-download-receipt").click();
      assert.match((await receiptDownload).suggestedFilename(), /\.pdf$/i);
      await page.screenshot({ path: `screenshots/customer-gift-visibility/delivery-${width}.png`, fullPage: true });
      for (const path of HIDDEN_CUSTOMER_SERVICE_ROUTES) {
        await page.goto(`http://127.0.0.1:5000${path}`);
        await expect(page.getByTestId("service-unavailable")).toBeVisible();
        await expect(page.locator('a[href="/history"]')).toBeVisible();
      }
      for (const [language, title] of [
        ["ht", "Sèvis la pa disponib pou kounye a"],
        ["fr", "Service temporairement indisponible"],
        ["es", "Servicio temporalmente no disponible"],
        ["en", "Service temporarily unavailable"],
      ]) {
        await page.goto(`http://127.0.0.1:5000/gift-cards?amount=10&lang=${language}`);
        await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, follow");
      }
      await page.screenshot({ path: `screenshots/customer-gift-visibility/blocked-${width}.png`, fullPage: true });
      assert.ok(giftRequests.every(path => path === "/api/giftcards/history"), "No gift catalog, purchase or fulfillment requests from customer checks");
      await page.goto("http://127.0.0.1:5000/deposit-center?tab=history");
      await expect(page.getByTestId("service-unavailable")).toHaveCount(0);
      await expect(page.getByText("No transfers yet.", { exact: true })).toBeVisible();
      await context.close();
    }
  } finally {
    await browser.close();
  }
});