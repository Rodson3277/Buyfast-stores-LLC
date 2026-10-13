import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';

// Already-running preview, synthetic authenticated session. All API calls are
// fulfilled locally and all external requests aborted (including Firebase).
test('mobile admin wallet gift-card verification is readable and never exposes legacy actions', { timeout: 120000 }, async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/repl/tools/bin/chromium',
    headless: true, args: ['--no-sandbox'],
  });
  mkdirSync('screenshots/giftcard-review', { recursive: true });
  try {
    for (const [language, outcome] of [['ht', 'pending'], ['ht', 'completed'], ['ht', 'refunded'], ['en', 'pending']]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      const copy = JSON.parse(readFileSync(`client/src/locales/${language}.json`, 'utf8')).walletGiftCardReview;
      const user = { id: 'fixture-admin', email: 'admin@example.invalid', firstName: 'Fixture',
        isAdmin: true, isOwner: true, isActive: true, isBlocked: false, emailVerified: true };
      const order = { id: 'fixture-wallet-giftcard', userId: 'fixture-customer', transactionType: 'gift_card',
        productName: 'Gift Card', recipientEmail: 'customer@example.invalid', recipientPhone: 'customer@example.invalid',
        amount: '3.00', fee: '0.00', status: 'processing', createdAt: '2026-09-24T12:00:00Z',
        customIdentifier: 'fixture-exact-reference', metadata: { paymentMethod: 'wallet', walletDebited: true, provider: 'reloadly', autoRefunded: false } };
      await context.addInitScript(({ user, language }) => {
        localStorage.setItem('buyfast_session_user', JSON.stringify({ data: user }));
        localStorage.setItem('buyfast_language', language);
        localStorage.setItem('i18nextLng', language);
        localStorage.setItem('promo_last_shown', String(Date.now()));
        localStorage.setItem('buyfast_notif_banner_dismissed', JSON.stringify({ ts: Date.now() }));
      }, { user, language });
      let verified = 0;
      const writes: string[] = [];
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
        if (!url.pathname.startsWith('/api/')) {
          if (request.method() !== 'GET') return route.abort();
          return route.continue();
        }
        if (request.method() !== 'GET') writes.push(url.pathname);
        const send = (json: unknown) => route.fulfill({ json });
        switch (url.pathname) {
          case '/api/auth/session-user': return send(user);
          case '/api/auth/admin-otp-status': return send({ otpVerified: true });
          case '/api/auth/blocked-status': return send({ isBlocked: false });
          case '/api/onboarding': return send({ required: false, completed: true });
          case '/api/payment-visibility': return send([]);
          case '/api/user/currency-preference': return send({ currency: 'USD' });
          case '/api/exchange-rates': return send({ rates: [{ currencyCode: 'USD', rateToUSD: 1 }] });
          case '/api/admin/kyc-verified-users': return send({ verifiedUserIds: ['fixture-customer'] });
          case '/api/admin/transactions': return send({ transactions: [order], pagination: { total: 1, totalPages: 1, page: 1 } });
          case '/api/admin/giftcards/fixture-wallet-giftcard/verify-provider':
            assert.equal(request.method(), 'POST');
            verified++;
            order.status = outcome === 'completed' ? 'completed' : outcome === 'refunded' ? 'failed' : 'processing';
            order.metadata.autoRefunded = outcome === 'refunded';
            return send({ outcome, status: order.status });
          default: return send({});
        }
      });
      await page.goto(`http://127.0.0.1:5000/admin/transactions-simple?lang=${language}`);
      const card = page.locator('.transaction-card-mobile');
      await expect(card).toContainText('$3.00');
      await expect(card).toContainText(copy.pending);
      for (const action of ['complete', 'fail', 'retry', 'refund']) {
        assert.equal(await page.getByTestId(`button-${action}-${order.id}`).count(), 0, `legacy ${action} must not exist`);
      }
      const verify = card.getByTestId(`button-verify-provider-${order.id}`);
      await expect(verify).toHaveText(copy.verify);
      await verify.scrollIntoViewIfNeeded();
      if (language === 'ht' && outcome === 'pending') await page.screenshot({ path: 'screenshots/giftcard-review/mobile-processing-ht.png' });
      await verify.click();
      const toast = page.locator('[data-state="open"][data-swipe-direction]');
      await expect(toast).toContainText(copy[outcome]);
      await expect(card).toContainText(copy[outcome]);
      assert.equal(verified, 1);
      assert.equal(writes.filter(path => /giftcards|transactions/.test(path)).length, 1);
      const toastText = await toast.innerText();
      assert.doesNotMatch(toastText, /WALLET_GIFTCARD|409|\{"|transactionId/);
      if (outcome === 'pending') {
        await expect(card).toContainText('processing');
        await expect(verify).toBeEnabled();
        assert.ok(!toastText.includes(copy.completed) && !toastText.includes(copy.refunded));
      } else {
        await expect(verify).toHaveCount(0);
      }
      await page.waitForTimeout(400); // finish toast entrance animation
      const bounds = await toast.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391 && bounds.y >= 0 && bounds.y + bounds.height <= 845);
      const overflow = await toast.evaluate(element => element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight);
      assert.equal(overflow, false, 'toast content must not be clipped');
      await page.screenshot({ path: `screenshots/giftcard-review/mobile-${outcome}-${language}.png` });
      await context.close();
    }
  } finally { await browser.close(); }
});