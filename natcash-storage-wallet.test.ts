import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { and, eq, sql, isNull } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { users, natcashTransfers, moncashTransfers, natcashLimits, walletTransactions } from "../shared/schema";
import { moveDepositWalletInTx } from "../server/services/depositWallet";

// Execute the actual storage methods without importing db/auth/provider modules.
const source = readFileSync("server/storage.ts", "utf8");
const parsed = ts.createSourceFile("storage.ts", source, ts.ScriptTarget.Latest, true);
const storageClass = parsed.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === "DatabaseStorage") as ts.ClassDeclaration;
const methods = ["createNatcashTransferAtomic", "createNatcashTransferImmediate", "createMoncashTransferAtomic",
  "claimNatcashTransferForProcessing", "claimMoncashTransferForProcessing",
  "completeNatcashTransferProcessing", "completeMoncashTransferProcessing", "creditWalletWithLedgerTx", "addToCreditPool"];
const code = ts.transpile(`class Storage { ${storageClass.members.filter(m => methods.includes(m.name?.getText(parsed) || "")).map(m => m.getText(parsed)).join("\n")} }`, { target: ts.ScriptTarget.ES2022 });
const paymentHelpersCode = ts.transpile(parsed.statements.filter(s => ts.isFunctionDeclaration(s) &&
  ["mobileMoneyPayPalOrderId", "mobileMoneyPayPalReferences", "claimMobileMoneyPaymentInTx", "claimMobileMoneyReferencesInTx"].includes(s.name?.text || "")).map(s => s.getText(parsed).replace(/^export /, "")).join("\n"),
  { target: ts.ScriptTarget.ES2022 });
const { mobileMoneyPayPalOrderId, claimMobileMoneyPaymentInTx, claimMobileMoneyReferencesInTx } = new Function("natcashTransfers", "moncashTransfers", "eq", "sql",
  `${paymentHelpersCode}; return { mobileMoneyPayPalOrderId, claimMobileMoneyPaymentInTx, claimMobileMoneyReferencesInTx };`)(natcashTransfers, moncashTransfers, eq, sql);
const smsSource = readFileSync("server/natcashSmsWebhookRoutes.ts", "utf8");
const smsParsed = ts.createSourceFile("sms.ts", smsSource, ts.ScriptTarget.Latest, true);
const smsFn = smsParsed.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === "claimNatcashSmsReplyInTx")!;
const smsCode = ts.transpile(smsFn.getText(smsParsed).replace("export ", ""), { target: ts.ScriptTarget.ES2022 });
const smsClaim = new Function("natcashTransfers", "users", "and", "eq", "sql", "moveDepositWalletInTx",
  `${smsCode}; return claimNatcashSmsReplyInTx;`)(natcashTransfers, users, and, eq, sql, moveDepositWalletInTx);

