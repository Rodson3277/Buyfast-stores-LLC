import { test, expect, type Page } from "@playwright/test";

const ID = "12345678-1234-4123-8123-123456789abc";
const user = { id: "square-browser-fixture", email: "square-fixture@example.invalid",
  firstName: "Browser", lastName: "Fixture", emailVerified: true, isActive: true,
  isBlocked: false, isAdmin: false, isSuperAdmin: false, hasPlayedWelcomeBox: true };
const quote = { id: ID, status: "created", amountCents: 1000, feeCents: 50,
  totalCents: 1050, currency: "USD", credited: false };

// Every API request is intercepted. Neither these tests nor the fake Square
// SDK can create a provider payment, a customer record, or a wallet credit.
async function setup(
  page: Page,
  mode: "success" | "uncertain" | "declined" | "review" | "uncredited" = "success",
  options: {
    applePayEnabled?: boolean;
    googlePayAttachHangs?: boolean;
  } = {},
) {
  let pays = 0;
  let creates = 0;
  let restoreUnavailable = false;
  let current = { ...quote };
  await page.addInitScript(({ googlePayAttachHangs }) => {
    localStorage.setItem("promo_last_shown", String(Date.now()));
    localStorage.setItem("buyfast_notif_banner_dismissed", JSON.stringify({ ts: Date.now() }));
    localStorage.setItem("i18nextLng", "en");
    (window as any).__squareVerification = [];
    (window as any).__squareLifecycle = { created: 0, active: 0, maxActive: 0, destroyed: [] };
    (window as any).__squareWalletLifecycle = {
      appleTokenizeInClick: false, appleTokenize: 0, googleTokenize: 0,
      achInit: 0, cashAppInit: 0,
      destroyed: { apple: 0, google: 0 },
    };
    (window as any).Square = {
      payments: () => ({
        ach: async () => { (window as any).__squareWalletLifecycle.achInit++; throw new Error("ACH must not initialize"); },
        paymentRequest: (options: unknown) => options,
        applePay: async () => ({
          tokenize: () => {
            const wallet = (window as any).__squareWalletLifecycle;
            wallet.appleTokenize++;
            wallet.appleTokenizeInClick = (window as any).event?.type === "click";
            return Promise.resolve({ status: "OK", token: "TEST_APPLE_TOKEN" });
          },
          destroy: async () => { (window as any).__squareWalletLifecycle.destroyed.apple++; },
        }),
        googlePay: async () => ({
          attach: async (selector: string) => {
            if (googlePayAttachHangs) await new Promise<void>(() => {});
            const element = document.querySelector(selector);
            if (element) element.innerHTML = '<button type="button" data-testid="square-google-provider-button">Google Pay</button>';
          },
          tokenize: async () => {
            (window as any).__squareWalletLifecycle.googleTokenize++;
            return { status: "OK", token: "TEST_GOOGLE_TOKEN" };
          },
          destroy: async () => { (window as any).__squareWalletLifecycle.destroyed.google++; },
        }),
        cashAppPay: async () => { (window as any).__squareWalletLifecycle.cashAppInit++; throw new Error("Cash App must not initialize"); },
        card: async () => {
          const lifecycle = (window as any).__squareLifecycle;
          const cardId = ++lifecycle.created;
          return {
            attach: async (selector: string) => {
              if ((window as any).__squareMountFailure) throw new Error((window as any).__squareMountFailure);
              if ((window as any).__squareDelayFirstAttach && cardId === 1) {
                (window as any).__squareFirstAttachStarted = true;
                await new Promise<void>(resolve => { (window as any).__squareReleaseFirstAttach = resolve; });
              }
              if (lifecycle.active) throw new Error("overlapping Square card mounts");
              lifecycle.active = cardId;
              lifecycle.maxActive = Math.max(lifecycle.maxActive, lifecycle.active ? 1 : 0);
              const element = document.querySelector(selector);
              if (element) element.textContent = "Secure card fields (test fixture)";
            },
            destroy: async () => {
              lifecycle.destroyed.push(cardId);
              if (lifecycle.active === cardId) lifecycle.active = 0;
            },
            tokenize: async (details: unknown) => {
              (window as any).__squareVerification.push(details);
              if ((window as any).__squareDelayToken) {
                await new Promise<void>(resolve => { (window as any).__squareReleaseToken = resolve; });
              }
              return { status: "OK", token: "TEST_ONLY_NOT_A_REAL_PAYMENT_TOKEN" };
            },
          };
        },
      }),
    };
  }, {
    googlePayAttachHangs: options.googlePayAttachHangs ?? false,
  });
  await page.route("https://*.squareup.com/**", route => route.abort());
  await page.route("https://*.squarecdn.com/**", route => route.abort());
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === "/api/auth/session-user") return send(user);
    if (path === "/api/payment-visibility") return send([]);
    if (path === "/api/exchange-rates") return send({ rates: [{ currencyCode: "USD", rateToUSD: 1 }] });
    if (path === "/api/user/currency-preference") return send({ currency: "USD" });
    if (path === "/api/calculate-fee") return send({ fee: 0.5, feeValue: 5, feeType: "percentage" });
    if (path === "/api/auth/blocked-status") return send({ isBlocked: false });
    if (path === "/api/onboarding") return send({ required: false, completed: true });
    if (path === "/api/square/wallet/config") return send({ enabled: true, applicationId: "test-app",
      locationId: "test-location", countryCode: "US", applePayEnabled: options.applePayEnabled ?? true,
      currency: "USD", minAmountCents: 500, maxAmountCents: 100000 });
    if (path === "/api/square/wallet/intents" && route.request().method() === "POST") {
      creates++;
      const request = route.request().postDataJSON();
      expect(request).toMatchObject({ termsAccepted: true });
      expect(request.amount).toMatch(/^\d+\.\d{2}$/);
      const amountCents = Math.round(Number(request.amount) * 100);
      current = { ...quote, amountCents, feeCents: Math.round(amountCents * 0.05), totalCents: Math.round(amountCents * 1.05) };
      return send(current);
    }
    if (path === `/api/square/wallet/intents/${ID}/pay`) {
      pays++;
      expect(route.request().postDataJSON()).toEqual({
        sourceId: expect.stringMatching(/^TEST_(?:ONLY_NOT_A_REAL_PAYMENT_TOKEN|APPLE_TOKEN|GOOGLE_TOKEN)$/),
      });
      if (mode === "uncertain") {
       current = { ...current, status: "pending" };
        return route.abort("failed");
      }
      current = { ...current, status: mode === "success" || mode === "uncredited" ? "completed" :
        mode === "review" ? "review" : "failed", credited: mode === "success" };
      return send(current);
    }
    if (path === `/api/square/wallet/intents/${ID}`)
      return restoreUnavailable ? send({ error: "TEMPORARILY_UNAVAILABLE" }, 503) : send(current);
    if (path.includes("/balance")) return send({ balance: "0.00" });
    return send({});
  });
  return { pays: () => pays, creates: () => creates,
    status: (status: string) => { current = { ...current, status }; },
    failRestore: (value: boolean) => { restoreUnavailable = value; },
    settle: () => { current = { ...current, status: "completed", credited: true }; } };
}

