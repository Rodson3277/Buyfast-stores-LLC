import { expect, test, type Page } from "@playwright/test";

const user = {
  id: "kyc-browser-fixture",
  email: "kyc-fixture@example.invalid",
  firstName: "Browser",
  lastName: "Fixture",
  emailVerified: true,
  isActive: true,
  isBlocked: false,
  isAdmin: false,
  isSuperAdmin: false,
  hasPlayedWelcomeBox: true,
};

type KycState = {
  kycStatus: string;
  documentVerified: boolean;
  diditSessionId?: string;
  diditStatus?: string;
  rejectionReason?: string;
  rejectionCode?: string;
  lastKycAttempt?: { verificationStatus: string; rejectionReason?: string };
  level?: string;
  transactionLimits?: { daily: number; monthly: number; perTransaction: number };
};

async function setup(page: Page, initial: KycState) {
  let state = initial;
  let createCalls = 0;

  await page.addInitScript(() => {
    localStorage.setItem("promo_last_shown", String(Date.now()));
    localStorage.setItem("buyfast_notif_banner_dismissed", JSON.stringify({ ts: Date.now() }));
    localStorage.setItem("i18nextLng", "en");
  });

  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ status, json });

    if (path === "/api/auth/session-user" || path === "/api/auth/user") return send(user);
    if (path === "/api/auth/blocked-status") return send({ isBlocked: false });
    if (path === "/api/onboarding") return send({ required: false, completed: true });
    if (path === "/api/kyc/status") return send(state);
    if (path === "/api/didit/create-session" && request.method() === "POST") {
      createCalls++;
      return send({ sessionUrl: `${new URL(request.url()).origin}/fake-didit-hosted-flow` });
    }
    return send({});
  });

  return {
    createCalls: () => createCalls,
    setState: (next: KycState) => { state = next; },
  };
}

test("hosted-flow callback is navigation only and never prematurely approves or redirects", async ({ page }) => {
  await setup(page, {
    kycStatus: "pending",
    documentVerified: false,
    diditSessionId: "session-incomplete",
    diditStatus: "In Progress",
  });
  await page.addInitScript(() => sessionStorage.setItem("kycReturnTo", "/wallet"));

  await page.goto("/kyc?didit_return=1&status=completed&lang=en");

  await expect(page).toHaveURL(/\/kyc$/);
  await expect(page.getByText("Verification is not complete.")).toBeVisible();
  await expect(page.getByText(/you are not yet approved/i)).toHaveCount(0);
  await expect(page.getByText(/identity verified/i)).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("kycReturnTo"))).toBe("/wallet");
});

test("provider review is shown as waiting, not approval", async ({ page }) => {
  await setup(page, {
    kycStatus: "pending_review",
    documentVerified: false,
    diditSessionId: "session-review",
    diditStatus: "In Review",
  });

  await page.goto("/kyc?lang=en");

  await expect(page.getByText(/Didit is reviewing your verification/i)).toBeVisible();
  await expect(page.getByText(/you are not yet approved/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Restart with Didit" })).toHaveCount(0);
});

test("verified provider decision renders verified access", async ({ page }) => {
  await setup(page, {
    kycStatus: "verified",
    documentVerified: true,
    diditSessionId: "session-approved",
    diditStatus: "Approved",
    level: "verified",
    transactionLimits: { daily: 1000, monthly: 5000, perTransaction: 500 },
  });

  await page.goto("/kyc?lang=en");

  await expect(page.getByRole("heading", { name: "KYC Verification Complete" })).toBeVisible();
  await expect(page.getByText(/access all money transfer services/i)).toBeVisible();
  await page.screenshot({ path: "/tmp/kyc-verified-browser.jpg", fullPage: true });
});

test("decline remains retryable and starts a fresh hosted flow", async ({ page }) => {
  const fixture = await setup(page, {
    kycStatus: "rejected",
    documentVerified: false,
    diditSessionId: "session-declined",
    diditStatus: "Declined",
    rejectionReason: "Document could not be verified",
  });

  await page.goto("/kyc?lang=en");
  const retry = page.getByRole("button", { name: /submit new documents/i });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page).toHaveURL(/\/fake-didit-hosted-flow$/);
  expect(fixture.createCalls()).toBe(1);
});

test("incomplete attempt offers restart without claiming review or approval", async ({ page }) => {
  const fixture = await setup(page, {
    kycStatus: "pending",
    documentVerified: false,
    diditSessionId: "session-abandoned-browser",
    diditStatus: "Not Started",
  });

  await page.goto("/kyc?lang=en");
  await expect(page.getByText(/Verification is not complete/i)).toBeVisible();
  const restart = page.getByRole("button", { name: "Restart with Didit" });
  await expect(restart).toBeVisible();
  await restart.click();
  await expect(page).toHaveURL(/\/fake-didit-hosted-flow$/);
  expect(fixture.createCalls()).toBe(1);
});

for (const providerStatus of ["Approved", "In Review"]) {
  test(`name mismatch with provider ${providerStatus} shows correction and retry, not review`, async ({ page }) => {
    const fixture = await setup(page, {
      // Exercise a legacy stale user status with authoritative attempt rejection.
      kycStatus: "pending_review",
      documentVerified: false,
      diditSessionId: "session-name-mismatch",
      diditStatus: providerStatus,
      rejectionCode: "name_mismatch",
      lastKycAttempt: {
        verificationStatus: "rejected",
        rejectionReason: "Name on ID document does not match the name registered on this account.",
      },
    });
    await page.goto("/kyc?lang=en");
    await expect(page.getByText(/The name on your ID does not match your account name/)).toBeVisible();
    await expect(page.getByText(/Didit is reviewing|document name is unavailable/)).toHaveCount(0);
    const correct = page.getByRole("button", { name: "Correct my account name" });
    await expect(correct).toBeVisible();
    await correct.click();
    await expect(page).toHaveURL(/\/profile(?:\?lang=en)?$/);
    await page.goto("/kyc?lang=en");
    await page.getByRole("button", { name: /submit new documents/i }).click();
    await expect(page).toHaveURL(/\/fake-didit-hosted-flow$/);
    expect(fixture.createCalls()).toBe(1);
  });
}

test("missing document name remains unverified without a false mismatch", async ({ page }) => {
  await setup(page, {
    kycStatus: "pending_review", documentVerified: false,
    diditSessionId: "session-no-name", diditStatus: "Approved",
  });
  await page.goto("/kyc?lang=en");
  await expect(page.getByText(/document name is unavailable/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Correct my account name" })).toHaveCount(0);
});

test("Haitian Creole mismatch gives a localized correction and retry", async ({ page }) => {
  await setup(page, {
    kycStatus: "rejected", documentVerified: false,
    diditSessionId: "session-ht-mismatch", diditStatus: "Approved",
    rejectionCode: "name_mismatch",
    rejectionReason: "Name on ID document does not match the name registered on this account.",
  });
  await page.goto("/kyc?lang=ht");
  await expect(page.getByText(/Non sou pyès idantite w la pa matche/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Korije non kont mwen" })).toBeVisible();
  await page.screenshot({ path: "/tmp/kyc-name-mismatch-ht.jpg", fullPage: true });
});