function harness(service = "natcash", overrides: any = {}) {
  const table = service === "natcash" ? natcashTransfers : moncashTransfers;
  let state: any = { user: { id: "u", balance: "120.000000", investorCredits: "30", adminCredits: "40", otherCredits: "80" },
    orders: [], otherOrders: [], ledger: [], limits: [], ...overrides };
  let failLedger = false;
  let tail = Promise.resolve();
  const dialect = new PgDialect();
  const transaction = async (fn: any) => {
    const wait = tail;
    let release!: () => void;
    tail = new Promise<void>(r => release = r);
    await wait;
    const draft = structuredClone(state);
    const rows = (t: any) => t === users ? (draft.user ? [draft.user] : []) : t === natcashLimits ? draft.limits : t === table ? draft.orders : draft.otherOrders;
    const matches = (row: any, condition: any) => {
      const q = dialect.sqlToQuery(condition);
      if (q.sql.includes("smsReplySid")) return row.metadata?.smsReplySid === q.params[0];
      const columns = [...q.sql.matchAll(/"[^"]+"\."([^"]+)" = \$\d+/g)].map(m => m[1]);
      const key = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      assert.equal(columns.length, q.params.length, q.sql);
      return columns.every((c, i) => row[key(c)] === q.params[i]) &&
        (!q.sql.includes('"processed_by" is null') || row.processedBy == null);
    };
    const tx: any = {
      execute: async () => {},
      select: () => ({ from: (t: any) => ({ where: (c: any) => {
        const result = () => rows(t).filter((r: any) => matches(r, c)).map((r: any) => ({ ...r }));
        return { for: async () => result(), limit: async () => result(), then: (resolve: any) => Promise.resolve(result()).then(resolve) };
      } }) }),
      update: (t: any) => ({ set: (patch: any) => ({ where: (c: any) => {
        const found = rows(t).filter((r: any) => matches(r, c));
        for (const row of found) {
          const next = { ...patch };
          if (patch.metadata) {
            const q = dialect.sqlToQuery(patch.metadata);
            next.metadata = { ...row.metadata, ...JSON.parse(q.params[0] as string) };
          }
          Object.assign(row, next);
        }
        return { returning: async () => found };
      } }) }),
      insert: (t: any) => ({ values: (entry: any) => {
        const run = () => {
          if (t === walletTransactions) {
            if (failLedger) throw new Error("LEDGER_FAILED");
            assert.equal(entry.relatedTransactionId, undefined, "service IDs never enter transactions FK");
            draft.ledger.push(entry);
            return [entry];
          }
          const row = { ...entry, id: typeof entry.id === "string" ? entry.id : `t${draft.orders.length}`, processedBy: null };
          (t === natcashLimits ? draft.limits : draft.orders).push(row);
          return [row];
        };
        return { returning: async () => run(), then: (resolve: any, reject: any) => Promise.resolve().then(run).then(resolve, reject) };
      } }),
    };
    try { const result = await fn(tx); state = draft; return result; } finally { release(); }
  };
  const Storage = new Function("db", "users", "natcashTransfers", "moncashTransfers", "natcashLimits", "walletTransactions",
    "and", "eq", "sql", "isNull", "moveDepositWalletInTx", "console", "mobileMoneyPayPalOrderId", "claimMobileMoneyPaymentInTx", "claimMobileMoneyReferencesInTx",
    `${code}; return Storage;`)({ transaction }, users, natcashTransfers, moncashTransfers, natcashLimits, walletTransactions,
      and, eq, sql, isNull, moveDepositWalletInTx, { log() {}, warn() {}, error() {} }, mobileMoneyPayPalOrderId, claimMobileMoneyPaymentInTx, claimMobileMoneyReferencesInTx);
  return { storage: new Storage(), transaction, state: () => state, failLedger: () => failLedger = true, table };
}

const input = { userId: "u", paymentMethod: " WALLET ", totalAmount: "60", amount: "58",
  recipientFullName: "Recipient", recipientNatcashPhone: "50912345678", recipientMoncashPhone: "50912345678" };

for (const service of ["Natcash", "Moncash"]) {
  test(`${service}: purchase, duplicate, concurrent fail/complete and replay preserve exact balances`, async () => {
    const h = harness(service.toLowerCase());
    const [purchase, duplicate] = await Promise.all([
      h.storage[`create${service}TransferAtomic`](input, "key"),
      h.storage[`create${service}TransferAtomic`](input, "key"),
    ]);
    assert.equal(purchase.success, true);
    assert.equal(duplicate.duplicateTransaction, true);
    assert.equal(h.state().user.balance, "60.000000");
    assert.deepEqual([h.state().user.investorCredits, h.state().user.adminCredits, h.state().user.otherCredits], ["0.000000", "10.000000", "80.000000"]);
    assert.equal(h.state().ledger.length, 1);
    assert.equal(h.state().ledger[0].balanceBefore, "120.000000");
    assert.equal(h.state().ledger[0].balanceAfter, "60.000000");
    await h.storage[`claim${service}TransferForProcessing`](purchase.transfer.id, "admin");
    const results = await Promise.all(["failed", "completed", "failed"].map(status =>
      h.storage[`complete${service}TransferProcessing`](purchase.transfer.id, "admin", { status })));
    assert.equal(results.filter(r => r.success).length, 1);
    assert.equal(h.state().user.balance, "120.000000");
    assert.equal(h.state().ledger.length, 2);
    assert.equal(h.state().ledger[1].balanceBefore, "60.000000");
    assert.equal(h.state().ledger[1].balanceAfter, "120.000000");
  });

  test(`${service}: failed ledger rolls back purchase; manual completion still requires captured external payment`, async () => {
    const h = harness(service.toLowerCase());
    h.failLedger();
    await assert.rejects(h.storage[`create${service}TransferAtomic`](input, "key"), /LEDGER_FAILED/);
    assert.equal(h.state().user.balance, "120.000000");
    assert.equal(h.state().orders.length, 0);
    for (const captured of [null, new Date()]) {
      const p = harness(service.toLowerCase(), { orders: [{ id: "t", status: "processing", processedBy: "admin", paymentMethod: "paypal", paymentCapturedAt: captured }] });
      const result = await p.storage[`complete${service}TransferProcessing`]("t", "admin", { status: "completed" });
      assert.equal(result.success, !!captured);
      assert.equal(p.state().ledger.length, 0);
    }
  });

  test(`${service}: completion wins against failure, terminal and wrong-admin retries are inert`, async () => {
    const h = harness(service.toLowerCase(), { orders: [{ id: "t", userId: "u", totalAmount: "60",
      paymentMethod: "wallet", status: "processing", processedBy: "admin" }] });
    assert.equal((await h.storage[`complete${service}TransferProcessing`]("t", "other", { status: "failed" })).success, false);
    const results = await Promise.all(["completed", "failed"].map(status =>
      h.storage[`complete${service}TransferProcessing`]("t", "admin", { status })));
    assert.equal(results[0].success, true);
    assert.equal(results[1].success, false);
    assert.equal(h.state().orders[0].status, "completed");
    assert.equal(h.state().ledger.length, 0);
    assert.equal(h.state().user.balance, "120.000000");
  });

  test(`${service}: missing refund user rolls back terminal claim`, async () => {
    const h = harness(service.toLowerCase(), { user: null, orders: [{ id: "t", userId: "u", totalAmount: "60",
      paymentMethod: "wallet", status: "processing", processedBy: "admin" }] });
    await assert.rejects(h.storage[`complete${service}TransferProcessing`]("t", "admin", { status: "failed" }), /USER_NOT_FOUND/);
    assert.equal(h.state().orders[0].status, "processing");
    assert.equal(h.state().ledger.length, 0);
  });
}

test("SMS concurrent cancellation and retry never refunds or acts on the next transfer twice", async () => {
  const h = harness("natcash", { orders: ["a", "b"].map(id => ({ ...input, paymentMethod: "wallet", id, status: "pending_sms_confirmation" })) });
  const result = await Promise.all([true, false, true].map(cancel => h.transaction((tx: any) => smsClaim(tx, "a", "SM1", cancel))));
  assert.equal(result.filter(Boolean).length, 1);
  assert.equal(await h.transaction((tx: any) => smsClaim(tx, "b", "SM1", true)), false);
  assert.equal(h.state().orders[1].status, "pending_sms_confirmation");
  assert.equal(h.state().user.balance, "180.000000");
  assert.equal(h.state().ledger.length, 1);
});

test("refund ledger failure rolls back SMS status and receipt", async () => {
  const h = harness("natcash", { orders: [{ ...input, id: "a", paymentMethod: "wallet", status: "pending_sms_confirmation" }] });
  h.failLedger();
  await assert.rejects(h.transaction((tx: any) => smsClaim(tx, "a", "SM1", true)), /LEDGER_FAILED/);
  assert.equal(h.state().orders[0].status, "pending_sms_confirmation");
  assert.equal(h.state().orders[0].metadata, undefined);
  assert.equal(h.state().user.balance, "120.000000");
});

test("shared credits use stored balance rather than stale pool total", async () => {
  const h = harness();
  await h.storage.addToCreditPool("u", 5, "admin");
  const result = await h.transaction((tx: any) => h.storage.creditWalletWithLedgerTx(tx, { userId: "u", amount: 7, type: "refund", description: "test" }));
  assert.equal(result.balanceBefore, 125);
  assert.equal(result.balanceAfter, 132);
  assert.equal(h.state().ledger[0].balanceAfter, "132.000000");
});

test("immediate NatCash is pending manual delivery and rolls back on ledger failure", async () => {
  const h = harness();
  const result = await h.storage.createNatcashTransferImmediate(input, "key");
  assert.equal(result.transfer.status, "pending");
  assert.equal(h.state().ledger.length, 1);
  assert.equal(h.state().user.balance, "60.000000");
  const failed = harness();
  failed.failLedger();
  await assert.rejects(failed.storage.createNatcashTransferImmediate(input, "key"), /LEDGER_FAILED/);
  assert.equal(failed.state().user.balance, "120.000000");
});

test("NatCash daily-limit rejection rolls back the already attempted debit", async () => {
  const h = harness("natcash", { limits: [{ id: "limit", userId: "u", date: new Date().toISOString().split("T")[0], dailyAmount: "990", dailyCount: 1 }] });
  await assert.rejects(h.storage.createNatcashTransferAtomic(input, "key"), /Daily limit exceeded/);
  assert.equal(h.state().user.balance, "120.000000");
  assert.equal(h.state().orders.length, 0);
  assert.equal(h.state().ledger.length, 0);
});

test("new captured-payment fields and SMS confirmation state survive atomic NatCash creation", async () => {
  const h = harness();
  const capturedAt = new Date();
  const result = await h.storage.createNatcashTransferAtomic({ ...input, paymentMethod: "paypal",
    paymentOrderId: "VERIFIED-ORDER", paymentCapturedAt: capturedAt, status: "pending_sms_confirmation" }, "verified-key");
  assert.equal(result.transfer.status, "pending_sms_confirmation");
  assert.equal(result.transfer.paymentOrderId, "VERIFIED-ORDER");
  assert.deepEqual(result.transfer.paymentCapturedAt, capturedAt);
  assert.equal(h.state().ledger.length, 0);
  assert.equal(h.state().user.balance, "120.000000");
});

// Compile and execute the ACTUAL Express callbacks, not a parallel test handler.
const routesSource = readFileSync("server/routes.ts", "utf8");
const routesParsed = ts.createSourceFile("routes.ts", routesSource, ts.ScriptTarget.Latest, true);
const finalizerNode = routesParsed.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === "finalizeMobileMoneyAdmin")!;
const finalizerCode = ts.transpile(finalizerNode.getText(routesParsed).replace(/^export /, ""), { target: ts.ScriptTarget.ES2022 });
const strictVerificationCode = ts.transpile(routesParsed.statements.filter(s => ts.isFunctionDeclaration(s) &&
  ["validateMobileMoneyCapture", "verifyMobileMoneyCaptured"].includes(s.name?.text || ""))
  .map(s => s.getText(routesParsed).replace(/^export /, "")).join("\n"), { target: ts.ScriptTarget.ES2022 });

