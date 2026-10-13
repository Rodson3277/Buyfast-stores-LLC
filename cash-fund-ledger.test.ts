import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as schema from "../shared/schema";
import * as drizzle from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as bankFunding from "../server/bankFunding";

// Execute the real registered admin handler with an isolated transactional
// adapter. No db module, credentials, or provider modules are loaded.
function fundingHarness() {
  let state = {
    user: { id: "u", balance: "24.610000", adminCredits: "102.000000", otherCredits: "24.610000" },
    orders: ["a", "b"].map(id => ({ id, userId: "u", receiveType: "wallet", status: "pending", paymentMethod: "bank_transfer", sendAmount: "10.00", referenceNumber: id, proofImageData: null as string | null })),
    ledger: [] as any[],
  };
  let failLedger = false;
  let tail = Promise.resolve();
  const dialect = new PgDialect();
  const db = {
    transaction: async (fn: any) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      const draft = structuredClone(state);
      const tx = {
        execute: async () => {},
        select: () => ({ from: (table: any) => ({ where: (condition: any) => ({
          for: async () => [draft.user],
          limit: async () => {
            assert.equal(table, schema.fundRequests);
            const ref = dialect.sqlToQuery(condition).params[0];
            return draft.orders.filter(row => row.proofImageData === ref);
          },
        }) }) }),
        update: (table: any) => ({ set: (patch: any) => ({ where: (condition: any) => {
          if (table === schema.users) { Object.assign(draft.user, patch); return Promise.resolve(); }
          const { params, sql } = dialect.sqlToQuery(condition);
          const row = draft.orders.find(row => row.id === params[0]);
          const allowed = row && row.receiveType === params[1] && params.slice(2).includes(row.status) &&
            (!sql.includes("is null") || row.proofImageData === null);
          if (allowed) Object.assign(row, patch);
          return { returning: async () => allowed ? [row] : [] };
        } }) }),
        insert: () => ({ values: async (entry: any) => {
          if (failLedger) throw new Error("LEDGER_FAILED");
          draft.ledger.push(entry);
        } }),
      };
      try { const result = await fn(tx); state = draft; return result; }
      finally { release(); }
    },
  };
  const routes = new Map<string, any>();
  const app = Object.fromEntries(["get", "post", "put", "delete"].map(method => [
    method, (path: string, ...handlers: any[]) => routes.set(`${method} ${path}`, handlers.at(-1)),
  ]));
  const module = { exports: {} as any };
  const compiled = ts.transpileModule(readFileSync("server/fundRequestRoutes.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dependencies: Record<string, any> = {
    "./db": { db }, "@shared/schema": schema, "drizzle-orm": drizzle,
    "./storage": { storage: { getFundRequest: async (id: string) => structuredClone(state.orders.find(row => row.id === id)) } },
    "./cancelRefund": { notifyCancellation: () => {} }, "./bankFunding": bankFunding,
  };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, require: (name: string) => {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
      return dependencies[name];
    }, console: { log() {}, error() {} },
  });
  module.exports.registerFundRequestRoutes(app);
  return {
    state: () => state,
    failLedger: () => { failLedger = true; },
    credit: async (id = "a", body: any = {}) => {
      const result = { status: 200, body: null as any };
      const res = { status: (code: number) => { result.status = code; return res; }, json: (value: any) => { result.body = value; return res; } };
      await routes.get("post /api/admin/fund-requests/:id/credit-wallet")({
        params: { id }, user: { id: "admin" },
        body: { bankReceiptVerified: true, bankTransactionReference: "receipt-123456", receivedAmount: "10.00", ...body },
      }, res);
      return result;
    },
  };
}

test("admin funding adds only its delta to stored balance despite pool drift", async () => {
  const h = fundingHarness();
  assert.equal((await h.credit()).status, 200);
  assert.equal(h.state().user.balance, "34.610000");
  assert.equal(h.state().user.adminCredits, "112.000000");
  assert.equal(h.state().ledger[0].balanceBefore, "24.610000");
});

test("concurrent admin completion credits once and receipt cannot fund another request", async () => {
  const h = fundingHarness();
  const results = await Promise.all([h.credit(), h.credit()]);
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal((await h.credit("b")).status, 409);
  assert.equal(h.state().ledger.length, 1);
});

test("receipt, actual receipt amount, and provider boundary fail closed", async () => {
  for (const body of [{ bankReceiptVerified: false }, { receivedAmount: "9" }, { receivedAmount: "NaN" }, { bankTransactionReference: "" }]) {
    const h = fundingHarness();
    assert.equal((await h.credit("a", body)).status, 400);
    assert.equal(h.state().ledger.length, 0);
  }
  const h = fundingHarness();
  h.state().orders[0].paymentMethod = "paypal";
  assert.equal((await h.credit()).status, 400);
});

test("cancelled/rejected/completed requests cannot credit and ledger failure rolls back", async () => {
  for (const status of ["cancelled", "rejected", "completed"]) {
    const h = fundingHarness();
    h.state().orders[0].status = status;
    assert.notEqual((await h.credit()).status, 200);
    assert.equal(h.state().ledger.length, 0);
  }
  const h = fundingHarness();
  h.failLedger();
  assert.equal((await h.credit()).status, 500);
  assert.equal(h.state().orders[0].status, "pending");
  assert.equal(h.state().user.balance, "24.610000");
});

test("all manual methods support pending and legacy paid wallet completion exactly once", async () => {
  for (const method of ["bank_transfer", "zelle", "cash_app", "western_union", "moneygram", "natcash"]) {
    for (const status of ["pending", "paid"]) {
      const h = fundingHarness();
      Object.assign(h.state().orders[0], { status, paymentMethod: method });
      assert.equal((await h.credit()).status, 200, `${method}/${status}`);
      assert.notEqual((await h.credit()).status, 200);
      assert.equal(h.state().ledger.length, 1);
      assert.equal(h.state().user.balance, "34.610000");
    }
  }
});

test("external payouts, including already paid PayPal destinations, cannot credit wallets", async () => {
  for (const status of ["pending", "paid"]) {
    const h = fundingHarness();
    Object.assign(h.state().orders[0], { status, receiveType: "paypal", paymentMethod: "western_union" });
    assert.equal((await h.credit()).status, 400);
    assert.equal(h.state().ledger.length, 0);
  }
});

test("cash spend/pickup/cancel use atomic claims and never external wallet fallback", () => {
  const source = readFileSync("server/cashPickRoutes.ts", "utf8");
  assert.match(source, /db\.transaction\(async \(tx\) => \{\s*await moveDepositWalletInTx/);
  assert.match(source, /const \[created\] = await tx\.insert\(cashPickTransactions\)/);
  assert.match(source, /eq\(cashPickTransactions\.status, "ready"\)\)\)\s*\.returning\(\)/);
  assert.match(source, /transaction\.paymentMethod === "wallet" && !isPayPalFunded/);
  assert.match(source, /isPayPalFunded && capture\?\.ok/);
  assert.doesNotMatch(source, /performSourceRefund|walletFallbackCredit|allocation\.remaining/);
  assert.match(source, /receipt\?\.status === "COMPLETED"/);
  assert.match(source, /refundAmount: refunded \? refundAmount : 0/);
});