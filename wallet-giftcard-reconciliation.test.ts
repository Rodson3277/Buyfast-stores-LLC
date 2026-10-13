import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reconcileWalletGiftCard } from '../server/services/walletGiftCardReconciliation';

test('admin UI replaces guarded desktop/mobile actions and supports readable Creole', () => {
  const ui = readFileSync('client/src/pages/admin/transactions-simple.tsx', 'utf8');
  assert.equal((ui.match(/isGuardedWalletGiftCard\(transaction\) && walletReview\(transaction\)/g) || []).length, 2);
  assert.equal((ui.match(/!isGuardedWalletGiftCard\(transaction\) &&/g) || []).length, 6);
  for (const language of ['en', 'ht', 'fr', 'es']) {
    const copy = JSON.parse(readFileSync(`client/src/locales/${language}.json`, 'utf8')).walletGiftCardReview;
    for (const key of ['verify', 'pending', 'completed', 'refunded', 'terminal', 'error']) assert.ok(copy[key]);
  }
  const routes = readFileSync('server/routes.ts', 'utf8');
  assert.ok(routes.includes("'/api/admin/giftcards/:id/verify-provider', verifyFirebaseAuth, requireEmailVerification, adminActionSecurity()"));
});

for (const provider of ['ding', 'reloadly']) {
  const order = { id: 'local-id', customIdentifier: 'exact-reference', status: 'processing',
    metadata: { provider, paymentMethod: 'wallet', walletDebited: true } };
  const record = (state: string, reference = 'exact-reference') => provider === 'ding'
    ? { ProcessingState: state, DistributorRef: reference }
    : { status: state, customIdentifier: reference };
  const verification = (value: any) => ({ checkable: true, [provider === 'ding' ? 'transfer' : 'order']: value });
  for (const scenario of ['delivered', 'failed', 'unknown', 'not-found', 'mismatch', 'unauthorized']) {
    test(`${provider}: reconciliation ${scenario} never initiates a purchase`, async () => {
      const calls: string[] = [];
      const result = await reconcileWalletGiftCard(order, {
        verify: async () => {
          if (scenario === 'unauthorized') throw new Error('401');
          return verification(scenario === 'not-found' ? null : record(
            scenario === 'delivered' ? (provider === 'ding' ? 'COMPLETED' : 'SUCCESSFUL')
              : scenario === 'unknown' ? 'PROCESSING' : 'FAILED',
            scenario === 'mismatch' ? 'different-order' : 'exact-reference'));
        },
        settle: async (status, boundRecord) => {
          assert.deepEqual(boundRecord, record(status === 'completed' ? (provider === 'ding' ? 'COMPLETED' : 'SUCCESSFUL') : 'FAILED'));
          calls.push(status);
          return { status, metadata: { autoRefunded: status === 'failed' } };
        },
      });
      assert.deepEqual(calls, scenario === 'delivered' ? ['completed'] : scenario === 'failed' ? ['failed'] : []);
      assert.equal(result.outcome, scenario === 'delivered' ? 'completed' : scenario === 'failed' ? 'refunded' : 'pending');
    });
  }
  test(`${provider}: already refunded never queries provider or settles again`, async () => {
    const result = await reconcileWalletGiftCard({ ...order, status: 'failed', metadata: { ...order.metadata, autoRefunded: true } }, {
      verify: async () => { assert.fail('unexpected provider read'); },
      settle: async () => { assert.fail('unexpected settlement'); },
    });
    assert.equal(result.outcome, 'terminal');
  });
}