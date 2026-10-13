import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runWalletGiftCardPurchase } from '../server/services/walletGiftCardPurchase';
import { beginWalletGiftCard, settleWalletGiftCard } from '../server/services/walletGiftCardStore';
import { users, giftCardTransactions, walletTransactions } from '../shared/schema';
import { walletGiftCardLegacyActionConflict, blockLegacyWalletGiftCardAction } from '../server/services/walletGiftCardAdminGate';

const ref = 'GIFT-test-unique';
for (const provider of ['reloadly', 'ding'] as const) {
  const record = (state: string, identifier = ref) => provider === 'ding'
    ? { ProcessingState: state, TransferId: { TransferRef: 'remote-123', DistributorRef: identifier } }
    : { status: state, transactionId: 'remote-123', customIdentifier: identifier };
  const verified = (value: any) => ({ checkable: true, [provider === 'ding' ? 'transfer' : 'order']: value });
  const completed = provider === 'ding' ? 'Completed' : 'SUCCESSFUL';
  const harness = (overrides: any = {}) => {
    const settlements: any[] = [];
    let verifies = 0;
    const options = {
      provider, customIdentifier: ref,
      purchase: async () => { throw new Error('timeout after delivery'); },
      verify: async () => { verifies++; return verified(record(completed)); },
      codes: async () => [{ code: 'test-code' }],
      settle: async (status: string, remote: any, codes: any[]) => {
        settlements.push({ status, remote, codes });
        return { status, reloadlyTransactionId: 'remote-123', giftCodes: codes,
          metadata: status === 'failed' ? { autoRefunded: true, refundedAmount: '12.000000' } : {} };
      },
      ...overrides,
    };
    return { run: () => runWalletGiftCardPurchase(options), settlements, verifies: () => verifies };
  };

  test(`${provider}: timeout recovers exact delivery, reference and codes without refund`, async () => {
    const h = harness();
    const result = await h.run();
    assert.equal(result.status, 'completed');
    assert.equal(result.refunded, false);
    assert.equal(result.transactionId, 'remote-123');
    assert.deepEqual(h.settlements[0].codes, [{ code: 'test-code' }]);
  });

  for (const [name, verification] of [
    ['not found', verified(null)],
    ['check failed', { checkable: false }],
    ['unrelated failure', verified(record('FAILED', 'another-order'))],
    ['unknown state', verified(record('UNRECOGNIZED'))],
    ['missing state', verified(record(''))],
    ['provider still processing', verified(record('PROCESSING'))],
  ] as const) {
    test(`${provider}: ${name} stays processing, never refunds`, async () => {
      const h = harness({ verify: async () => verification });
      const result = await h.run();
      assert.equal(result.status, 'processing');
      assert.equal(result.refunded, false);
      assert.match(result.message!, /not been refunded/);
      assert.equal(h.settlements[0].status, 'processing');
    });
  }
  test(`${provider}: throwing verifier retains processing`, async () => {
    const h = harness({ verify: async () => { throw new Error('verification offline'); } });
    assert.equal((await h.run()).status, 'processing');
  });
  for (const direct of [false, true]) {
    test(`${provider}: explicit FAILED ${direct ? 'API response' : 'verified response'} refunds`, async () => {
      const h = harness(direct
        ? { purchase: async () => provider === 'ding' ? { TransferRecord: record('FAILED') } : record('FAILED') }
        : { verify: async () => verified(record('FAILED')) });
      assert.equal((await h.run()).refunded, true);
      assert.equal(h.settlements[0].status, 'failed');
    });
  }
  test(`${provider}: local persistence error after delivery does not reverify or refund`, async () => {
    const h = harness({
      purchase: async () => provider === 'ding' ? { TransferRecord: record(completed) } : record(completed),
      settle: async () => { throw new Error('database temporarily unavailable'); },
    });
    const result = await h.run();
    assert.equal(result.refunded, false);
    assert.equal(result.status, 'processing');
    assert.equal(h.verifies(), 0);
  });
  test(`${provider}: refund persistence failure never claims refunded`, async () => {
    const h = harness({
      verify: async () => verified(record('FAILED')),
      settle: async () => { throw new Error('ledger unavailable'); },
    });
    assert.equal((await h.run()).refunded, false);
  });
  test(`${provider}: code/email errors cannot refund completed delivery`, async () => {
    const h = harness({
      codes: async () => { throw new Error('codes temporarily unavailable'); },
      notify: async () => { throw new Error('email unavailable'); },
    });
    assert.equal((await h.run()).status, 'completed');
    assert.equal(h.settlements[0].status, 'completed');
  });
}

