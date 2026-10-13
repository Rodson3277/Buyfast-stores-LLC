import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { depositRequests, transactions, users, walletTransactions } from "../shared/schema";
import { claimDepositRefundInTx, moveDepositWalletInTx } from "../server/services/depositWallet";

// Transactional in-memory adapter only: never imports db, auth or providers.
// Serializes transactions like the row locks/conditional UPDATE in PostgreSQL.
function harness(overrides: any = {}) {
  let state = {
    user: { id: "u", balance: "126.610000", investorCredits: "0", adminCredits: "0", otherCredits: "126.610000", ...overrides },
    order: { id: "d", userId: "u", status: "pending", paymentMethod: "wallet", totalCharged: "102.00", amountUsd: "100.00", service: "zelle", orderId: "ZEL-test" },
    ledger: [] as any[],
  };
  let tail = Promise.resolve();
  let failLedger = false;
  let missingUser = false;
  const dialect = new PgDialect();
  const transaction = async (fn: (tx: any) => Promise<any>) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const draft = structuredClone(state);
    const matches = (condition: any, table: any) => {
      const query = dialect.sqlToQuery(condition);
      const row = table === users ? draft.user : draft.order;
      const columns = [...query.sql.matchAll(/"[^"]+"\."([^"]+)" = \$\d+/g)].map(m => m[1]);
      assert.equal(columns.length, query.params.length, "adapter understands every predicate");
      return columns.every((column, i) => (row as any)[column === "user_id" ? "userId" : column] === query.params[i]);
    };
    const tx = {
      select: () => ({ from: (table: any) => ({ where: (condition: any) => ({
        for: async (lock: string) => {
          assert.equal(table, users); assert.equal(lock, "update");
          return !missingUser && matches(condition, users) ? [draft.user] : [];
        },
      }) }) }),
      update: (table: any) => ({ set: (patch: any) => ({ where: (condition: any) => {
        if (!matches(condition, table)) return { returning: async () => [] };
        const row = table === users ? draft.user : draft.order;
        Object.assign(row, patch);
        return { returning: async () => [row] };
      } }) }),
      insert: (table: any) => ({ values: async (entry: any) => {
        assert.equal(table, walletTransactions);
        // Mirror the real FK, NOT a fictitious relation to deposit_requests.
        // The fixture has one top-up transaction and a distinct deposit "d".
        if (entry.relatedTransactionId != null && entry.relatedTransactionId !== "topup-t") {
          throw new Error("wallet_transactions_related_transaction_id_fkey");
        }
        if (failLedger) throw new Error("LEDGER_FAILED");
        draft.ledger.push(entry);
      } }),
    };
    try {
      const result = await fn(tx);
      state = draft;
      return result;
    } finally { release(); }
  };
  return {
    transaction, state: () => state,
    failLedger: (value: boolean) => { failLedger = value; },
    missingUser: () => { missingUser = true; },
    syncBalance: () => {
      state.user.balance = (Number(state.user.investorCredits) + Number(state.user.adminCredits) + Number(state.user.otherCredits)).toFixed(6);
    },
  };
}
const cancel = { id: "d", userId: "u", status: "cancelled" as const, adminNote: "Cancelled by user" };
const fail = { id: "d", status: "failed" as const, processedBy: "admin", adminNote: "Failed" };
const reject = { ...fail, adminNote: "Rejected" };
const debit = (h: ReturnType<typeof harness>, amount = 102) =>
  h.transaction(tx => moveDepositWalletInTx(tx, "u", amount, "debit", "Zelle purchase (ZEL-test)"));

for (const service of ["zelle", "cashapp", "wise", "paypal", "pix", "meru", "other", "crypto"]) {
  test(`${service}: competing customer/admin cancellations refund wallet exactly once`, async () => {
    const h = harness();
    h.state().order.service = service;
    await debit(h);
    const results = await Promise.all([cancel, fail, reject, cancel].map(options =>
      h.transaction(tx => claimDepositRefundInTx(tx, options))));
    assert.equal(results.filter(result => result.transitioned).length, 1);
    assert.equal(h.state().ledger.filter(entry => entry.type === "refund").length, 1);
    assert.equal(h.state().user.balance, "126.610000");
  });
}

test("both completion routes verify external funding but bypass providers for wallet funding", () => {
  const routes = readFileSync("server/depositCenterRoutes.ts", "utf8");
  for (const path of ["/api/admin/deposits/:id/complete", "/api/admin/deposits/:id/approve"]) {
    const handler = routes.slice(routes.indexOf(`"${path}"`)).split(/\n  app\./)[0];
    assert.match(handler, /deposit.paymentMethod !== "wallet" && \(deposit.paymentMethod === "paypal" \|\| deposit.paypalOrderId\)/);
    assert.match(handler, /await verifyDepositPayPalPaid\(deposit\)/);
    assert.match(handler, /eq\(depositRequests.status, "pending"\)/);
  }
});