test("retirement shows unavailable and never initializes SDK or creates a payment with enabled config", async ({ page }) => {
  const calls = await setup(page, "success", { applePayEnabled: true });
  await page.goto("/wallet/square?lang=en");
  await expect(page.getByTestId("square-wallet-retired")).toBeVisible();
  await expect(page.getByTestId("square-wallet-pay")).toHaveCount(0);
  await expect(page.getByTestId("square-card-mount")).toHaveCount(0);
  expect(calls.creates()).toBe(0);
  expect(calls.pays()).toBe(0);
  expect(await page.evaluate(() => (window as any).__squareLifecycle.created)).toBe(0);
  expect(await page.locator('script[src*="squarecdn"]').count()).toBe(0);
});

test("retirement recovers a historical pending redirect and polls completion without checkout", async ({ page }) => {
  const calls = await setup(page);
  calls.status("pending");
  await page.addInitScript(({ id, userId }) => {
    sessionStorage.setItem(`buyfast_square_wallet_intent:${userId}`, id);
  }, { id: ID, userId: user.id });
  await page.goto(`/wallet/square?lang=en&cashAppIntent=${ID}`);
  await expect(page.getByTestId("square-wallet-retired")).toContainText("The payment is being verified");
  calls.settle();
  await expect(page.getByTestId("square-wallet-retired")).toContainText("Your wallet was credited successfully");
  expect(calls.creates()).toBe(0);
  expect(calls.pays()).toBe(0);
  expect(await page.evaluate(() => (window as any).__squareLifecycle.created)).toBe(0);
});