for (const service of ["natcash", "moncash"]) {
  test(`${service}: strict captured-payment GET rejects unbound, foreign, missing-currency and unbounded amount evidence`, async () => {
    const good = { purchase_units: [{ custom_id: `u|${service}`, payments: {
      captures: [{ id: "capture", status: "COMPLETED", amount: { value: "60.00", currency_code: "USD" } }],
    } }] };
    const verify = (order: any) => new Function("storage", "getPayPalAccessToken", "fetch",
      `${strictVerificationCode}; return verifyMobileMoneyCaptured;`)(
      { getFeeStructure: async () => ({ internationalSurcharge: "6" }) }, async () => "test-token",
      async () => ({ ok: true, json: async () => order }))("ORDER", 60, "u", service);
    assert.equal((await verify(good)).ok, true);
    for (const change of [
      (o: any) => { delete o.purchase_units[0].custom_id; },
      (o: any) => { o.purchase_units[0].custom_id = `other|${service}`; },
      (o: any) => { o.purchase_units[0].custom_id = `|${service}`; },
      (o: any) => { o.purchase_units[0].custom_id = "u|"; },
      (o: any) => { o.purchase_units[0].custom_id = "u|giftcard"; },
      (o: any) => { delete o.purchase_units[0].payments.captures[0].amount.currency_code; },
      (o: any) => { o.purchase_units[0].payments.captures[0].amount.currency_code = "EUR"; },
      (o: any) => { o.purchase_units[0].payments.captures[0].amount.value = "NaN"; },
      (o: any) => { o.purchase_units[0].payments.captures[0].amount.value = "75"; },
      (o: any) => { o.purchase_units[0].payments.captures[0].amount.value = "59"; },
      (o: any) => { o.purchase_units[0].payments.captures[0].status = "PENDING"; },
      (o: any) => { o.purchase_units[0].payments.captures[0].custom_id = "other|natcash"; },
    ]) {
      const invalid = structuredClone(good); change(invalid);
      assert.equal((await verify(invalid)).ok, false, JSON.stringify(invalid));
    }
    const surcharge = structuredClone(good);
    surcharge.purchase_units[0].payments.captures[0].amount.value = "63.60";
    assert.equal((await verify(surcharge)).ok, true);
  });

  test(`${service}: create and pre-stamped finalize reject cross-service or legacy reference reuse`, async () => {
    const cap = service === "natcash" ? "Natcash" : "Moncash";
    for (const field of [
      { paymentOrderId: "ORDER" },
      { metadata: { paypalOrderId: "ORDER" } },
      { metadata: JSON.stringify({ orderId: "ORDER" }) },
      { idempotencyKey: `googlepay_${service}_ORDER_123` },
      { idempotencyKey: "RECOVERY-ORDER" },
      { paymentOrderId: "OTHER", metadata: { paypalOrderId: "ORDER" } },
    ]) for (const collection of ["orders", "otherOrders"]) {
      const existing = { id: "existing", status: "completed", ...field };
      const create = harness(service, { [collection]: [existing] });
      await assert.rejects(create.storage[`create${cap}TransferAtomic`](
        { ...input, paymentMethod: "paypal", paymentOrderId: "ORDER", paymentCapturedAt: new Date() }, "new-key"), /PAYMENT_ALREADY_LINKED/);
      assert.equal(create.state().ledger.length, 0);
      const finalize = harness(service, { orders: [{ id: "t", userId: "u", processedBy: "admin", status: "processing",
        paymentMethod: "paypal", paymentOrderId: "ORDER", paymentCapturedAt: new Date(), totalAmount: "60" }] });
      finalize.state()[collection].push(existing);
      await assert.rejects(finalize.storage[`complete${cap}TransferProcessing`]("t", "admin", { status: "completed" }), /PAYMENT_ALREADY_LINKED/);
      assert.equal(finalize.state().orders[0].status, "processing");
      assert.equal(finalize.state().ledger.length, 0);
    }
  });
}
function handlerNode(path: string) {
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "post" && node.arguments[0]?.getText(routesParsed) === `'${path}'`) {
      found = node.arguments[node.arguments.length - 1];
    }
    ts.forEachChild(node, visit);
  }
  visit(routesParsed);
  assert.ok(found, path);
  return found!;
}
function routeHarness(service: "natcash" | "moncash", order: any, verification = { ok: true, capturedAmount: 60 }) {
  const h = harness(service, { orders: [{ id: "t", userId: "u", amount: "58", totalAmount: "60", status: "pending",
    paymentMethod: "wallet", processedBy: null, recipientFullName: "Recipient", ...order }] });
  const notifications: any[] = [];
  const verifications: any[] = [];
  const refunds: any[] = [];
  const getter = async (id: string) => structuredClone(h.state().orders.find((r: any) => r.id === id));
  h.storage.getNatcashTransferById = getter;
  h.storage.getMoncashTransferById = getter;
  h.storage.getUser = async () => ({ email: "user@example.test", firstName: "User" });
  const finalize = new Function("storage", "mobileMoneyPayPalOrderId", "verifyMobileMoneyCaptured", "performSourceRefund",
    `${finalizerCode}; return finalizeMobileMoneyAdmin;`)(h.storage, mobileMoneyPayPalOrderId,
      async (...args: any[]) => { verifications.push(args); return verification; },
      async (...args: any[]) => { refunds.push(args); return { refunded: true }; });
  const invoke = async (path: string, body: any = {}, adminId = "admin") => {
    const callback = ts.transpile(`const callback = ${handlerNode(path).getText(routesParsed)};`, { target: ts.ScriptTarget.ES2022 })
      .replace(/import\(['"]\.\/cron\/fcmScheduler['"]\)/g, "Promise.resolve(fcm)");
    const fn = new Function("storage", "finalizeMobileMoneyAdmin", "isUserDiditVerified", "sendTransactionEmail", "fcm", "console",
      `${callback}; return callback;`)(h.storage, finalize, async () => true,
        async (...args: any[]) => notifications.push(args), {
          sendPaymentSuccessNotification: async (...args: any[]) => notifications.push(args),
          sendPaymentFailureNotification: async (...args: any[]) => notifications.push(args),
        }, { log() {}, error() {}, warn() {} });
    let status = 200, result: any;
    const res = { status(n: number) { status = n; return this; }, json(data: any) { result = data; return this; } };
    await fn({ params: { transferId: "t" }, verifiedUser: { id: adminId, uid: adminId, email: "admin@example.test", isAdmin: true }, body }, res);
    return { status, body: result };
  };
  return { ...h, invoke, notifications, verifications, refunds };
}

for (const service of ["natcash", "moncash"] as const) {
  test(`actual ${service} UI routes: competing complete/fail invokes wallet/cashback and notifications once`, async () => {
    const h = routeHarness(service, { customerCashbackAmount: "2" });
    const results = await Promise.all([
      h.invoke(`/api/admin/${service}/:transferId/complete`),
      h.invoke(`/api/admin/${service}/:transferId/fail`, { reason: "failed" }),
    ]);
    assert.equal(results.filter(r => r.body.success).length, 1);
    const completed = h.state().orders[0].status === "completed";
    assert.equal(h.state().user.balance, completed ? "122.000000" : "180.000000");
    assert.equal(h.state().ledger.length, 1);
    const notificationCount = completed || service === "natcash" ? 2 : 0;
    assert.equal(h.notifications.length, notificationCount);
    const repeat = await h.invoke(`/api/admin/${service}/:transferId/fail`);
    assert.equal(repeat.body.success, false);
    assert.equal(h.state().ledger.length, 1);
    assert.equal(h.notifications.length, notificationCount);
  });

  test(`actual ${service} UI completed cashback + ledger is atomic and paid once`, async () => {
    const h = routeHarness(service, { customerCashbackAmount: "2" });
    assert.equal((await h.invoke(`/api/admin/${service}/:transferId/complete`)).body.success, true);
    await h.invoke(`/api/admin/${service}/:transferId/complete`);
    assert.equal(h.state().user.balance, "122.000000");
    assert.equal(h.state().ledger.length, 1);
    assert.equal(h.state().orders[0].cashbackCredited, true);
    assert.equal(h.notifications.length, 2);
  });

  test(`actual ${service} UI fail refunds once, without pre-claiming`, async () => {
    const h = routeHarness(service, {});
    const results = await Promise.all([1, 2].map(() => h.invoke(`/api/admin/${service}/:transferId/fail`)));
    assert.equal(results.filter(r => r.body.success).length, 1);
    assert.equal(h.state().ledger.length, 1);
    assert.equal(h.state().user.balance, "180.000000");
  });

  test(`actual ${service} UI: claimed rows accept only claiming admin`, async () => {
    const h = routeHarness(service, { status: "processing", processedBy: "admin" });
    const rejected = await h.invoke(`/api/admin/${service}/:transferId/complete`, {}, "other-admin");
    assert.equal(rejected.status, 409);
    const accepted = await h.invoke(`/api/admin/${service}/:transferId/complete`);
    assert.equal(accepted.body.success, true);
  });

  test(`actual ${service} UI: verified legacy PayPal is persisted; unpaid remains pending`, async () => {
    for (const ok of [true, false]) {
      const h = routeHarness(service, { paymentMethod: "paypal", idempotencyKey: `paypal_${service}_ORDER123_123456` },
        { ok, capturedAmount: 60 });
      const response = await h.invoke(`/api/admin/${service}/:transferId/complete`);
      assert.equal(response.body.success, ok);
      assert.equal(h.verifications.length, 1);
      assert.deepEqual(h.verifications[0], ["ORDER123", 60, "u", service]);
      assert.equal(h.state().orders[0].status, ok ? "completed" : "pending");
      assert.equal(h.state().orders[0].paymentOrderId, ok ? "ORDER123" : undefined);
      assert.equal(!!h.state().orders[0].paymentCapturedAt, ok);
    }
  });

  test(`actual ${service} UI: legacy missing reference accepts admin reference only after verification`, async () => {
    const h = routeHarness(service, { paymentMethod: "paypal" });
    assert.equal((await h.invoke(`/api/admin/${service}/:transferId/complete`)).body.success, false);
    assert.equal((await h.invoke(`/api/admin/${service}/:transferId/complete`, { paypalOrderId: "ORIGINAL" })).body.success, true);
    assert.equal(h.state().orders[0].paymentOrderId, "ORIGINAL");
    assert.equal(h.verifications.length, 1);
  });

  test(`actual ${service} UI: failed unpaid PayPal never reaches wallet-fallback source refund`, async () => {
    const h = routeHarness(service, { paymentMethod: "paypal", paymentOrderId: "UNPAID" }, { ok: false, capturedAmount: 0 });
    const response = await h.invoke(`/api/admin/${service}/:transferId/fail`);
    assert.equal(response.body.success, true);
    assert.equal(response.body.sourceRefund.refunded, false);
    assert.equal(h.refunds.length, 0);
    assert.equal(h.state().ledger.length, 0);
    assert.equal(h.state().user.balance, "120.000000");
  });

  test(`actual ${service} UI: pre-stamped evidence is strictly reverified, duplicate linked legacy payment is rejected`, async () => {
    const h = routeHarness(service, { paymentMethod: "paypal", paymentOrderId: "PAID", paymentCapturedAt: new Date() });
    assert.equal((await h.invoke(`/api/admin/${service}/:transferId/complete`)).body.success, true);
    assert.equal(h.verifications.length, 1);
    const duplicate = routeHarness(service, { paymentMethod: "paypal" });
    duplicate.state().orders.push({ id: "already-paid", paymentOrderId: "DUPLICATE", status: "completed" });
    const response = await duplicate.invoke(`/api/admin/${service}/:transferId/complete`, { paypalOrderId: "DUPLICATE" });
    assert.equal(response.status, 500);
    assert.equal(duplicate.state().orders[0].status, "pending");
  });
}

test("actual NatCash claim + normal UI complete + secure alias retry are coherent", async () => {
  const h = routeHarness("natcash", {});
  assert.equal((await h.invoke("/api/admin/natcash/claim/:transferId")).body.success, true);
  assert.equal(h.state().orders[0].status, "processing");
  assert.equal((await h.invoke("/api/admin/natcash/:transferId/complete")).body.success, true);
  assert.equal((await h.invoke("/api/admin/natcash/complete/:transferId", { status: "failed" })).body.success, false);
  assert.equal(h.state().ledger.length, 0);
});

test("actual secure NatCash alias verifies external payment and source refunds only for winner", async () => {
  const completed = routeHarness("natcash", { paymentMethod: "paypal", paymentOrderId: "ORDER", processedBy: "admin", status: "processing" });
  assert.equal((await completed.invoke("/api/admin/natcash/complete/:transferId", { status: "completed" })).body.success, true);
  assert.equal(completed.verifications.length, 1);
  const failed = routeHarness("natcash", { paymentMethod: "paypal", paymentOrderId: "ORDER" });
  const results = await Promise.all([
    failed.invoke("/api/admin/natcash/complete/:transferId", { status: "failed" }),
    failed.invoke("/api/admin/natcash/:transferId/fail"),
  ]);
  assert.equal(results.filter(r => r.body.success).length, 1);
  assert.equal(failed.refunds.length, 1);
});