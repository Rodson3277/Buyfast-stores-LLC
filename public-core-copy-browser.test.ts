import test from "node:test";
import { readFileSync, mkdirSync } from "node:fs";
import { chromium, expect } from "@playwright/test";
import { HIDDEN_CUSTOMER_SERVICE_ROUTES } from "../client/src/lib/customerServiceVisibility";

// Uses the existing preview only. All API traffic is mocked; external traffic is blocked.
test("public core copy and navigation on desktop/mobile in all locales", { timeout: 240_000 }, async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  mkdirSync("screenshots/public-copy", { recursive: true });
  try {
    for (const language of ["en", "ht", "fr", "es"]) {
      const copy = JSON.parse(readFileSync(`client/src/locales/${language}.json`, "utf8"));
      for (const width of [390, 1280]) {
        const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: "block" });
        const user = { id: "copy-fixture", email: "copy@example.invalid", firstName: "Fixture",
          isAdmin: false, isOwner: false, isActive: true, isBlocked: false, emailVerified: true, language };
        await context.addInitScript(({ user, language }) => {
          if (location.pathname === "/welcome") {
            localStorage.removeItem("buyfast_session_user");
          } else {
            localStorage.setItem("buyfast_session_user", JSON.stringify({ data: user }));
          }
          localStorage.setItem("buyfast_language", language);
          localStorage.setItem("i18nextLng", language);
          localStorage.setItem("promo_last_shown", String(Date.now()));
          localStorage.setItem("buyfast_notif_banner_dismissed", JSON.stringify({ ts: Date.now() }));
        }, { user, language });
        await context.route("**/*", async route => {
          const url = new URL(route.request().url());
          if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
          if (!url.pathname.startsWith("/api/")) {
            return route.request().method() === "GET" ? route.continue() : route.abort();
          }
          const send = (json: unknown) => route.fulfill({ json });
          if (url.pathname.includes("notifications")) return send([]);
          switch (url.pathname) {
            case "/api/public/stats": return send({ totalTransactions: 0, totalCustomers: 0, countriesServed: 0, successRate: 0 });
            case "/api/auth/session-user": return send(route.request().headers().referer?.includes("/welcome") ? null : user);
            case "/api/auth/blocked-status": return send({ isBlocked: false });
            case "/api/onboarding": return send({ required: false, completed: true });
            case "/api/user/currency-preference": return send({ currency: "USD" });
            case "/api/wallet/balance": return send({ balance: "100.00", currency: "USD" });
            case "/api/daily-promo": return send({ codes: [] });
            case "/api/social-proof/activity": return send({ items: [] });
            case "/api/public/hero-slides":
            case "/api/popular-operators":
            case "/api/reviews":
            case "/api/guest/promotions":
            case "/api/payment-visibility":
            case "/api/transactions":
            case "/api/deposits/my-requests":
            case "/api/deposits/settings": return send([]);
            default: return send({});
          }
        });
        const page = await context.newPage();
        page.on("pageerror", error => console.info("Browser exception:", error.message));
        for (const path of ["/welcome", "/services", "/"]) {
          await page.goto(`http://127.0.0.1:5000${path}?lang=${language}`);
          await page.waitForTimeout(1500);
          await expect(page.getByText(copy.services.mobileTopUp, { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 15000 }).catch(async error => {
            console.info("Failed page content", page.url(), await page.locator("body").innerText());
            throw error;
          });
          await expect(page.getByText(copy.services.billPayment, { exact: true }).filter({ visible: true }).first()).toBeVisible();
          for (const route of HIDDEN_CUSTOMER_SERVICE_ROUTES) {
            await expect(page.locator(`a[href="${route}"]`)).toHaveCount(0);
          }
          await expect(page).not.toHaveTitle(/money transfer|send money|remittance|moncash|natcash|cash pick[\s-]?up/i);
          for (const heading of await page.locator("h1,h2,h3").allTextContents()) {
            expect(heading).not.toMatch(/money transfer|send money|remittance|moncash|natcash|cash pick[\s-]?up/i);
          }
          if (path === "/welcome") {
            await expect(page).toHaveURL(/\/welcome/);
            await expect(page.locator("body")).not.toContainText(/money transfer|send money|remittance|transfè lajan|transferts? d.argent|transferencias? de dinero/i);
            await expect(page).toHaveTitle(new RegExp(copy.services.mobileTopUp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            await page.screenshot({ path: `screenshots/public-copy/welcome-${language}-${width}.png`, fullPage: true });
          }
        }
        for (const route of HIDDEN_CUSTOMER_SERVICE_ROUTES) {
          await page.goto(`http://127.0.0.1:5000${route}?lang=${language}`);
          await expect(page.getByTestId("service-unavailable")).toBeVisible();
          await expect(page).not.toHaveTitle(/money transfer|send money|remittance|moncash|natcash|cash pick[\s-]?up/i);
          for (const heading of await page.locator("h1,h2,h3").allTextContents()) {
            expect(heading).not.toMatch(/money transfer|send money|remittance|moncash|natcash|cash pick[\s-]?up/i);
          }
          const description = await page.locator('meta[name="description"]').getAttribute("content");
          expect(description).not.toMatch(/money transfer|send money|remittance|moncash|natcash|cash pick[\s-]?up/i);
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
});