// Small transactional Drizzle mock: isolated snapshots, rollback, and serialized
// transactions. No database module is loaded and no external calls are made.
function mockDatabase() {
  let state: any = {
    user: { id: 'user', balance: '20.000000', investorCredits: '5.000000', adminCredits: '7.000000', otherCredits: '8.000000' },
    order: null, ledger: [],
  };
  let queue = Promise.resolve();
  let failLedger = false;
  const database = {
    transaction: (fn: any) => {
      const run = queue.then(async () => {
        const draft = structuredClone(state);
        const tx = {
          select: () => ({ from: (table: any) => ({ where: () => ({
            for: async () => table === users ? [draft.user] : draft.order ? [draft.order] : [],
          }) }) }),
          insert: (table: any) => ({ values: (values: any) => {
            const execute = () => {
              if (table === walletTransactions) {
                if (failLedger) throw new Error('mock ledger failure');
                draft.ledger.push(values);
                return [values];
              }
              assert.equal(table, giftCardTransactions);
              draft.order = values;
              return [values];
            };
            return { returning: async () => execute(), then: (resolve: any, reject: any) => Promise.resolve().then(execute).then(resolve, reject) };
          } }),
          update: (table: any) => ({ set: (values: any) => ({ where: () => {
            const execute = () => {
              const row = table === users ? draft.user : draft.order;
              Object.assign(row, values);
              return [row];
            };
            return { returning: async () => execute(), then: (resolve: any, reject: any) => Promise.resolve().then(execute).then(resolve, reject) };
          } }) }),
        };
        const result = await fn(tx);
        state = draft;
        return result;
      });
      queue = run.then(() => {}, () => {});
      return run;
    },
  };
  return { database, state: () => state, failLedger: (value: boolean) => { failLedger = value; } };
}
const input = { userId: 'user', productId: 1, amount: '10.00', fee: '2.00', quantity: 1,
  customIdentifier: ref, metadata: { provider: 'reloadly' } };

test('durable processing order, discounted debit and ledger commit together; refund restores original pools once', async () => {
  const m = mockDatabase();
  const order = await beginWalletGiftCard(input, 11, m.database);
  assert.equal(m.state().order.status, 'processing');
  assert.equal(m.state().user.balance, '9.000000');
  assert.equal(m.state().user.investorCredits, '0.000000');
  assert.equal(m.state().user.adminCredits, '1.000000');
  assert.equal(m.state().ledger[0].amount, '11.000000');
  await Promise.all([1, 2].map(() => settleWalletGiftCard(order.id, 'failed', { status: 'FAILED' }, [], true, m.database)));
  assert.equal(m.state().user.balance, '20.000000');
  assert.equal(m.state().user.investorCredits, '5.000000');
  assert.equal(m.state().user.adminCredits, '7.000000');
  assert.equal(m.state().ledger.length, 2);
  assert.equal(m.state().order.metadata.autoRefunded, true);
});

test('debit ledger failure rolls back balance and durable order', async () => {
  const m = mockDatabase();
  m.failLedger(true);
  await assert.rejects(beginWalletGiftCard(input, 11, m.database), /ledger failure/);
  assert.equal(m.state().order, null);
  assert.equal(m.state().user.balance, '20.000000');
});

test('refund ledger failure rolls back credit and terminal transition; retry can refund', async () => {
  const m = mockDatabase();
  const order = await beginWalletGiftCard(input, 11, m.database);
  m.failLedger(true);
  await assert.rejects(settleWalletGiftCard(order.id, 'failed', { status: 'FAILED' }, [], true, m.database));
  assert.equal(m.state().order.status, 'processing');
  assert.equal(m.state().user.balance, '9.000000');
  m.failLedger(false);
  await settleWalletGiftCard(order.id, 'failed', { status: 'FAILED' }, [], true, m.database);
  assert.equal(m.state().ledger.length, 2);
});

test('completed order cannot later be refunded by stale settlement', async () => {
  const m = mockDatabase();
  const order = await beginWalletGiftCard(input, 11, m.database);
  await settleWalletGiftCard(order.id, 'completed', { transactionId: 'remote-123' }, [{ code: 'test' }], true, m.database);
  await settleWalletGiftCard(order.id, 'failed', { status: 'FAILED' }, [], true, m.database);
  assert.equal(m.state().order.status, 'completed');
  assert.equal(m.state().order.reloadlyTransactionId, 'remote-123');
  assert.equal(m.state().ledger.length, 1);
});

