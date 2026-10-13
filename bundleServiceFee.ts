/**
 * Owner/platform revenue rate used by CommissionService.globalCommissionRate.
 * platformCommissionPercentage is cashback, not a customer surcharge.
 */
export function getBundlePlatformServiceFee(
  principalUSD: number,
  user: { topupCommissionPercentage?: string | number | null; waiveFees?: boolean } | null | undefined,
): number {
  if (user?.waiveFees === true) return 0;
  const rate = Number(user?.topupCommissionPercentage ?? 0);
  if (!Number.isFinite(principalUSD) || principalUSD < 0 || !Number.isFinite(rate) || rate < 0) {
    throw new Error("Invalid bundle service-fee configuration");
  }
  return Math.round((principalUSD * rate / 100 + Number.EPSILON) * 100) / 100;
}

export function calculateBundlePaypalQuote(input: {
  principal: number; platformFee: number; existingServiceFee: number;
  processingFee: number; internationalFee: number; waiveFees?: boolean;
  discount?: { type: string; value: number; maxDiscount?: number };
}) {
  const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  const values = [input.principal, input.platformFee, input.existingServiceFee, input.processingFee, input.internationalFee];
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error("Invalid bundle quote");
  const serviceFee = input.waiveFees ? 0 : round(
    input.existingServiceFee * (input.discount ? 2 : 1) + input.platformFee,
  );
  const processingFee = round(input.processingFee);
  const internationalFee = round(input.internationalFee);
  const subtotal = round(input.principal + serviceFee + processingFee + internationalFee);
  let discount = input.discount
    ? (input.discount.type === "percentage" ? subtotal * input.discount.value / 100 : input.discount.value)
    : 0;
  if (!Number.isFinite(discount) || discount < 0) throw new Error("Invalid bundle discount");
  if (input.discount?.maxDiscount) discount = Math.min(discount, input.discount.maxDiscount);
  discount = round(Math.min(subtotal, discount));
  return {
    principal: input.principal, serviceFee, processingFee, internationalFee,
    discount, totalPaid: round(subtotal - discount),
    actualServiceFee: round(serviceFee + processingFee + internationalFee),
  };
}