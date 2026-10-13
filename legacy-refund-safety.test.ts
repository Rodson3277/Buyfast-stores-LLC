import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import vm from 'node:vm';

const source = readFileSync('server/routes.ts', 'utf8');
const body = source.slice(source.indexOf('  async function provenWalletDebit('),
  source.indexOf('  // Email verification routes (public)'));
function harness(ledger: any[], balance = 7) {
  const calls: number[] = [];
  const context = {
    walletTransactions: {}, transactions: {}, and: (...x: any[]) => x, or: (...x: any[]) => x,
    eq: (...x: any[]) => x, sql: (...x: any[]) => x,
    refundCreditInTx: async (_tx: any, _user: string, amount: number) => {
      calls.push(amount);
      const before = balance;
      balance = Math.round((balance + amount) * 1e6) / 1e6;
      return { balanceBefore: before, balanceAfter: balance };
    },
  };
  const api = vm.runInNewContext(transformSync(`${body}\n({refundProvenWalletDebit, assertLegacyOrderPreDelivery});`, { loader: 'ts' }).code, context);
  const tx = { select: () => ({ from: () => ({ where: async () => ledger }) }) };
  return { refund: () => api.refundProvenWalletDebit(tx, 'user', 'order', 'test'), calls, api };
}
const debit = { type: 'debit', amount: '3.123456', balanceBefore: '10.123456', balanceAfter: '7' };

test('refund uses exact debit delta, independent of inconsistent legacy pools', async () => {
  const h = harness([debit]);
  assert.equal((await h.refund()).balanceAfter, 10.123456);
  assert.deepEqual(h.calls, [3.123456]);
});
test('missing or duplicate debit evidence fails closed', async () => {
  for (const ledger of [[], [debit, debit]]) {
    const h = harness(ledger);
    await assert.rejects(h.refund(), /WALLET_DEBIT_EVIDENCE_REQUIRED/);
    assert.equal(h.calls.length, 0);
  }
});
test('prior refund blocks repeated credit', async () => {
  const h = harness([debit, { type: 'credit' }]);
  await assert.rejects(h.refund(), /WALLET_ALREADY_REFUNDED/);
  assert.equal(h.calls.length, 0);
});
test('ledger amount must equal stored balance delta', async () => {
  const h = harness([{ ...debit, balanceAfter: '20' }]);
  await assert.rejects(h.refund(), /WALLET_DEBIT_EVIDENCE_INVALID/);
});
test('unknown delivery and provider identifiers require reconciliation', () => {
  const { api } = harness([]);
  for (const order of [{ productId: 1, customIdentifier: 'provider-order' }, { metadata: { errorMessage: 'timeout' } }, { reloadlyTransactionId: '123' }]) {
    assert.throws(() => api.assertLegacyOrderPreDelivery(order), /PROVIDER_RECONCILIATION_REQUIRED/);
  }
  api.assertLegacyOrderPreDelivery({ type: 'topup', paymentMethod: 'moncash', metadata: {} });
});

