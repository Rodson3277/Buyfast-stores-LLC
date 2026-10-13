import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { cryptoPurchaseRequests, users, walletTransactions } from "../shared/schema";
import { moveDepositWalletInTx } from "../server/services/depositWallet";

// Execute the actual claim without importing route startup, DB or providers.
const source = readFileSync("server/cryptoRoutes.ts", "utf8");
const claimSource = source.slice(source.indexOf("export async function claimManualCryptoStatusInTx"), source.indexOf("let _cryptoPollerStarted"));
const compiled = ts.transpile(claimSource.replace("export ", ""), { target: ts.ScriptTarget.ES2022 });
const claim = new Function("sql", "cryptoPurchaseRequests", "moveDepositWalletInTx",
  `${compiled}; return claimManualCryptoStatusInTx;`)(sql, cryptoPurchaseRequests, moveDepositWalletInTx);
const dialect = new PgDialect();

function harness(userPatch = {}, orderPatch = {}) {
  let state = {
    user: { id: "u", balance: "126.610000", investorCredits: "50", adminCredits: "20", otherCredits: "56.61", ...userPatch },
    order: { id: "c", userId: "u", orderId: "CRP-test", cryptoSymbol: "BTC", network: "btc",
      totalUsd: "102.00", status: "pending", paymentMethod: "wallet", autoAttempted: true,
      changenowId: null, changenowStatus: null, payinAddress: null, payinTxId: null, ...orderPatch },
    ledger: [] as any[],
  };
  let tail = Promise.resolve(), failLedger = false;
  const transaction = async (fn: any) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(r => { release = r; });
    await previous;
    const draft = structuredClone(state);
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ for: async (lock: string) => {
        assert.equal(lock, "update"); return [draft.user];
      } }) }) }),
      update: (table: any) => ({ set: (patch: any) => ({ where: (predicate: any) => {
        if (table === users) { Object.assign(draft.user, patch); return Promise.resolve(); }
        assert.equal(table, cryptoPurchaseRequests);
        const q = dialect.sqlToQuery(predicate);
        assert.match(q.sql, /status" = 'pending'/);
        for (const column of ["changenow_id", "changenow_status", "payin_address", "payin_tx_id"]) {
          assert.ok(q.sql.includes(`"${column}" IS NULL`));
        }
        const eligible = q.params[0] === draft.order.id && draft.order.status === "pending" &&
          [draft.order.changenowId, draft.order.changenowStatus, draft.order.payinAddress, draft.order.payinTxId].every(x => x === null);
        if (eligible) Object.assign(draft.order, patch);
        return { returning: async () => eligible ? [draft.order] : [] };
      } }) }),
      insert: (table: any) => ({ values: async (entry: any) => {
        assert.equal(table, walletTransactions);
        assert.equal(entry.relatedTransactionId, undefined);
        if (failLedger) throw new Error("LEDGER_FAILED");
        draft.ledger.push(entry);
      } }),
    };
    try { const result = await fn(tx); state = draft; return result; } finally { release(); }
  };
  return { transaction, state: () => state, fail: (v: boolean) => { failLedger = v; },
    status: (s: string) => transaction((tx: any) => claim(tx, "c", s, null, "admin")),
    debit: () => transaction((tx: any) => moveDepositWalletInTx(tx, "u", 102, "debit", "Crypto CRP-test")) };
}

for (const terminal of ["failed", "cancelled"]) {
  test(`purchase -> pool synchronization -> ${terminal}; repeats move no money`, async () => {
    const h = harness();
    await h.debit();
    const u = h.state().user;
    assert.equal(Number(u.investorCredits) + Number(u.adminCredits) + Number(u.otherCredits), 24.61);
    const results = await Promise.all([h.status(terminal), h.status("failed"), h.status("cancelled")]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(h.state().user.balance, "126.610000");
    assert.deepEqual(h.state().ledger.map(x => [x.type, x.amount, x.balanceBefore, x.balanceAfter]), [
      ["debit", "102.000000", "126.610000", "24.610000"],
      ["refund", "102.000000", "24.610000", "126.610000"],
    ]);
  });
}
test("legacy inconsistent pool refund adds only exact stored-balance delta", async () => {
  const h = harness({ balance: "24.61", investorCredits: "0", adminCredits: "0", otherCredits: "126.61" });
  await h.status("failed");
  assert.equal(h.state().user.balance, "126.610000");
  assert.equal(h.state().user.otherCredits, "228.610000");
});
test("ledger failure rolls back claim, wallet and pools; retry succeeds", async () => {
  const h = harness(); await h.debit();
  const before = structuredClone(h.state()); h.fail(true);
  await assert.rejects(h.status("failed"), /LEDGER_FAILED/);
  assert.deepEqual(h.state(), before);
  h.fail(false); assert.ok(await h.status("failed"));
});
for (const patch of [
  { status: "processing" }, { status: "completed" }, { status: "failed" }, { status: "cancelled" },
  { changenowId: "cn" }, { changenowStatus: "payin_send_uncertain" }, { payinAddress: "address" }, { payinTxId: "tx" },
]) {
  test(`provider/terminal guard ${JSON.stringify(patch)}`, async () => {
    const h = harness({}, patch);
    for (const target of ["completed", "failed", "cancelled", "pending"]) assert.equal(await h.status(target), undefined);
    assert.equal(h.state().ledger.length, 0);
  });
}
for (const first of ["completed", "cancelled"]) {
  test(`manual completion/cancellation race: ${first} wins`, async () => {
    const h = harness(); await h.debit();
    await Promise.all([h.status(first), h.status(first === "completed" ? "cancelled" : "completed")]);
    assert.equal(h.state().order.status, first);
    assert.equal(h.state().ledger.length, first === "completed" ? 1 : 2);
  });
}
test("PayPal cancellation never credits wallet", async () => {
  const h = harness({}, { paymentMethod: "paypal" });
  await h.status("cancelled"); assert.equal(h.state().ledger.length, 0);
});
test("purchase, poller and manual paths use shared movement; manual PayPal gate remains authoritative", () => {
  assert.equal((source.match(/await moveDepositWalletInTx\(/g) || []).length, 3);
  assert.ok(!source.includes("SET balance ="));
  const admin = source.slice(source.indexOf('app.patch("/api/admin/crypto/orders/:id"'));
  assert.ok(admin.indexOf("await verifyCryptoPayPalPaid(existing)") < admin.indexOf("claimManualCryptoStatusInTx(tx"));
  assert.ok(admin.includes('if (!paid.ok) return res.status(402)'));
});