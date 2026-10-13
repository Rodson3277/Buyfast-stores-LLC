import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

test('manual cancellation dialog requires evidence, uses authoritative quote and submits once in four languages', { timeout: 120000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/repl/tools/bin/chromium', headless: true, args: ['--no-sandbox'] });
  mkdirSync('screenshots/giftcard-review', { recursive: true });
  try {
    for (const action of ['cancel', 'complete']) {
    for (const [language, cancelConfirm, cancelSuccess] of [
      ['en', 'Confirm cancellation and wallet refund', 'Wallet refund completed'],
      ['ht', 'Konfime anilasyon ak ranbousman wallet', 'Ranbousman wallet fèt'],
      ['fr', 'Confirmer l’annulation et le remboursement', 'Portefeuille remboursé'],
      ['es', 'Confirmar cancelación y reembolso', 'Billetera reembolsada'],
    ]) {
      const completion = {
        en: ['Confirm delivered and complete', 'Gift card marked completed'],
        ht: ['Konfime livrezon epi konplete', 'Gift card make konplete'],
        fr: ['Confirmer la livraison et terminer', 'Carte cadeau marquée terminée'],
        es: ['Confirmar entrega y completar', 'Tarjeta marcada como completada'],
      }[language]!;
      const confirm = action === 'complete' ? completion[0] : cancelConfirm;
      const success = action === 'complete' ? completion[1] : cancelSuccess;
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      const user = { id: 'fixture-admin', email: 'admin@example.invalid', firstName: 'Fixture', isAdmin: true, isOwner: true, isActive: true, isBlocked: false, emailVerified: true };
      const order: any = { id: 'fixture-wallet-giftcard', userId: 'fixture-customer', transactionType: 'gift_card', productName: 'Gift Card',
        recipientEmail: 'customer@example.invalid', amount: '3.00', fee: '0.00', status: 'processing', createdAt: '2026-09-24T12:00:00Z',
        metadata: { paymentMethod: 'wallet', walletDebited: true, provider: 'reloadly', chargedTotal: '999.000000' } };
      await context.addInitScript(({ user, language }) => {
        localStorage.setItem('buyfast_session_user', JSON.stringify({ data: user }));
        localStorage.setItem('buyfast_language', language);
        localStorage.setItem('i18nextLng', language);
        localStorage.setItem('promo_last_shown', String(Date.now()));
        localStorage.setItem('buyfast_notif_banner_dismissed', JSON.stringify({ ts: Date.now() }));
      }, { user, language });
      let posts = 0;
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
        if (!url.pathname.startsWith('/api/')) return request.method() === 'GET' ? route.continue() : route.abort();
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
          case `/api/admin/giftcards/fixture-wallet-giftcard/manual-${action}-quote`:
            assert.equal(request.method(), 'GET');
            return send({ refundableAmount: '3.250000' });
          case `/api/admin/giftcards/fixture-wallet-giftcard/manual-${action}`:
            assert.equal(request.method(), 'POST');
            posts++;
            assert.deepEqual(request.postDataJSON(), { reason: 'Administrator verified delivery status', [action === 'complete' ? 'deliveryAttested' : 'nonDeliveryAttested']: true });
            await new Promise(resolve => setTimeout(resolve, 400));
            order.status = action === 'complete' ? 'completed' : 'cancelled';
            order.metadata[action === 'complete' ? 'manualCompletion' : 'manualCancellation'] = { actorId: 'fixture-admin' };
            order.metadata.walletRefunded = action === 'cancel';
            return send({ status: order.status, ...(action === 'cancel' ? { refundedAmount: '3.250000' } : {}) });
          default: return send({});
        }
      });
      await page.goto(`http://127.0.0.1:5000/admin/transactions-simple?lang=${language}`);
      const card = page.locator('.transaction-card-mobile');
      await card.getByTestId(`button-manual-${action}-${order.id}`).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('$3.250000');
      await expect(dialog).not.toContainText('999');
      const submit = dialog.getByRole('button', { name: confirm, exact: true });
      await expect(submit).toBeDisabled();
      await dialog.getByRole('textbox').fill('short');
      await dialog.getByRole('checkbox').check();
      await expect(submit).toBeDisabled();
      await dialog.getByRole('textbox').fill('Administrator verified delivery status');
      await dialog.getByRole('checkbox').uncheck();
      await expect(submit).toBeDisabled();
      assert.equal(posts, 0);
      await dialog.getByRole('checkbox').check();
      await expect(submit).toBeEnabled();
      await page.screenshot({ path: `screenshots/giftcard-review/manual-${action}-dialog-${language}.png` });
      await submit.click();
      await expect(submit).toBeDisabled();
      await expect(dialog).toHaveCount(0);
      const toast = page.locator('[data-state="open"][data-swipe-direction]');
      await expect(toast).toContainText(success);
      if (action === 'cancel') await expect(toast).toContainText('$3.250000');
      await expect(card).toContainText(success);
      await expect(card.getByTestId(`button-manual-cancel-${order.id}`)).toHaveCount(0);
      await expect(card.getByTestId(`button-manual-complete-${order.id}`)).toHaveCount(0);
      await expect(card.getByTestId(`button-verify-provider-${order.id}`)).toHaveCount(0);
      assert.equal(posts, 1);
      await context.close();
    }
    }
  } finally { await browser.close(); }
});