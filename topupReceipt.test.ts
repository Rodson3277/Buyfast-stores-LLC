import assert from "node:assert/strict";
import test from "node:test";
import { getBundleReceiptBreakdown } from "./topupReceipt";

test("$10 bundle receipt shows $10 principal + $1 service fee = $11 paid", () => {
  assert.deepEqual(getBundleReceiptBreakdown({
    amount: "10.00",
    fee: "1.00",
    metadata: {
      feeFundedBundle: true,
      actualServiceFee: 1,
      dualCommission: { feeFundedBundle: true, actualGross: 11, cashback: 0.25 },
    },
  }), { principal: 10, serviceFee: 1, discount: 0, totalPaid: 11 });
});

test("explicit zero-fee bundle displays zero without fabricating a charge", () => {
  assert.deepEqual(getBundleReceiptBreakdown({
    amount: "10.00",
    fee: "0.00",
    metadata: {
      feeFundedBundle: true,
      actualServiceFee: 0,
      dualCommission: { feeFundedBundle: true, actualGross: 10 },
    },
  }), { principal: 10, serviceFee: 0, discount: 0, totalPaid: 10 });
});

test("promotion uses persisted actual gross and does not add cashback to paid total", () => {
  assert.deepEqual(getBundleReceiptBreakdown({
    amount: "10.00",
    fee: "0.50",
    metadata: {
      feeFundedBundle: true,
      actualServiceFee: 0.5,
      dualCommission: { feeFundedBundle: true, actualGross: 10.5, cashback: 0.25 },
    },
  }), { principal: 10, serviceFee: 0.5, discount: 0, totalPaid: 10.5 });
});

test("$10 principal with no fee and a $1 discount keeps the exact $9 paid total", () => {
  assert.deepEqual(getBundleReceiptBreakdown({
    amount: "10.00",
    fee: "0.00",
    metadata: {
      feeFundedBundle: true,
      actualServiceFee: 0,
      dualCommission: { feeFundedBundle: true, actualGross: 9 },
    },
  }), { principal: 10, serviceFee: 0, discount: 1, totalPaid: 9 });
});

test("legacy top-up without explicit bundle charge metadata has no invented breakdown", () => {
  assert.equal(getBundleReceiptBreakdown({ amount: "10.00", fee: "0.00" }), null);
});

test("linked wallet debit uses the related top-up principal, not the debit as principal", () => {
  const transaction = {
    transactionType: "wallet", amount: "10.50", relatedTransactionId: "topup-1",
    linkedTopupReceipt: {
      id: "topup-1", transactionType: "topup", amount: "10", fee: "0.5",
      metadata: { feeFundedBundle: true, actualServiceFee: 0.5, actualGross: 10.5 },
    },
  };
  assert.deepEqual(getBundleReceiptBreakdown(transaction), {
    principal: 10, serviceFee: 0.5, discount: 0, totalPaid: 10.5,
  });
  assert.equal(getBundleReceiptBreakdown({ ...transaction, relatedTransactionId: "other" }), null);
});