import type { Request, Response, NextFunction } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { resolveUserId } from "../kycMiddleware";
import { RADAR_EXEMPT_EMAILS } from "../fraudRadar";

/**
 * COMPLIANCE SPENDING LIMITS (rolling windows, per user, all money-out services).
 *
 * Purpose: keep the platform's exposure low and stay under common US reporting
 * thresholds while operating without a money-transmitter license. These caps are
 * a risk-reduction / good-faith measure — they do NOT replace proper licensing.
 *
 * Defaults: $900 / 24h and $3,000 / 30d of committed spend per user. Committed
 * spend = completed + still-pending/processing transactions (refunded / failed /
 * cancelled are excluded). Owner/support accounts are exempt so the platform
 * stays operable and testable.
 */
export const DAILY_SPEND_LIMIT_USD = 900;
export const MONTHLY_SPEND_LIMIT_USD = 3000;

/** Money-out routes gated by the spending cap, mapped to the req.body field(s)
 * that hold the USD amount being spent. The first present, positive numeric
 * value wins; for gift cards the amount is multiplied by quantity. */
const SPEND_ROUTES: Record<string, string[]> = {
  // Wallet / inline flows
  "/api/topup": ["amount"],
  "/api/moncash/transfer": ["amount"],
  "/api/natcash/send": ["amount"],
  "/api/cash-pick/send": ["amountUSD", "amount"],
  "/api/giftcards/purchase": ["unitPrice"], // multiplied by quantity below
  "/api/bills/ding/pay": ["sendValue", "sendAmount", "amount"],
  "/api/bills/pay": ["amount", "sendAmount"],
  "/api/crypto/purchase": ["amountUsd", "amount"],
  // Dedicated PayPal / Stripe routes. We gate BOTH the initiation and the
  // value-committing (capture/complete) leg where the amount is present in the
  // body. This is double-count-safe because initiation rows are written with a
  // non-counted status (e.g. PayPal 'created'); the counted transaction row is
  // only inserted DURING the committing handler, i.e. AFTER this gate runs.
  // Gating the capture leg (not just initiation) closes the direct-capture
  // bypass where a PayPal order is minted via the public create-order endpoint
  // and then captured directly without passing the gated initiation route.
  "/api/topup/paypal/create-order": ["amount"],
  "/api/topup/paypal/capture-order": ["amount"],
  "/api/topup/paypal": ["amount"],
  // Stripe topup reserves committed spend atomically BEFORE intent creation.
  // Completion/replay is not a new purchase and must not count it again.
  "/api/bills/pay/stripe/complete": ["amount"],
  "/api/giftcards/purchase/stripe/complete": ["unitPrice"], // multiplied by quantity below
  // Cash Pick PayPal: the capture leg carries no amount in its body (amount is
  // read authoritatively from PayPal inside the handler), so the order-creation
  // route is the enforcement point for this flow.
  "/api/cash-pick/paypal/order": ["enteredAmount"],
};

export interface SpendingUsage {
  daily: number;
  monthly: number;
}

/** Sum a user's committed spend across every money-out service for the rolling
 * 24h and 30d windows. One query; FAIL-OPEN (returns zeros) on any error so an
 * infra hiccup never blocks legitimate users. */
export async function getUserSpending(userId: string, executor: Pick<typeof db, "execute"> = db, failClosed = false): Promise<SpendingUsage> {
  try {
    const result: any = await executor.execute(sql`
      WITH spend AS (
        SELECT user_id AS uid, amount::numeric AS amt,
          CASE WHEN payment_method = 'stripe' AND status IN ('pending','processing')
            THEN now()
            WHEN payment_method = 'stripe' AND status = 'completed'
            THEN COALESCE((metadata->>'stripeSettledAt')::timestamptz, updated_at, created_at)
            ELSE created_at END AS ts
          FROM transactions
          WHERE type = 'topup' AND status IN ('completed','pending','processing')
        UNION ALL
        SELECT user_id, amount::numeric, created_at
          FROM moncash_transfers WHERE status IN ('completed','pending','processing')
        UNION ALL
        SELECT user_id, amount::numeric, created_at
          FROM natcash_transfers WHERE status IN ('completed','pending','processing')
        UNION ALL
        SELECT user_id, amount::numeric, created_at
          FROM bill_transactions WHERE status IN ('completed','pending','processing')
        UNION ALL
        SELECT user_id, amount::numeric, created_at
          FROM gift_card_transactions WHERE status IN ('completed','pending','processing')
        UNION ALL
        SELECT user_id, amount_usd::numeric, created_at
          FROM crypto_purchase_requests WHERE status IN ('completed','pending','processing')
        UNION ALL
        SELECT sender_id, amount_usd::numeric, created_at
          FROM cash_pick_transactions WHERE status IN ('pending','ready','picked_up')
      )
      SELECT
        COALESCE(SUM(amt) FILTER (WHERE ts >= now() - interval '24 hours'), 0) AS daily,
        COALESCE(SUM(amt) FILTER (WHERE ts >= now() - interval '30 days'), 0) AS monthly
      FROM spend
      WHERE uid = ${userId};
    `);
    const row = (result?.rows ?? result)?.[0] ?? {};
    return {
      daily: parseFloat(row.daily ?? "0") || 0,
      monthly: parseFloat(row.monthly ?? "0") || 0,
    };
  } catch (error) {
    if (failClosed) throw error;
    console.error("⚠️ getUserSpending failed (fail-open):", error);
    return { daily: 0, monthly: 0 };
  }
}