test("refund pays down negative stored balance and liability pool without erasing debt", async () => {
  const h = harness({ balance: "-150", investorCredits: "0", adminCredits: "0", otherCredits: "-175" });
  await h.transaction(tx => claimDepositRefundInTx(tx, cancel));
  assert.equal(h.state().user.balance, "-48.000000");
  assert.equal(h.state().user.otherCredits, "-73.000000");
  assert.deepEqual(h.state().ledger.map(x => [x.amount, x.balanceBefore, x.balanceAfter]), [
    ["102.000000", "-150.000000", "-48.000000"],
  ]);
});

test("refund can cross zero while preserving historical pool discrepancy", async () => {
  const h = harness({ balance: "-25", investorCredits: "0", adminCredits: "0", otherCredits: "-50" });
  await h.transaction(tx => claimDepositRefundInTx(tx, fail));
  assert.equal(h.state().user.balance, "77.000000");
  assert.equal(h.state().user.otherCredits, "52.000000");
});

test("mixed positive pools and negative liability debit honors net capacity and retains debt", async () => {
  const h = harness({ balance: "130", investorCredits: "100", adminCredits: "80", otherCredits: "-50" });
  await debit(h);
  assert.equal(h.state().user.balance, "28.000000");
  assert.equal(h.state().user.investorCredits, "0.000000");
  assert.equal(h.state().user.adminCredits, "78.000000");
  assert.equal(h.state().user.otherCredits, "-50.000000");
  await assert.rejects(debit(h, 29), /INSUFFICIENT_BALANCE/);
  await debit(h, 28);
  assert.equal(h.state().user.balance, "0.000000");
  assert.equal(h.state().user.adminCredits, "50.000000");
  assert.equal(h.state().user.otherCredits, "-50.000000");
});

test("negative earlier-priority pool is not consumed or reset by debit", async () => {
  const h = harness({ balance: "130", investorCredits: "-50", adminCredits: "100", otherCredits: "80" });
  await debit(h);
  assert.equal(h.state().user.investorCredits, "-50.000000");
  assert.equal(h.state().user.adminCredits, "0.000000");
  assert.equal(h.state().user.otherCredits, "78.000000");
  assert.equal(h.state().user.balance, "28.000000");
});

test("pool debt limits debit even when stored balance and positive pools would cover it", async () => {
  const h = harness({ balance: "200", investorCredits: "100", adminCredits: "0", otherCredits: "-50" });
  const before = structuredClone(h.state());
  await assert.rejects(debit(h, 60), /INSUFFICIENT_BALANCE/);
  assert.deepEqual(h.state(), before);
});

test("negative stored balance cannot fund debit despite positive net pools", async () => {
  const h = harness({ balance: "-1", investorCredits: "100", adminCredits: "0", otherCredits: "-50" });
  await assert.rejects(debit(h, 1), /INSUFFICIENT_BALANCE/);
  assert.equal(h.state().ledger.length, 0);
});

test("failed debt refund ledger rolls back wallet, pools and status", async () => {
  const h = harness({ balance: "-150", otherCredits: "-150" });
  const before = structuredClone(h.state());
  h.failLedger(true);
  await assert.rejects(h.transaction(tx => claimDepositRefundInTx(tx, fail)), /LEDGER_FAILED/);
  assert.deepEqual(h.state(), before);
});

for (const pools of [
  { investorCredits: "0", adminCredits: "0", otherCredits: "126.61" },
  { investorCredits: "50", adminCredits: "20", otherCredits: "56.61" },
  { investorCredits: "126.61", adminCredits: "0", otherCredits: "0" },
  { investorCredits: "0", adminCredits: "126.61", otherCredits: "0" },
]) {
  test(`debit -> pool auto-sync -> refund: ${JSON.stringify(pools)}`, async () => {
    const h = harness(pools);
    await debit(h);
    assert.equal(h.state().user.balance, "24.610000");
    h.syncBalance();
    assert.equal(h.state().user.balance, "24.610000", "sync must not resurrect the debit");
    await h.transaction(tx => claimDepositRefundInTx(tx, cancel));
    h.syncBalance();
    assert.equal(h.state().user.balance, "126.610000");
    assert.deepEqual(h.state().ledger.map(x => [x.type, x.amount, x.balanceBefore, x.balanceAfter]), [
      ["debit", "102.000000", "126.610000", "24.610000"],
      ["refund", "102.000000", "24.610000", "126.610000"],
    ]);
    assert.ok(h.state().ledger.every(x => x.relatedTransactionId == null));
    assert.ok(h.state().ledger.every(x => x.description.includes("ZEL-test")));
  });
}

