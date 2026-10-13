import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { BASE_NETWORK_LOGO, OPTIMISM_NETWORK_LOGO, LINEA_NETWORK_LOGO, safeCryptoLogoUrl } from '../shared/cryptoLogos';

// Already-running preview only. All APIs are intercepted; only verified brand
// image GETs reach external hosts, exercising real image loading under the CSP.
// no provider payments, payouts, credits, or real customer records are touched.
test('deposit selector shows new exact assets/networks and fails closed on discovery errors', { timeout: 120_000 }, async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/repl/tools/bin/chromium',
    headless: true, args: ['--no-sandbox'],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const imageFailures: string[] = [];
    page.on('requestfailed', request => {
      if (request.resourceType() === 'image' && safeCryptoLogoUrl(request.url()))
        imageFailures.push(`${request.url()}: ${request.failure()?.errorText}`);
    });
    page.on('response', response => {
      if (response.request().resourceType() === 'image' && safeCryptoLogoUrl(response.url()) && response.status() >= 400)
        imageFailures.push(`${response.url()}: HTTP ${response.status()}`);
    });
    const user = { id: 'nowpayments-browser-fixture', email: 'fixture@example.invalid',
      firstName: 'Fixture', isActive: true, isBlocked: false, emailVerified: true };
    await context.addInitScript(user => {
      localStorage.setItem('buyfast_session_user', JSON.stringify({ data: user }));
      localStorage.setItem('i18nextLng', 'en');
      localStorage.setItem('promo_last_shown', String(Date.now()));
      localStorage.setItem('buyfast_notif_banner_dismissed', JSON.stringify({ ts: Date.now() }));
    }, user);
    let failure = false;
    let paymentCode = '';
    let showFixtureDialog = false;
    const currencies = [
      { code: 'btc', name: 'Bitcoin', ticker: 'BTC', network: 'btc', networkName: 'Bitcoin', logoUrl: '/images/coins/btc.svg', networkLogoUrl: '/images/coins/btc.svg' },
      { code: 'ltc', name: 'Litecoin', ticker: 'LTC', network: 'ltc', networkName: 'Litecoin', logoUrl: '/images/coins/ltc.svg', networkLogoUrl: '/images/coins/ltc.svg' },
      { code: 'usdcbase', name: 'USD Coin (Base)', ticker: 'USDC', network: 'base', networkName: 'Base', logoUrl: '/images/coins/usdcbase.svg', networkLogoUrl: BASE_NETWORK_LOGO },
      { code: 'usdtmatic', name: 'Tether USD (Polygon)', ticker: 'USDT', network: 'matic', networkName: 'Polygon', logoUrl: '/images/coins/usdtmatic.svg', networkLogoUrl: '/images/coins/matic.svg' },
      { code: 'usdcop', name: 'USD Coin (Optimism)', ticker: 'USDC', network: 'op', networkName: 'Optimism', logoUrl: '/images/coins/usdcop.svg', networkLogoUrl: OPTIMISM_NETWORK_LOGO },
      { code: 'ethlna', name: 'Ethereum (Linea)', ticker: 'ETH', network: 'lna', networkName: 'Linea', logoUrl: '/images/coins/ethlna.svg', networkLogoUrl: LINEA_NETWORK_LOGO },
      { code: 'broken', name: 'Fixture broken image', ticker: 'TEST', network: 'btc', networkName: 'Bitcoin', logoUrl: '/images/coins/fixture-broken.svg', networkLogoUrl: null },
    ];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      // Read-only real brand images only; all provider APIs remain blocked.
      if (url.href === 'https://nowpayments.io/images/coins/fixture-broken.svg') return route.abort();
      if (route.request().method() === 'GET' && route.request().resourceType() === 'image' &&
          safeCryptoLogoUrl(url.href)) return route.continue();
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const send = (json: unknown, status = 200) => route.fulfill({ json, status });
      switch (url.pathname) {
        case '/api/auth/session-user': return send(user);
        case '/api/auth/blocked-status': return send({ isBlocked: false });
        case '/api/onboarding': return send({ required: false, completed: true });
        case '/api/payment-visibility': return send([]);
        case '/api/user/currency-preference': return send({ currency: 'USD' });
        case '/api/exchange-rates': return send({ rates: [{ currencyCode: 'USD', rateToUSD: 1 }] });
        case '/api/calculate-fee': return send({ fee: 0.5, feeValue: 5, feeType: 'percentage' });
        case '/api/crypto/currencies': return failure
          ? send({ success: false, error: 'Discovery unavailable' }, 503)
          : send({ success: true, currencies, excluded: [] });
        case '/api/crypto/create-payment':
          paymentCode = route.request().postDataJSON().payCurrency;
          if (showFixtureDialog) return send({ paymentId: 'TEST_ONLY', payAddress: 'TEST_ONLY_NOT_A_REAL_DEPOSIT_ADDRESS',
            payAmount: 25.5, payCurrency: paymentCode, priceAmount: 25.5, orderId: 'TEST_ONLY', expiresAt: '' });
          return send({ error: 'Fixture deliberately blocks payment creation' }, 400);
        default: return send({});
      }
    });
    await page.goto('http://127.0.0.1:5000/add-funds');
    await page.getByTestId('button-amount-25.00').click();
    await page.locator('#add-funds-terms-acceptance').click();
    await page.getByTestId('button-crypto-payment').click();
    await page.getByTestId('crypto-currency-usdcbase').waitFor();
    assert.equal(await page.getByTestId('crypto-currency-ltc').count(), 1);
    assert.equal(await page.getByTestId('crypto-currency-usdtpolygon').count(), 0);
    const checkLogos = async () => {
      for (const code of ['btc', 'ltc', 'usdcbase', 'usdtmatic', 'usdcop', 'ethlna']) {
        const images = page.getByTestId(`crypto-currency-${code}`).locator('img');
        assert.equal(await images.count(), 2, `${code}: ${imageFailures.join('; ')} ${await page.getByTestId(`crypto-currency-${code}`).innerText()}`);
        for (const img of await images.all()) {
          await img.evaluate(image => image.decode());
          assert.equal(await img.evaluate(image => image.naturalWidth > 0 && image.naturalHeight > 0), true);
        }
      }
      const broken = page.getByTestId('crypto-currency-broken');
      await broken.getByRole('img', { name: 'TEST coin logo unavailable' }).waitFor();
      assert.equal(await broken.isEnabled(), true);
      assert.match(await broken.innerText(), /Bitcoin/);
    };
    await checkLogos();
    const assertOpaqueSelector = async () => {
      const styles = await page.locator('#add-funds-crypto-overlay').evaluate(overlay => {
        const panel = overlay.querySelector('.crypto-selector-panel')!;
        const header = overlay.querySelector('.crypto-selector-header')!;
        return {
          portal: overlay.parentElement === document.body,
          overlayBackground: getComputedStyle(overlay).backgroundColor,
          zIndex: getComputedStyle(overlay).zIndex,
          panelBackground: getComputedStyle(panel).backgroundColor,
          headerBackground: getComputedStyle(header).backgroundColor,
          panelOpacity: getComputedStyle(panel).opacity,
          headerOpacity: getComputedStyle(header).opacity,
        };
      });
      assert.deepEqual(styles, {
        portal: true, overlayBackground: 'rgba(0, 0, 0, 0.6)', zIndex: '10000',
        panelBackground: 'rgb(255, 255, 255)', headerBackground: 'rgb(255, 255, 255)',
        panelOpacity: '1', headerOpacity: '1',
      });
    };
    await assertOpaqueSelector();
    await page.screenshot({ path: '/tmp/nowpayments-selector-fixture.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await checkLogos();
    await page.screenshot({ path: '/tmp/nowpayments-selector-mobile-logos.png' });
    await page.getByTestId('crypto-currency-ethlna').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/nowpayments-linea-optimism-mobile-logos.png' });
    await page.getByTestId('crypto-currency-usdcbase').click();
    await page.waitForFunction(() => document.body.innerText.includes('Payment Failed'));
    assert.equal(paymentCode, 'usdcbase');
    await page.getByTestId('button-crypto-payment').click();
    failure = true;
    await page.getByRole('button', { name: 'Refresh currencies' }).click();
    await page.getByRole('alert').filter({ hasText: 'Unable to load enabled cryptocurrencies' }).waitFor();
    assert.equal(await page.getByTestId('crypto-currency-usdcbase').count(), 0);
    await assertOpaqueSelector();
    await page.screenshot({ path: '/tmp/nowpayments-selector-error.png' });
    failure = false;
    showFixtureDialog = true;
    await page.getByRole('button', { name: 'Refresh currencies' }).click();
    await page.getByTestId('crypto-currency-usdtmatic').click();
    await page.getByTestId('crypto-deposit-logos').waitFor();
    for (const img of await page.getByTestId('crypto-deposit-logos').locator('img').all()) {
      await img.evaluate(image => image.decode());
    }
    assert.equal(await page.getByTestId('crypto-deposit-logos').locator('img').count(), 2);
    assert.equal(await page.getByRole('dialog', { name: 'Crypto deposit instructions' }).evaluate(el =>
      getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
    assert.equal(paymentCode, 'usdtmatic');
    await page.screenshot({ path: '/tmp/nowpayments-deposit-mobile-logos.png' });
  } finally {
    await browser.close();
  }
});