import { test } from 'node:test';
import assert from 'node:assert/strict';
import { users, walletTransactions } from '../shared/schema';
import { manualGiftCardCancellation } from '../server/services/manualGiftCardCancellation';
import { settleWalletGiftCard } from '../server/services/walletGiftCardStore';
import { manualGiftCardCancellationHandler } from '../server/services/manualGiftCardCancellationRoute';
import { readFileSync } from 'node:fs';
import express from 'express';

function harness() {
  let state: any = {
    order: { id: 'order', customIdentifier: 'reference', userId: 'owner', status: 'processing', metadata: {
      paymentMethod: 'wallet', walletDebited: true, chargedTotal: '12.000000',
      walletDebitBreakdown: { investorCredits: '5.000000', adminCredits: '7.000000', otherCredits: '0.000000' },
    } },
    user: { id: 'owner', balance: '-20.000000', investorCredits: '-5.000000', adminCredits: '0.000000', otherCredits: '-15.000000' },
    ledger: [{ userId: 'owner', description: 'Gift card purchase reference (order)', type: 'debit', status: 'completed', amount: '12.000000', balanceBefore: '20.000000', balanceAfter: '8.000000' }],
  };
  let queue = Promise.resolve();
  let fail = false;
  const db = { transaction(fn: any) {
    const run = queue.then(async () => {
      const draft = structuredClone(state);
      const tx = {
        select: () => ({ from: (table: any) => ({ where: () => {
          const rows = table === users ? [draft.user] : table === walletTransactions ? draft.ledger : [draft.order];
          return { for: async () => rows, then: (resolve: any) => Promise.resolve(rows).then(resolve) };
        } }) }),
        update: (table: any) => ({ set: (values: any) => ({ where: () => {
          const execute = () => { Object.assign(table === users ? draft.user : draft.order, values); return [table === users ? draft.user : draft.order]; };
          return { returning: async () => execute(), then: (resolve: any) => Promise.resolve(execute()).then(resolve) };
        } }) }),
        insert: () => ({ values: async (value: any) => { if (fail) throw new Error('ledger failure'); draft.ledger.push(value); } }),
      };
      const result = await fn(tx);
      state = draft;
      return result;
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  } };
  return { db, state: () => state, fail: () => { fail = true; } };
}
const input = { reason: 'Administrator confirmed no delivery', nonDeliveryAttested: true };

test('manual cancellation races and repeats refund once, preserve liabilities and audit independently', async () => {
  const h = harness();
  await Promise.all([1, 2, 3].map(() => manualGiftCardCancellation('order', 'admin', input, h.db)));
  assert.equal(h.state().ledger.length, 2);
  assert.equal(h.state().user.balance, '-8.000000');
  assert.equal(h.state().user.investorCredits, '0.000000');
  assert.equal(h.state().order.metadata.manualCancellation.actorId, 'admin');
  assert.equal(h.state().order.metadata.providerStatus, undefined);
  await settleWalletGiftCard('order', 'failed', { status: 'FAILED' }, [], true, h.db);
  assert.equal(h.state().ledger.length, 2);
});
test('provider completion wins shared order lock; administrator cannot override', async () => {
  const h = harness();
  await settleWalletGiftCard('order', 'completed', { status: 'SUCCESSFUL' }, [], false, h.db);
  await assert.rejects(manualGiftCardCancellation('order', 'admin', input, h.db), /terminal/);
});
test('ledger failure rolls back claim, balance and audit', async () => {
  const h = harness();
  h.fail();
  await assert.rejects(manualGiftCardCancellation('order', 'admin', input, h.db), /ledger failure/);
  assert.equal(h.state().order.status, 'processing');
  assert.equal(h.state().user.balance, '-20.000000');
  assert.equal(h.state().order.metadata.manualCancellation, undefined);
});
test('missing actor, attestation, debit proof, prior credit and external funding rejected', async () => {
  const h = harness();
  await assert.rejects(manualGiftCardCancellation('order', '', input, h.db));
  await assert.rejects(manualGiftCardCancellation('order', 'admin', { ...input, nonDeliveryAttested: false }, h.db));
  h.state().ledger.push({ type: 'credit' });
  await assert.rejects(manualGiftCardCancellation('order', 'admin', input, h.db), /prior refund/);
  h.state().ledger = [];
  await assert.rejects(manualGiftCardCancellation('order', 'admin', input, h.db), /proof/);
  h.state().order.metadata.paymentMethod = 'paypal';
  await assert.rejects(manualGiftCardCancellation('order', 'admin', input, h.db), /externally/);
});

const invoke = async (handler: any, req: any) => {
  let status = 200;
  let body: any;
  const res = { status(code: number) { status = code; return res; }, json(value: any) { body = value; return res; } };
  await handler(req, res);
  return { status, body };
};
test('actual endpoint handler denies unauthenticated, non-admin and mismatched database identities', async () => {
  for (const [verifiedUser, actor, expected] of [
    [undefined, { id: 'admin', isAdmin: true }, 401],
    [{ uid: 'admin' }, { id: 'admin', isAdmin: false }, 403],
    [{ uid: 'admin' }, { id: 'different', isAdmin: true }, 403],
    [{ uid: 'admin' }, undefined, 403],
  ] as const) {
    const h = harness();
    const result = await invoke(manualGiftCardCancellationHandler(async () => actor, h.db), { verifiedUser, params: { id: 'order' }, body: input });
    assert.equal(result.status, expected);
    assert.equal(h.state().ledger.length, 1);
  }
  const routes = readFileSync('server/routes.ts', 'utf8');
  for (const suffix of ['manual-cancel', 'manual-cancel-quote', 'manual-complete', 'manual-complete-quote']) {
    assert.ok(routes.includes(`'/api/admin/giftcards/:id/${suffix}', verifyFirebaseAuth, requireEmailVerification, adminActionSecurity()`));
  }
});

test('manual completion attests delivery without money movement; repeats and automatic settlement are no-ops', async () => {
  const h = harness();
  const handler = manualGiftCardCancellationHandler(async () => ({ id: 'admin', isAdmin: true }), h.db, false, 'complete');
  const request = { verifiedUser: { uid: 'admin' }, params: { id: 'order' }, body: { reason: input.reason, deliveryAttested: true } };
  assert.equal((await invoke(handler, { ...request, body: input })).status, 409);
  const results = await Promise.all([invoke(handler, request), invoke(handler, request)]);
  assert.ok(results.every(result => result.status === 200));
  assert.equal(h.state().order.status, 'completed');
  assert.equal(h.state().order.metadata.manualCompletion.deliveryAttested, true);
  assert.equal(h.state().order.metadata.manualCompletion.actorId, 'admin');
  assert.equal(h.state().order.metadata.providerStatus, undefined);
  assert.equal(h.state().ledger.length, 1);
  assert.equal(h.state().user.balance, '-20.000000');
  await settleWalletGiftCard('order', 'failed', { status: 'FAILED' }, [], true, h.db);
  assert.equal(h.state().ledger.length, 1);
  await assert.rejects(manualGiftCardCancellation('order', 'admin', input, h.db));
});

test('cancel versus manual complete races have exactly one winner, never revive terminal orders', async () => {
  for (const first of ['cancel', 'complete'] as const) {
    const h = harness();
    const complete = () => manualGiftCardCancellation('order', 'admin', { reason: input.reason, deliveryAttested: true }, h.db, false, 'complete');
    const cancel = () => manualGiftCardCancellation('order', 'admin', input, h.db);
    const results = await Promise.allSettled(first === 'cancel' ? [cancel(), complete()] : [complete(), cancel()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(h.state().ledger.length, first === 'cancel' ? 2 : 1);
    assert.equal(h.state().order.status, first === 'cancel' ? 'cancelled' : 'completed');
  }
  for (const status of ['cancelled', 'failed', 'refunded']) {
    const h = harness();
    h.state().order.status = status;
    await assert.rejects(manualGiftCardCancellation('order', 'admin', { reason: input.reason, deliveryAttested: true }, h.db, false, 'complete'));
    assert.equal(h.state().ledger.length, 1);
  }
});

test('manual completion rejects unpaid external funding, invalid wallet debit, and non-admin actor', async () => {
  for (const scenario of ['external', 'debit', 'auth']) {
    const h = harness();
    if (scenario === 'external') h.state().order.metadata.paymentMethod = 'paypal';
    if (scenario === 'debit') h.state().ledger = [];
    const handler = manualGiftCardCancellationHandler(async () => ({ id: 'admin', isAdmin: scenario !== 'auth' }), h.db, false, 'complete');
    const result = await invoke(handler, { verifiedUser: { uid: 'admin' }, params: { id: 'order' }, body: { reason: input.reason, deliveryAttested: true } });
    assert.equal(result.status, scenario === 'auth' ? 403 : 409);
    assert.equal(h.state().order.status, 'processing');
    assert.equal(h.state().user.balance, '-20.000000');
  }
});
test('actual endpoint quote proves exact debit without writing; cancellation ignores forged actor/amount and repeats once', async () => {
  const h = harness();
  const getUser = async () => ({ id: 'admin', isAdmin: true });
  const req = { verifiedUser: { uid: 'admin' }, params: { id: 'order' }, body: { ...input, actor: 'forged', amount: 1000 } };
  const quote = await invoke(manualGiftCardCancellationHandler(getUser, h.db, true), req);
  assert.equal(quote.body.refundableAmount, '12.000000');
  assert.equal(h.state().ledger.length, 1);
  const handler = manualGiftCardCancellationHandler(getUser, h.db);
  const invalid = await invoke(handler, { ...req, body: { reason: 'bad', nonDeliveryAttested: false } });
  assert.equal(invalid.status, 409);
  const results = await Promise.all([invoke(handler, req), invoke(handler, req)]);
  assert.ok(results.every(result => result.status === 200));
  assert.equal(h.state().ledger.length, 2);
  assert.equal(h.state().order.metadata.manualCancellation.actorId, 'admin');
  assert.equal(results[0].body.refundedAmount, '12.000000');
});
test('endpoint rejects wrong owner or order-bound ledger proof and rolls back ledger errors', async () => {
  for (const scenario of ['owner', 'order', 'ledger']) {
    const h = harness();
    if (scenario === 'owner') h.state().ledger[0].userId = 'another-owner';
    if (scenario === 'order') h.state().ledger[0].description = 'Gift card purchase reference (other-order)';
    if (scenario === 'ledger') h.fail();
    const handler = manualGiftCardCancellationHandler(async () => ({ id: 'admin', isAdmin: true }), h.db);
    const response = await invoke(handler, { verifiedUser: { uid: 'admin' }, params: { id: 'order' }, body: input });
    assert.equal(response.status, 409);
    assert.equal(h.state().order.status, 'processing');
    assert.equal(h.state().user.balance, '-20.000000');
  }
});

test('HTTP endpoint with mocked authentication and transaction store rejects invalid requests and races once', async () => {
  const h = harness();
  const app = express();
  app.use(express.json());
  // Authentication is mocked, never connected to Firebase or a live session.
  app.use((req: any, res, next) => {
    if (req.headers.authorization) req.verifiedUser = { uid: req.headers.authorization };
    next();
  });
  const getUser = async (id: string) => ({ id, isAdmin: id === 'admin' });
  app.post('/api/admin/giftcards/:id/manual-cancel', manualGiftCardCancellationHandler(getUser, h.db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address() as { port: number };
    const post = (authorization?: string, body: any = input) => fetch(`http://127.0.0.1:${address.port}/api/admin/giftcards/order/manual-cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body),
    });
    assert.equal((await post()).status, 401);
    assert.equal((await post('customer')).status, 403);
    assert.equal((await post('admin', { ...input, nonDeliveryAttested: false })).status, 409);
    const results = await Promise.all([post('admin'), post('admin')]);
    assert.ok(results.every(result => result.status === 200));
    const bodies = await Promise.all(results.map(result => result.json()));
    assert.equal(bodies.filter(body => body.alreadyCancelled).length, 1);
    assert.equal(h.state().ledger.length, 2);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});