async function prepare(page: Page) {
  await page.goto("/wallet/square?lang=en");
  await page.getByTestId("square-wallet-amount").fill("10");
  await page.getByTestId("square-wallet-terms").click();
  await page.getByRole("button", { name: "Continue to verify total" }).click();
  await expect(page.getByTestId("square-wallet-pay")).toBeEnabled();
  await expect(page.getByTestId("square-wallet-quote")).toContainText("10.50");
}

test("server quote controls real-charge confirmation; credited response alone shows success", async ({ page }) => {
  const calls = await setup(page);
  await prepare(page);
  await page.getByTestId("square-wallet-pay").hover();
  await expect(page.getByTestId("square-wallet-pay")).toHaveCSS("background-color", "rgb(201, 0, 119)");
  await page.mouse.move(0, 0);
  await expect(page.getByTestId("square-wallet-pay")).toHaveCSS("background-color", "rgb(236, 0, 140)");
  await expect(page.getByTestId("square-wallet-pay")).toHaveCSS("color", "rgb(255, 255, 255)");
  await page.getByTestId("square-wallet-pay").screenshot({ path: "/tmp/buyfast-pay-button.jpg" });
  await page.getByTestId("square-wallet-pay").click();
  await expect(page.getByTestId("square-wallet-success")).toBeVisible();
  expect(calls.pays()).toBe(1);
  expect(await page.evaluate(() => (window as any).__squareVerification)).toMatchObject([
    { amount: "10.50", currencyCode: "USD", intent: "CHARGE", customerInitiated: true, sellerKeyedIn: false },
  ]);
});

test("Apple Pay tokenization starts immediately inside the user gesture", async ({ page }) => {
  const calls = await setup(page);
  await prepare(page);
  const apple = page.getByTestId("square-apple-pay");
  await expect(apple).toBeVisible();
  await expect(apple).not.toHaveClass(/buyfast-pay-button/);
  await apple.click();
  await expect(page.getByTestId("square-wallet-success")).toBeVisible();
  expect(calls.pays()).toBe(1);
  expect(await page.evaluate(() => (window as any).__squareWalletLifecycle)).toMatchObject({
    appleTokenize: 1,
    appleTokenizeInClick: true,
  });
});

test("Apple Pay remains hidden unless server confirms domain readiness", async ({ page }) => {
  await setup(page, "success", { applePayEnabled: false });
  await prepare(page);
  await expect(page.getByTestId("square-apple-pay")).toHaveCount(0);
  await expect(page.getByTestId("square-google-provider-button")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__squareWalletLifecycle.appleTokenize)).toBe(0);
});

test("Square-rendered Google Pay button tokenizes and uses the shared pay endpoint", async ({ page }) => {
  const calls = await setup(page);
  await prepare(page);
  const providerButton = page.getByTestId("square-google-provider-button");
  await expect(providerButton).toBeVisible();
  await expect(providerButton).not.toHaveClass(/buyfast-pay-button/);
  await providerButton.click();
  await expect(page.getByTestId("square-wallet-success")).toBeVisible();
  expect(calls.pays()).toBe(1);
  expect(await page.evaluate(() => (window as any).__squareWalletLifecycle.googleTokenize)).toBe(1);
});

test("Cash App and ACH are neither offered nor initialized", async ({ page }) => {
  await setup(page);
  await prepare(page);
  await expect(page.getByTestId("square-cash-app-pay")).toHaveCount(0);
  await expect(page.getByTestId("square-cash-app-unavailable")).toHaveCount(0);
  await expect(page.getByTestId("square-ach")).toHaveCount(0);
  await expect(page.getByTestId("square-ach-pay")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__squareWalletLifecycle)).toMatchObject({
    achInit: 0,
    cashAppInit: 0,
  });
});