test("reproduces original arithmetic: single refund can inflate balance by twice charged amount", () => {
  const before = 126.61, charged = 102;
  const storedBalance = before - charged;
  const undebitedOtherPool = before;
  assert.equal((undebitedOtherPool + charged).toFixed(2), "228.61");
  assert.equal((undebitedOtherPool + charged - storedBalance).toFixed(2), "204.00");
});

for (const first of [cancel, fail, reject]) {
  test(`${first.adminNote}: concurrent user/admin repeats share one claim and one exact refund`, async () => {
    const h = harness();
    await debit(h);
    const requests = [first, cancel, fail, reject, cancel, fail, reject];
    const results = await Promise.all(requests.map(options => h.transaction(tx => claimDepositRefundInTx(tx, options))));
    assert.equal(results.filter(r => r.transitioned).length, 1);
    assert.equal(results.filter(r => r.refunded).length, 1);
    assert.equal(h.state().ledger.filter(x => x.type === "refund").length, 1);
    assert.equal(h.state().user.balance, "126.610000");
  });
}

for (const options of [cancel, fail, reject]) {
  test(`${options.adminNote}: ledger failure rolls back claim, wallet and pools; retry succeeds`, async () => {
    const h = harness();
    await debit(h);
    const snapshot = structuredClone(h.state());
    h.failLedger(true);
    await assert.rejects(h.transaction(tx => claimDepositRefundInTx(tx, options)), /LEDGER_FAILED/);
    assert.deepEqual(h.state(), snapshot);
    h.failLedger(false);
    assert.equal((await h.transaction(tx => claimDepositRefundInTx(tx, options))).refunded, true);
  });
}

test("missing wallet user rolls back the order claim", async () => {
  const h = harness();
  h.missingUser();
  await assert.rejects(h.transaction(tx => claimDepositRefundInTx(tx, fail)), /USER_NOT_FOUND/);
  assert.equal(h.state().order.status, "pending");
  assert.equal(h.state().ledger.length, 0);
});

test("debit ledger failure rolls back wallet and every pool", async () => {
  const h = harness();
  const snapshot = structuredClone(h.state());
  h.failLedger(true);
  await assert.rejects(debit(h), /LEDGER_FAILED/);
  assert.deepEqual(h.state(), snapshot);
});

test("historical pool discrepancy is not added to refund or automatically repaired", async () => {
  const h = harness({ balance: "24.61", otherCredits: "126.61" });
  await h.transaction(tx => claimDepositRefundInTx(tx, cancel));
  assert.equal(h.state().user.balance, "126.610000", "refund adds only 102, not 204");
  assert.equal(h.state().user.otherCredits, "228.610000", "existing discrepancy left for audited reconciliation");
  assert.equal(h.state().ledger[0].balanceBefore, "24.610000");
  assert.equal(h.state().ledger[0].balanceAfter, "126.610000");
});

test("locked/non-spendable pool surplus is not made spendable by a debit", async () => {
  const h = harness({ balance: "24.61", otherCredits: "126.61" });
  await assert.rejects(debit(h), /INSUFFICIENT_BALANCE/);
  await debit(h, 10);
  assert.equal(h.state().user.balance, "14.610000");
  assert.equal(h.state().user.otherCredits, "116.610000");
});

test("balance without sufficient spendable pools cannot fund a debit", async () => {
  const h = harness({ otherCredits: "10" });
  await assert.rejects(debit(h), /INSUFFICIENT_BALANCE/);
  assert.equal(h.state().ledger.length, 0);
});

for (const method of ["paypal", "moncash", "external"]) {
  test(`${method} is never auto-credited to wallet by cancellation claim`, async () => {
    const h = harness();
    h.state().order.paymentMethod = method;
    const result = await h.transaction(tx => claimDepositRefundInTx(tx, cancel));
    assert.equal(result.transitioned, true);
    assert.equal(result.refunded, false);
    assert.equal(h.state().ledger.length, 0);
    assert.equal(h.state().user.balance, "126.610000");
  });
}

for (const status of ["processing", "completed", "failed", "cancelled"]) {
  test(`${status} order cannot be refunded`, async () => {
    const h = harness();
    h.state().order.status = status;
    assert.equal((await h.transaction(tx => claimDepositRefundInTx(tx, cancel))).transitioned, false);
    assert.equal(h.state().ledger.length, 0);
  });
}