test('insufficient credit pools never debit or persist order', async () => {
  const m = mockDatabase();
  await assert.rejects(beginWalletGiftCard(input, 21, m.database), /Insufficient/);
  assert.equal(m.state().order, null);
  assert.equal(m.state().ledger.length, 0);
});

test('wallet processing UI bypasses successful receipt and preserves provider message', () => {
  const page = readFileSync('client/src/pages/payment-success.tsx', 'utf8');
  assert.match(page, /\["pending", "processing"\]\.includes/);
  assert.match(page, /Gift card order processing/);
  assert.match(page, /Your wallet has not been refunded/);
  assert.match(readFileSync('client/src/pages/gift-cards.tsx', 'utf8'), /message: data.message/);
});

test('legacy admin gate blocks all new wallet statuses, including already-refunded failed orders', () => {
  for (const status of ['pending', 'processing', 'completed', 'successful', 'failed', 'refunded']) {
    for (const autoRefunded of [false, true]) {
      const order = { id: 'order', customIdentifier: ref, status,
        metadata: { paymentMethod: 'wallet', walletDebited: true, provider: 'reloadly', autoRefunded } };
      const conflict = walletGiftCardLegacyActionConflict(order)!;
      assert.equal(conflict.customIdentifier, ref);
      assert.equal(conflict.alreadyRefunded, autoRefunded);
      assert.equal(conflict.error, autoRefunded ? 'WALLET_GIFTCARD_ALREADY_REFUNDED' : 'WALLET_GIFTCARD_RECONCILIATION_REQUIRED');
      let code = 0;
      let body: any;
      const response = { status(value: number) { code = value; return this; }, json(value: any) { body = value; } };
      assert.equal(blockLegacyWalletGiftCardAction(order, response), true);
      assert.equal(code, 409);
      assert.equal(body.success, false);
      assert.match(body.message, autoRefunded ? /already refunded atomically/ : /exact custom identifier/);
    }
  }
});

test('legacy admin gate leaves historical wallet rows and other methods unchanged', () => {
  for (const order of [undefined, {}, { metadata: { paymentMethod: 'wallet' } },
    { metadata: { paymentMethod: 'wallet', walletDebited: false } },
    { metadata: { paymentMethod: 'paypal', walletDebited: true } },
    { metadata: { paymentMethod: 'stripe', walletDebited: true } }]) {
    assert.equal(walletGiftCardLegacyActionConflict(order), null);
    assert.equal(blockLegacyWalletGiftCardAction(order, { status() { throw new Error('must not respond'); } }), false);
  }
});

test('all eight legacy gift-card mutation paths gate before status changes, refunds or provider requests', () => {
  const source = readFileSync('server/routes.ts', 'utf8');
  for (const route of [
    '/api/admin/transactions/:id/refund',
    '/api/admin/transactions/:id/complete',
    '/api/admin/transactions/:id/mark-failed',
    '/api/admin/gift-card-transactions/:id/retry',
    '/api/admin/gift-card-transactions/:id/refund',
    '/api/admin/gift-card-transactions/:id/mark-failed',
    '/api/admin/retry-gift-card/:transactionId',
    '/api/giftcards/:id/cancel',
  ]) {
    const start = source.indexOf(`app.post('${route}'`);
    assert.ok(start >= 0, route);
    const nextRoute = source.indexOf('\n  app.', start + 1);
    const handler = source.slice(start, nextRoute < 0 ? undefined : nextRoute);
    const gate = handler.indexOf('if (blockLegacyWalletGiftCardAction(');
    assert.ok(gate > 0, `${route} missing gate`);
    for (const mutation of ['updateGiftCardTransactionStatus(', 'claimGiftCardTransactionForProcessing(',
      'refundCreditPools(', 'refundCreditInTx(', 'orderGiftCard(', 'tx.update(giftCardTransactions)']) {
      const position = handler.indexOf(mutation);
      assert.ok(position < 0 || position > gate, `${route}: ${mutation} before gate`);
    }
  }
  const storage = readFileSync('server/storage.ts', 'utf8');
  const revert = storage.slice(storage.indexOf('async revertProcessingGiftCardTransaction('));
  assert.match(revert.slice(0, revert.indexOf('\n  async ', 1)), /walletDebited/);
});