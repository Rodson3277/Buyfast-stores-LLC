import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

// Already-running preview; every API is mocked, all external traffic blocked.
// No real administrator records, funds, database writes or provider calls.
test("manual funding UI collects actual receipts for all methods and preserves safe paid transitions", { timeout: 120_000 }, async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true, args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const user = { id: "fund-admin-fixture", email: "fixture@example.invalid", firstName: "Fixture",
      isAdmin: true, isOwner: true, isActive: true, isBlocked: false, emailVerified: true, language: "en" };
    await context.addInitScript(user => {
      if (!localStorage.getItem("buyfast_session_user")) localStorage.setItem("buyfast_session_user", JSON.stringify({ data: user }));
      if (!localStorage.getItem("i18nextLng")) localStorage.setItem("i18nextLng", "en");
      if (!localStorage.getItem("buyfast_language")) localStorage.setItem("buyfast_language", "en");
      localStorage.setItem("promo_last_shown", String(Date.now()));
      localStorage.setItem("buyfast_notif_banner_dismissed", JSON.stringify({ ts: Date.now() }));
    }, user);
    const methods = ["bank_transfer", "zelle", "cash_app", "western_union", "moneygram", "natcash"];
    const requests = methods.map((method, i) => ({
      id: `fixture-${method}`, userId: "customer-fixture", fullName: `Fixture ${method}`,
      receiveType: "wallet", paymentMethod: method, status: i === 5 ? "paid" : "pending",
      sendAmount: "10.00", sentAmount: "10.00", feeAmount: "0", totalAmount: "10.00",
      feePercentage: "0", referenceNumber: "CUSTOMER_UNVERIFIED", senderName: "Fixture",
      createdAt: "2026-01-01T00:00:00Z", sentDate: "2026-01-01", phone: "TEST_ONLY",
      country: "US", customerProofImageData: null, proofImageData: null, adminNote: null,
    }));
    requests.push({ ...requests[0], id: "paid-paypal", fullName: "Fixture paid PayPal", receiveType: "paypal", status: "paid" });
    requests.push({ ...requests[0], id: "provider-payment", fullName: "Fixture provider", paymentMethod: "paypal" });
    const submitted: any[] = [];
    let duplicate = false;
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
      if (!url.pathname.startsWith("/api/")) {
        if (route.request().method() !== "GET") return route.abort();
        return route.continue();
      }
      const send = (json: unknown, status = 200) => route.fulfill({ json, status });
      if (url.pathname.endsWith("/credit-wallet")) {
        const body = route.request().postDataJSON();
        submitted.push(body);
        if (duplicate) return send({ code: "FUND_DUPLICATE_RECEIPT", message: "Transaction reference sa deja itilize" }, 409);
        const row = requests.find(row => url.pathname.includes(`/${row.id}/`))!;
        row.status = "completed";
        return send(row);
      }
      switch (url.pathname) {
        case "/api/admin/fund-requests": return send(requests);
        case "/api/auth/session-user": return send(user);
        case "/api/auth/blocked-status": return send({ isBlocked: false });
        case "/api/onboarding": return send({ required: false, completed: true });
        case "/api/user/currency-preference": return send({ currency: "USD" });
        case "/api/payment-visibility": return send([]);
        default: return send({});
      }
    });
    await page.goto("http://127.0.0.1:5000/admin/fund-requests");
    for (const method of methods) {
      await page.getByText(`Fixture ${method}`, { exact: true }).click();
      await page.getByTestId(`fund-credit-fixture-${method}`).click();
      const confirm = page.getByTestId("fund-action-confirm");
      assert.equal(await confirm.isDisabled(), true);
      assert.equal(await page.getByTestId("fund-received-amount").inputValue(), "");
      assert.equal(await page.getByTestId("fund-receipt-reference").inputValue(), "");
      await page.getByTestId("fund-received-amount").fill("9.99");
      await page.getByTestId("fund-receipt-reference").fill(`RECEIVED-${method}`);
      await page.getByTestId("fund-receipt-verified").click();
      assert.equal(await confirm.isDisabled(), true, "insufficient actual receipt cannot credit");
      await page.getByTestId("fund-received-amount").fill("10.50");
      assert.equal(await page.getByTestId("fund-receipt-verified").getAttribute("data-state"), "unchecked", "changing evidence resets attestation");
      await page.getByTestId("fund-receipt-verified").click();
      assert.equal(await confirm.isEnabled(), true);
      if (method === "bank_transfer") {
        assert.equal(await page.getByTestId("fund-received-amount").evaluate(element => getComputedStyle(element).backgroundColor), "rgb(255, 255, 255)", "receipt values remain readable under the global theme overrides");
        await page.screenshot({ path: "/tmp/fund-request-admin-verified.png" });
        duplicate = true;
        await confirm.click();
        await page.getByTestId("fund-action-error").waitFor();
        assert.match(await page.getByTestId("fund-action-error").innerText(), /already used/);
        duplicate = false;
        await page.getByTestId("fund-receipt-reference").fill("RECEIVED-UNIQUE");
        await page.getByTestId("fund-receipt-verified").click();
      }
      await confirm.click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      const body = submitted.at(-1);
      assert.equal(body.receivedAmount, "10.50");
      assert.equal(body.bankReceiptVerified, true);
      assert.match(body.bankTransactionReference, /^RECEIVED-/);
    }
    await page.getByText("Fixture paid PayPal", { exact: true }).click();
    assert.equal(await page.getByTestId("fund-credit-paid-paypal").count(), 0);
    await page.getByText("Fixture provider", { exact: true }).click();
    assert.equal(await page.getByTestId("fund-credit-provider-payment").count(), 0);
    assert.equal(submitted.length, 7, "six credits plus one rejected duplicate attempt");
    // Localized receipt controls and backend duplicate errors, not raw English
    // API strings, in each of the other supported application languages.
    for (const [language, label, duplicateText] of [
      ["fr", "Montant réellement reçu (USD)", "Cette référence de reçu a déjà été utilisée."],
      ["ht", "Montan ou resevwa toutbon (USD)", "Referans resi sa a deja itilize."],
      ["es", "Importe realmente recibido (USD)", "Esta referencia de recibo ya se utilizó."],
    ]) {
      requests[0].status = "pending";
      user.language = language;
      await page.evaluate(({ language, user }) => {
        localStorage.setItem("i18nextLng", language);
        localStorage.setItem("buyfast_language", language);
        localStorage.setItem("buyfast_session_user", JSON.stringify({ data: user }));
      }, { language, user });
      await page.goto(`http://127.0.0.1:5000/admin/fund-requests?lang=${language}`);
      await page.getByText("Fixture bank_transfer", { exact: true }).click();
      await page.getByTestId("fund-credit-fixture-bank_transfer").click();
      await page.getByLabel(label, { exact: true }).fill("10");
      await page.getByTestId("fund-receipt-reference").fill("EXISTING-RECEIPT");
      await page.getByTestId("fund-receipt-verified").click();
      duplicate = true;
      await page.getByTestId("fund-action-confirm").click();
      await page.getByTestId("fund-action-error").waitFor();
      assert.ok((await page.getByTestId("fund-action-error").innerText()).includes(duplicateText));
      await page.getByTestId("fund-action-cancel").click();
      await page.getByTestId("fund-credit-fixture-bank_transfer").click();
      assert.equal(await page.getByTestId("fund-received-amount").inputValue(), "");
      assert.equal(await page.getByTestId("fund-action-confirm").isDisabled(), true);
      await page.getByTestId("fund-action-cancel").click();
    }
    await context.close();
  } finally {
    await browser.close();
  }
});