test("a legacy Cash App return performs status-only recovery", async ({ page }) => {
  const calls = await setup(page);
  await prepare(page);
  await page.goto(`/wallet/square?cashAppIntent=${ID}&lang=en`);
  await expect(page.getByTestId("square-wallet-pending")).toBeVisible();
  await expect(page.getByTestId("square-cash-app-pay")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__squareWalletLifecycle)).toMatchObject({
    achInit: 0,
    cashAppInit: 0,
  });
  expect(calls.creates()).toBe(1);
  expect(calls.pays()).toBe(0);
});

test("unknown network result and reload never re-submit the charge", async ({ page }) => {
  const calls = await setup(page, "uncertain");
  await prepare(page);
  await page.getByTestId("square-wallet-pay").click();
  await expect(page.getByTestId("square-wallet-pending")).toBeVisible();
  await expect(page.getByTestId("square-wallet-success")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("square-wallet-pending")).toBeVisible();
  expect(calls.pays()).toBe(1);
  expect(calls.creates()).toBe(1);
  calls.settle();
  await expect(page.getByTestId("square-wallet-success")).toBeVisible({ timeout: 20_000 });
  expect(calls.pays()).toBe(1);
});

test("a definite decline permits a fresh attempt without claiming credit", async ({ page }) => {
  const calls = await setup(page, "declined");
  await prepare(page);
  await page.getByTestId("square-wallet-pay").click();
  await expect(page.getByRole("button", { name: "Start a new attempt" })).toBeVisible();
  await expect(page.getByTestId("square-wallet-success")).toHaveCount(0);
  expect(calls.pays()).toBe(1);
});

test("an unpaid saved quote restores its amount but requires fresh terms", async ({ page }) => {
  const calls = await setup(page);
  await prepare(page);
  await page.reload();
  await expect(page.getByTestId("square-wallet-pay")).toHaveCount(0);
  await expect(page.getByTestId("square-wallet-restored-terms")).not.toBeChecked();
  await page.getByTestId("square-wallet-restored-terms").click();
  await expect(page.getByTestId("square-wallet-pay")).toBeEnabled();
  await expect(page.getByTestId("square-wallet-quote")).toContainText("10.00");
  expect(calls.pays()).toBe(0);
  expect(calls.creates()).toBe(1);
});

test("revoking standalone terms hides every unsubmitted Square method", async ({ page }) => {
  const calls = await setup(page);
  await prepare(page);
  await expect(page.getByTestId("square-wallet-restored-terms")).toBeChecked();
  await page.getByTestId("square-wallet-restored-terms").click();
  await expect(page.getByTestId("square-wallet-pay")).toHaveCount(0);
  await expect(page.getByTestId("square-apple-pay")).toHaveCount(0);
  await expect(page.getByTestId("square-google-provider-button")).toHaveCount(0);
  await expect(page.getByTestId("square-cash-app-pay")).toHaveCount(0);
  expect(calls.creates()).toBe(1);
  expect(calls.pays()).toBe(0);
});

test("temporary restore failures retain the intent and block a new payment", async ({ page }) => {
  const calls = await setup(page);
  await prepare(page);
  calls.failRestore(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "Check status again" })).toBeVisible();
  await expect(page.getByTestId("square-wallet-amount")).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("buyfast_square_wallet_intent:square-browser-fixture"))).toBe(ID);
  calls.failRestore(false);
  await page.getByRole("button", { name: "Check status again" }).click();
  await expect(page.getByTestId("square-wallet-restored-terms")).not.toBeChecked();
  await page.getByTestId("square-wallet-restored-terms").click();
  await expect(page.getByTestId("square-wallet-pay")).toBeEnabled();
  expect(calls.creates()).toBe(1);
  expect(calls.pays()).toBe(0);
});