function extractAmount(req: Request, fields: string[]): number {
  const body = (req.body ?? {}) as Record<string, any>;
  for (const f of fields) {
    const v = parseFloat(body[f]);
    if (!isNaN(v) && v > 0) {
      if (req.path.startsWith("/api/giftcards/purchase")) {
        const qty = parseInt(body.quantity, 10);
        return qty && qty > 0 ? v * qty : v;
      }
      return v;
    }
  }
  return 0;
}

/**
 * Express middleware: blocks a money-out request when it would push the user
 * over the rolling daily or monthly spend cap. Owner/support exempt. FAIL-OPEN
 * on any internal error so legitimate users are never blocked by an infra issue.
 */
export async function spendingLimitGate(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (req.method !== "POST") return next();
    const fields = SPEND_ROUTES[req.path];
    if (!fields) return next();

    const amount = extractAmount(req, fields);
    if (amount <= 0) return next(); // let the route's own validation handle it

    const userId = resolveUserId(req);
    if (!userId) return next(); // auth gate handles missing user

    // Owner/support are never capped.
    try {
      const u = await storage.getUser(userId);
      if (u?.email && RADAR_EXEMPT_EMAILS.includes(u.email.toLowerCase())) {
        return next();
      }
    } catch {
      // fall through to the limit check
    }

    const { daily, monthly } = await getUserSpending(userId);

    if (daily + amount > DAILY_SPEND_LIMIT_USD) {
      const remaining = Math.max(0, DAILY_SPEND_LIMIT_USD - daily);
      console.log(`🔒 SPEND LIMIT (daily) user=${userId} used=${daily.toFixed(2)} + ${amount.toFixed(2)} > ${DAILY_SPEND_LIMIT_USD}`);
      return res.status(403).json({
        error: "DAILY_SPENDING_LIMIT_EXCEEDED",
        message: `For security and compliance, daily transactions are limited to $${DAILY_SPEND_LIMIT_USD.toLocaleString()}. You have $${remaining.toFixed(2)} remaining today. Please try again tomorrow.`,
        limit: DAILY_SPEND_LIMIT_USD,
        used: Number(daily.toFixed(2)),
        remaining: Number(remaining.toFixed(2)),
        window: "24h",
      });
    }

    if (monthly + amount > MONTHLY_SPEND_LIMIT_USD) {
      const remaining = Math.max(0, MONTHLY_SPEND_LIMIT_USD - monthly);
      console.log(`🔒 SPEND LIMIT (monthly) user=${userId} used=${monthly.toFixed(2)} + ${amount.toFixed(2)} > ${MONTHLY_SPEND_LIMIT_USD}`);
      return res.status(403).json({
        error: "MONTHLY_SPENDING_LIMIT_EXCEEDED",
        message: `For security and compliance, monthly transactions are limited to $${MONTHLY_SPEND_LIMIT_USD.toLocaleString()}. You have $${remaining.toFixed(2)} remaining this month.`,
        limit: MONTHLY_SPEND_LIMIT_USD,
        used: Number(monthly.toFixed(2)),
        remaining: Number(remaining.toFixed(2)),
        window: "30d",
      });
    }

    return next();
  } catch (error) {
    console.error("⚠️ spendingLimitGate error (fail-open):", error);
    return next();
  }
}
