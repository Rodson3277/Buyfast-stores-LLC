import assert from "node:assert/strict";
import test from "node:test";
import { getBundlePlatformServiceFee, calculateBundlePaypalQuote } from "./bundleServiceFee";

test("configured owner rate becomes a separate fee, without changing principal", () => {
  assert.equal(getBundlePlatformServiceFee(10, { topupCommissionPercentage: "5" }), 0.5);
});

test("zero and waived rates do not introduce fees", () => {
  assert.equal(getBundlePlatformServiceFee(10, { topupCommissionPercentage: "0" }), 0);
  assert.equal(getBundlePlatformServiceFee(10, { topupCommissionPercentage: "5", waiveFees: true }), 0);
});

test("currency-normalized principal uses cent rounding and rejects invalid configuration", () => {
  assert.equal(getBundlePlatformServiceFee(10.25, { topupCommissionPercentage: "5" }), 0.51);
  assert.throws(() => getBundlePlatformServiceFee(10, { topupCommissionPercentage: "bad" }));
});

test("PayPal quote adds owner surcharge once alongside existing fees, never cashback", () => {
  const quote = calculateBundlePaypalQuote({
    principal: 10, platformFee: getBundlePlatformServiceFee(10, { topupCommissionPercentage: "5" }),
    existingServiceFee: 1, processingFee: 0.3, internationalFee: 0.6,
  });
  assert.equal(quote.principal, 10);
  assert.equal(quote.serviceFee, 1.5);
  assert.equal(quote.actualServiceFee, 2.4);
  assert.equal(quote.totalPaid, 12.4);
});

test("PayPal discounts retain doubled existing fee policy, not doubled platform surcharge", () => {
  const quote = calculateBundlePaypalQuote({
    principal: 10, platformFee: 0.5, existingServiceFee: 1,
    processingFee: 0, internationalFee: 0,
    discount: { type: "percentage", value: 10 },
  });
  assert.equal(quote.principal, 10);
  assert.equal(quote.serviceFee, 2.5);
  assert.equal(quote.discount, 1.25);
  assert.equal(quote.totalPaid, 11.25);
});

test("PayPal zero-rate and fee waiver leave existing processing/international fees intact", () => {
  const base = { principal: 10, platformFee: 0, existingServiceFee: 0, processingFee: 0, internationalFee: 0 };
  assert.equal(calculateBundlePaypalQuote(base).totalPaid, 10);
  const waived = calculateBundlePaypalQuote({
    ...base, platformFee: 0.5, existingServiceFee: 1, processingFee: 0.3, internationalFee: 0.6, waiveFees: true,
  });
  assert.equal(waived.serviceFee, 0);
  assert.equal(waived.totalPaid, 10.9);
});

test("fixed promotion can reduce paid total without reducing provider principal", () => {
  const quote = calculateBundlePaypalQuote({
    principal: 10, platformFee: 0.5, existingServiceFee: 0, processingFee: 0, internationalFee: 0,
    discount: { type: "fixed", value: 2 },
  });
  assert.equal(quote.principal, 10);
  assert.equal(quote.totalPaid, 8.5);
});