function settlementHarness(orderInput: any, ledgerInput = [debit], sourceResult: any = { refunded: true, refundMethod: 'paypal', newBalance: null }, failCredit = false) {
  let order = structuredClone(orderInput);
  let ledger = structuredClone(ledgerInput);
  let balance = 7;
  let sourceCalls = 0;
  const tables = { transactions: {}, billTransactions: {}, giftCardTransactions: {}, walletTransactions: {} };
  const query = (value: any) => ({ then: (resolve: any) => Promise.resolve(value).then(resolve), for: async () => value });
  const tx: any = {
    select: () => ({ from: (table: any) => ({ where: () => query(table === tables.walletTransactions ? ledger : [structuredClone(order)]) }) }),
    update: () => ({ set: (changes: any) => ({ where: () => {
      order = { ...order, ...changes };
      return { ...query([order]), returning: async () => [order] };
    } }) }),
  };
  let queue = Promise.resolve();
  const db = { ...tx, transaction: (fn: any) => {
    const run = queue.then(async () => {
      const snapshot = structuredClone({ order, ledger, balance });
      try { return await fn(tx); } catch (error) { ({ order, ledger, balance } = snapshot); throw error; }
    });
    queue = run.catch(() => {});
    return run;
  } };
  const context = {
    ...tables, db, and: (...x: any[]) => x, or: (...x: any[]) => x, eq: (...x: any[]) => x, sql: (...x: any[]) => x,
    storage: { getUser: async () => ({ isAdmin: true }) }, isUserDiditVerified: async () => true,
    blockLegacyWalletGiftCardAction: () => false,
    verifyPayPalCaptured: async () => ({ ok: true, capturedAmount: 3.5 }),
    performSourceRefund: async () => { sourceCalls++; return sourceResult; },
    refundCreditInTx: async (_tx: any, _user: any, amount: number) => {
      if (failCredit) throw new Error('LEDGER_INSERT_FAILED');
      const before = balance;
      balance = Math.round((balance + amount) * 1e6) / 1e6;
      ledger.push({ type: 'refund', amount: String(amount), balanceBefore: String(before), balanceAfter: String(balance) });
      return { balanceBefore: before, balanceAfter: balance };
    },
  };
  const api = vm.runInNewContext(transformSync(`${body}\n({safeLegacyAdminSettlement, claimLegacyRetry});`, { loader: 'ts' }).code, context);
  async function settle(status: string, kind = 'topup') {
    let result: any;
    let code = 200;
    const res: any = { status: (value: number) => { code = value; return res; }, json: (value: any) => { result = value; return res; } };
    await api.safeLegacyAdminSettlement(kind, status)({ verifiedUser: { uid: 'admin' }, params: { id: 'order' }, body: { reason: 'Delivered manually and verified' } }, res);
    return { code, result };
  }
  return { settle, retry: () => api.claimLegacyRetry(tables.transactions, 'order'), state: () => ({ order, ledger, balance, sourceCalls }) };
}
const pendingOrder = { id: 'order', type: 'topup', userId: 'user', status: 'pending', amount: '3.123456', paymentMethod: 'wallet', metadata: {} };
test('manual funded pending completion needs no synthetic marker', async () => {
  const h = settlementHarness(pendingOrder);
  assert.equal((await h.settle('completed')).code, 200);
  assert.equal(h.state().order.status, 'completed');
  assert.equal(h.state().ledger.length, 1);
});
test('manual external mark-failed is allowed without wallet credit', async () => {
  const h = settlementHarness({ ...pendingOrder, paymentMethod: 'moncash' });
  assert.equal((await h.settle('failed')).code, 200);
  assert.equal(h.state().balance, 7);
});
test('manual pending external completion uses existing payment method, not invented metadata', async () => {
  const h = settlementHarness({ ...pendingOrder, paymentMethod: 'moncash' });
  assert.equal((await h.settle('completed')).code, 200);
  assert.equal(h.state().order.status, 'completed');
  assert.equal(h.state().balance, 7);
});
test('refund ledger failure leaves pending state and balance unchanged', async () => {
  const h = settlementHarness(pendingOrder, [debit], undefined, true);
  assert.equal((await h.settle('failed')).code, 409);
  assert.equal(h.state().order.status, 'pending');
  assert.equal(h.state().balance, 7);
  assert.equal(h.state().ledger.length, 1);
});
test('manual gift card without provider linkage can complete; Reloadly product cannot', async () => {
  const manual = settlementHarness({ ...pendingOrder, productId: 0 });
  assert.equal((await manual.settle('completed', 'giftcard')).code, 200);
  const provider = settlementHarness({ ...pendingOrder, productId: 123 });
  assert.equal((await provider.settle('completed', 'giftcard')).code, 409);
});
test('PayPal bill failure uses verified source refund instead of blocking every external', async () => {
  const h = settlementHarness({ ...pendingOrder, paymentMethod: undefined, metadata: { paymentMethod: 'paypal', paypalOrderId: 'paid-order' } });
  assert.equal((await h.settle('failed', 'bill')).code, 200);
  assert.equal(h.state().sourceCalls, 1);
  assert.equal(h.state().order.status, 'failed');
  assert.equal(h.state().balance, 7);
});
test('concurrent admin failure/refund produce exactly one credit', async () => {
  const h = settlementHarness(pendingOrder);
  const results = await Promise.all([h.settle('failed'), h.settle('refunded')]);
  assert.deepEqual(results.map(x => x.code).sort(), [200, 409]);
  assert.equal(h.state().ledger.length, 2);
  assert.equal(h.state().balance, 10.123456);
});
test('verified PayPal source refund retained and repeats never resend it', async () => {
  const h = settlementHarness({ ...pendingOrder, paymentMethod: 'paypal', metadata: { paypalOrderId: 'pp' } });
  assert.equal((await h.settle('refunded')).code, 200);
  assert.equal((await h.settle('refunded')).code, 409);
  assert.equal(h.state().sourceCalls, 1);
});
test('indeterminate source refund stays refund_pending and reports not refunded', async () => {
  const h = settlementHarness({ ...pendingOrder, paymentMethod: 'paypal' }, [debit], { refunded: true, refundMethod: 'paypal_pending' });
  const result = await h.settle('refunded');
  assert.equal(result.code, 202);
  assert.equal(result.result.refunded, false);
  assert.equal(h.state().order.status, 'refund_pending');
});
test('retry reuses proven debit and marks uncertainty before provider delivery', async () => {
  const h = settlementHarness(pendingOrder);
  assert.ok(await h.retry());
  assert.equal(h.state().order.status, 'processing');
  assert.equal(h.state().order.metadata.reconciliationRequired, true);
  assert.equal(h.state().ledger.length, 1);
  await assert.rejects(h.retry(), /PROVIDER_RECONCILIATION_REQUIRED/);
});
test('retry blocks prior refund even when legacy caller reopened pending', async () => {
  const h = settlementHarness(pendingOrder, [debit, { ...debit, type: 'refund' }]);
  await assert.rejects(h.retry(), /WALLET_ALREADY_REFUNDED/);
  assert.equal(h.state().order.status, 'pending');
});
test('retry and manual completion cannot bypass an unknown previous provider outcome', async () => {
  const h = settlementHarness({ ...pendingOrder, metadata: { errorMessage: 'Technical error' } });
  await assert.rejects(h.retry(), /PROVIDER_RECONCILIATION_REQUIRED/);
  assert.equal((await h.settle('completed')).code, 409);
  assert.equal(h.state().order.status, 'pending');
});
test('terminal order with valid debit cannot be retried', async () => {
  for (const status of ['completed', 'cancelled', 'refunded', 'refund_pending']) {
    const h = settlementHarness({ ...pendingOrder, status });
    assert.equal(await h.retry(), null);
  }
});
test('all five retry aliases use guarded claim, without post-delivery debits or reopen catches', () => {
  const paths = ['/api/admin/transactions/:id/retry', '/api/admin/bill-transactions/:id/retry', '/api/admin/gift-card-transactions/:id/retry', '/api/admin/retry-bill-payment/:transactionId', '/api/admin/retry-gift-card/:transactionId'];
  for (const path of paths) {
    const start = source.indexOf(`app.post('${path}'`);
    const end = source.indexOf('\n  app.', start + 1);
    const route = source.slice(start, end);
    assert.match(route, /claimLegacyRetry\(/);
    assert.doesNotMatch(route, /storage\.(deductFromCreditPools|deductUserBalance|revertProcessing)/);
  }
});
test('all seven legacy admin settlement endpoints use terminal safe handler', () => {
  const routes = source.split('\n').filter(line => /app.post.*\/api\/admin\/(transactions|bill-transactions|gift-card-transactions)\/:id\/(refund|mark-failed|complete)'/.test(line));
  assert.equal(routes.length, 7);
  assert.ok(routes.every(line => line.includes('safeLegacyAdminSettlement(')));
  assert.equal((source.match(/const r = await refundProvenWalletDebit\(tx, userId, id,/g) || []).length, 3);
});