for (const state of ["review", "uncredited"] as const) {
  test(`${state} does not display a credit or invite a duplicate payment`, async ({ page }) => {
    const calls = await setup(page, state);
    await prepare(page);
    await page.getByTestId("square-wallet-pay").click();
    await expect(page.getByTestId("square-wallet-pending")).toBeVisible();
    await expect(page.getByTestId("square-wallet-success")).toHaveCount(0);
    await expect(page.getByTestId("square-wallet-pay")).toHaveCount(0);
    expect(calls.pays()).toBe(1);
  });
}

test("mobile quote fits the viewport without hiding the card confirmation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await prepare(page);
  await expect(page.getByTestId("square-wallet-pay")).toBeEnabled();
  await expect(page.getByTestId("square-google-pay")).toBeVisible();
  await expect(page.getByTestId("square-card-mount")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.locator("#billing-postal")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.getByTestId("square-google-pay").locator("button")).toHaveCSS("background-color", "rgb(0, 0, 0)");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const billingInputTops = await page.evaluate(() => [
    document.querySelector("#billing-postal")!.getBoundingClientRect().top,
    document.querySelector("#billing-country")!.getBoundingClientRect().top,
  ]);
  expect(Math.abs(billingInputTops[0] - billingInputTops[1])).toBeLessThan(1);
  await page.screenshot({ path: "/tmp/square-wallet-mobile.jpg", fullPage: true });
});

test("add-funds reveals only inline card checkout after amount and terms", async ({ page }) => {
  const calls = await setup(page);
  await page.goto("/add-funds?lang=en");
  await expect(page.getByTestId("button-amount-10.00")).toBeVisible();
  await expect(page.getByText(/\bSquare\b/)).toHaveCount(0);
  await expect(page.getByTestId("square-card-mount")).toHaveCount(0);
  await expect(page.getByTestId("button-crypto-payment")).toHaveCount(0);
  await expect(page.getByTestId("button-pix-coming-soon")).toHaveCount(0);
  await expect(page.getByTestId("button-moncash-disabled")).toHaveCount(0);
  await expect(page.getByTestId("link-bank-funding")).toHaveCount(0);
  expect(calls.creates()).toBe(0);
  await page.getByTestId("button-amount-10.00").click();
  await expect(page.getByTestId("square-card-mount")).toHaveCount(0);
  expect(calls.creates()).toBe(0);
  await page.getByTestId("checkbox-add-funds-terms-acceptance").click();
  await expect(page.getByTestId("square-wallet-pay")).toBeEnabled();
  await expect(page.getByTestId("square-wallet-amount")).toHaveCount(0);
  await expect(page.getByTestId("square-wallet-terms")).toHaveCount(0);
  await expect(page.getByText(/\bSquare\b/)).toHaveCount(0);
  const belowTerms = await page.evaluate(() => {
    const form = document.querySelector('[data-testid="square-card-mount"]')!;
    const terms = document.querySelector('[data-testid="checkbox-add-funds-terms-acceptance"]')!;
    return form.getBoundingClientRect().top > terms.getBoundingClientRect().bottom;
  });
  expect(belowTerms).toBe(true);
  expect(calls.creates()).toBe(1);
  expect(calls.pays()).toBe(0);
  await page.getByTestId("checkbox-add-funds-terms-acceptance").click();
  await expect(page.getByTestId("square-card-mount")).toHaveCount(0);
  await expect(page.getByTestId("square-wallet-pay")).toHaveCount(0);
  await expect(page.getByTestId("button-crypto-payment")).toHaveCount(0);
  await expect(page.getByTestId("link-bank-funding")).toHaveCount(0);
  expect(calls.pays()).toBe(0);
});

