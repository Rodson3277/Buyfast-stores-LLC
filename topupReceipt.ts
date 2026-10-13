export interface BundleReceiptBreakdown {
  principal: number;
  serviceFee: number;
  discount: number;
  totalPaid: number;
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function metadataOf(transaction: any): any {
  const raw = transaction?.metadata;
  if (typeof raw !== "string") return raw || {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Returns a receipt breakdown only for transactions explicitly persisted as
 * fixed bundles. This deliberately does not infer or fabricate fees for old
 * top-ups that lack bundle/charge metadata.
 */
export function getBundleReceiptBreakdown(transaction: any): BundleReceiptBreakdown | null {
  // Wallet ledger amounts are debits, not provider principals. Use only the
  // server's ownership-checked related-transaction receipt for linked debits.
  if (transaction?.transactionType === "wallet") {
    const linked = transaction?.linkedTopupReceipt;
    if (!linked || linked.id !== transaction.relatedTransactionId || linked.transactionType !== "topup") return null;
    return getBundleReceiptBreakdown(linked);
  }
  const metadata = metadataOf(transaction);
  const commission = metadata?.dualCommission || {};
  if (metadata?.feeFundedBundle !== true && commission?.feeFundedBundle !== true) return null;

  const principal = finiteNumber(transaction?.amount);
  if (principal === undefined || principal < 0) return null;

  const persistedFee =
    finiteNumber(metadata?.actualServiceFee) ??
    finiteNumber(transaction?.fee);
  const actualGross =
    finiteNumber(commission?.actualGross) ??
    finiteNumber(metadata?.actualGross) ??
    finiteNumber(metadata?.actualCustomerCharge);

  // New zero-fee bundles explicitly persist actualGross and actualServiceFee.
  // If neither is available, do not invent a historical breakdown.
  if (persistedFee === undefined && actualGross === undefined) return null;

  const totalPaid = actualGross ?? principal + Math.max(0, persistedFee!);
  const serviceFee = persistedFee ?? Math.max(0, totalPaid - principal);
  const discount = Math.max(0, Number((principal + serviceFee - totalPaid).toFixed(6)));

  return {
    principal,
    serviceFee: Math.max(0, serviceFee),
    discount,
    totalPaid: Math.max(0, totalPaid),
  };
}