test("ownership predicate is part of atomic claim", async () => {
  const h = harness();
  assert.equal((await h.transaction(tx => claimDepositRefundInTx(tx, { ...cancel, userId: "other" }))).transitioned, false);
  assert.equal(h.state().order.status, "pending");
});

for (const processingFirst of [true, false]) {
  test(`admin completion vs user cancellation, processing first=${processingFirst}`, async () => {
    const h = harness();
    await debit(h);
    const complete = () => h.transaction(tx => tx.update(depositRequests).set({ status: "completed" })
      .where(and(eq(depositRequests.id, "d"), eq(depositRequests.status, "pending"))).returning());
    const refund = () => h.transaction(tx => claimDepositRefundInTx(tx, cancel));
    await Promise.all(processingFirst ? [complete(), refund()] : [refund(), complete()]);
    assert.equal(h.state().order.status, processingFirst ? "completed" : "cancelled");
    assert.equal(h.state().user.balance, processingFirst ? "24.610000" : "126.610000");
  });
}

for (const amount of [0, -1, NaN, Infinity]) {
  test(`invalid wallet delta ${amount} cannot change ledger or balance`, async () => {
    const h = harness();
    await assert.rejects(debit(h, amount), /INVALID_WALLET_AMOUNT/);
    assert.equal(h.state().ledger.length, 0);
  });
}

test("all three HTTP aliases use shared claim and shared cancellation helper uses exact-delta movement", () => {
  const routes = readFileSync("server/depositCenterRoutes.ts", "utf8");
  for (const path of ["/api/deposits/:id/cancel", "/api/admin/deposits/:id/fail", "/api/admin/deposits/:id/reject"]) {
    const handler = routes.slice(routes.indexOf(`"${path}"`)).split(/\n  app\./)[0];
    assert.match(handler, /claimDepositRefundInTx/);
    assert.doesNotMatch(handler, /refundCreditInTx|SET balance|insert\(walletTransactions\)/);
  }
  const helper = readFileSync("server/cancelRefund.ts", "utf8");
  assert.match(helper, /return moveDepositWalletInTx\(tx, userId, amount, "refund"/);
  assert.match(routes, /else if \(row.paymentMethod === "wallet"\)/);
  assert.match(routes, /performSourceRefund\(row.paypalOrderId/);
  assert.match(routes, /performSourceRefund\(\(deposit as any\).paypalOrderId/);
  assert.doesNotMatch(routes, /moveDepositWalletInTx\([^;]*,\s*c\.id\)/s);
});

test("wallet ledger FK targets transactions, never deposit_requests", () => {
  const fk = getTableConfig(walletTransactions).foreignKeys
    .map(key => key.reference())
    .find(ref => ref.columns.includes(walletTransactions.relatedTransactionId));
  assert.ok(fk);
  assert.equal(fk.foreignTable, transactions);
  assert.deepEqual(fk.foreignColumns, [transactions.id]);
  assert.notEqual(fk.foreignTable, depositRequests);
});

test("invalid deposit ID in ledger transaction FK rejects and rolls back wallet and claim", async () => {
  const h = harness();
  const snapshot = structuredClone(h.state());
  await assert.rejects(h.transaction(async tx => {
    await tx.update(depositRequests).set({ status: "cancelled" })
      .where(and(eq(depositRequests.id, "d"), eq(depositRequests.status, "pending"))).returning();
    await moveDepositWalletInTx(tx, "u", 102, "refund", "Invalid FK", "d");
  }), /wallet_transactions_related_transaction_id_fkey/);
  assert.deepEqual(h.state(), snapshot);
});

test("shared movement preserves valid transactions.id references for top-up refunds", async () => {
  const h = harness({ balance: "24.61", otherCredits: "24.61" });
  await h.transaction(tx => moveDepositWalletInTx(tx, "u", 102, "refund", "Top-up refund", "topup-t"));
  assert.equal(h.state().ledger[0].relatedTransactionId, "topup-t");
  assert.equal(h.state().user.balance, "126.610000");
});

test("debit retains investor/admin/other priority without changing account restriction or debt fields", async () => {
  const restrictions = { isBlocked: false, investorCode: "INV-test", haitiCommissionEnabled: false, adminDebitOutstanding: "17" };
  const h = harness({ investorCredits: "50", adminCredits: "20", otherCredits: "56.61", ...restrictions });
  await debit(h, 60);
  assert.equal(h.state().user.investorCredits, "0.000000");
  assert.equal(h.state().user.adminCredits, "10.000000");
  assert.equal(h.state().user.otherCredits, "56.610000");
  assert.equal(h.state().user.balance, "66.610000");
  for (const [key, value] of Object.entries(restrictions)) {
    assert.equal(h.state().user[key], value);
  }
});