test("revoking terms during tokenization cannot charge an old inline quote", async ({ page }) => {
  const calls = await setup(page);
  await page.goto("/add-funds?lang=en");
  await page.getByTestId("button-amount-10.00").click();
  await page.getByTestId("checkbox-add-funds-terms-acceptance").click();
  await expect(page.getByTestId("square-wallet-pay")).toBeEnabled();
  await page.evaluate(() => { (window as any).__squareDelayToken = true; });
  await page.getByTestId("square-wallet-pay").click();
  await page.waitForFunction(() => typeof (window as any).__squareReleaseToken === "function");
  await page.getByTestId("checkbox-add-funds-terms-acceptance").click();
  await page.evaluate(() => (window as any).__squareReleaseToken());
  await expect(page.getByTestId("square-card-mount")).toHaveCount(0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(calls.pays()).toBe(0);
});

test("a stale asynchronous card attach is destroyed before an inline remount", async ({ page }) => {
  const calls = await setup(page);
  await page.goto("/add-funds?lang=en");
  await page.getByTestId("button-amount-10.00").click();
  await page.evaluate(() => { (window as any).__squareDelayFirstAttach = true; });
  await page.getByTestId("checkbox-add-funds-terms-acceptance").click();
  await page.waitForFunction(() => (window as any).__squareFirstAttachStarted === true);

  await page.getByTestId("checkbox-add-funds-terms-acceptance").click();
  await expect(page.getByTestId("square-card-mount")).toHaveCount(0);
  await page.evaluate(() => (window as any).__squareReleaseFirstAttach());
  await page.getByTestId("checkbox-add-funds-terms-acceptance").click();

  await expect(page.getByTestId("square-wallet-pay")).toBeEnabled();
  await expect(page.getByTestId("square-card-mount")).toContainText("Secure card fields");
  expect(await page.evaluate(() => (window as any).__squareLifecycle)).toMatchObject({
    created: 2,
    active: 2,
    maxActive: 1,
    destroyed: [1],
  });
  expect(calls.pays()).toBe(0);
});

test("changing parent terms after submission preserves uncertain payment recovery", async ({ page }) => {
  const calls = await setup(page, "uncertain");
  await page.goto("/add-funds?lang=en");
  await page.getByTestId("button-amount-10.00").click();
  await page.getByTestId("checkbox-add-funds-terms-acceptance").click();
  await expect(page.getByTestId("square-wallet-pay")).toBeEnabled();
  await page.getByTestId("square-wallet-pay").click();
  await expect(page.getByTestId("square-wallet-pending")).toBeVisible();
  await page.getByTestId("checkbox-add-funds-terms-acceptance").click();
  await expect(page.getByTestId("square-wallet-pending")).toBeVisible();
  await expect(page.getByTestId("square-wallet-pay")).toHaveCount(0);
  expect(calls.pays()).toBe(1);
});

test("mount failure shows redacted diagnostics and retry never charges", async ({ page }) => {
  const calls = await setup(page);
  await page.goto("/add-funds?lang=en");
  await page.evaluate(() => {
    (window as any).__squareMountFailure = "Network failed https://example.invalid/private?key=secret sample@example.invalid abcdefghijklmnopqrstuvwxyz123456";
  });
  await page.getByTestId("button-amount-10.00").click();
  await page.getByTestId("checkbox-add-funds-terms-acceptance").click();
  const diagnostic = page.getByTestId("card-mount-diagnostic");
  await expect(diagnostic).toContainText("CARD_ATTACH");
  await expect(diagnostic).toContainText("[url]");
  await expect(diagnostic).not.toContainText("secret");
  await expect(diagnostic).not.toContainText("sample@example.invalid");
  await expect(page.getByTestId("square-wallet-pay")).toBeDisabled();
  await page.evaluate(() => { (window as any).__squareMountFailure = ""; });
  await page.getByRole("button", { name: "Reload secure card form" }).click();
  await expect(page.getByTestId("square-wallet-pay")).toBeEnabled();
  await expect(diagnostic).toHaveCount(0);
  expect(calls.pays()).toBe(0);
});

test("shared payment styling overrides legacy themes without enabling disabled buttons", async ({ page }) => {
  await setup(page);
  await prepare(page);
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.className = "buyfast-pay-button";
    button.dataset.testid = "shared-pay-style-fixture";
    button.style.background = "linear-gradient(blue, green)";
    button.style.color = "black";
    button.disabled = true;
    button.innerHTML = '<span style="color: black">Pay</span>';
    document.body.appendChild(button);
  });
  const button = page.getByTestId("shared-pay-style-fixture");
  await expect(button).toHaveCSS("background-color", "rgb(236, 0, 140)");
  await expect(button).toHaveCSS("background-image", "none");
  await expect(button.locator("span")).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(button).toHaveCSS("opacity", "0.5");
  await expect(button).toBeDisabled();
});