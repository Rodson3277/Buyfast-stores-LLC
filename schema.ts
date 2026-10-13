import { sql } from 'drizzle-orm';
import {
  index,
  uniqueIndex,
  primaryKey,
  jsonb,
  pgTable,
  timestamp,
  varchar,
  text,
  decimal,
  integer,
  boolean,
  uuid,
  serial,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Session storage table for Replit Auth
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// Users table  
export const users: any = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  password: varchar("password"), // Hashed password for secure authentication
  firstName: varchar("first_name"),
  middleName: varchar("middle_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  phoneNumber: varchar("phone_number"),
  isAdmin: boolean("is_admin").default(false),
  isSuperAdmin: boolean("is_super_admin").default(false),
  isOwner: boolean("is_owner").default(false),
  balance: decimal("balance", { precision: 18, scale: 6 }).default("0.00"), // Preserve six-decimal precision and room for reversal liabilities.
  investorCredits: decimal("investor_credits", { precision: 18, scale: 6 }).default("0.00"),
  adminCredits: decimal("admin_credits", { precision: 18, scale: 6 }).default("0.00"),
  otherCredits: decimal("other_credits", { precision: 18, scale: 6 }).default("0.00"),
  adminDebitOutstanding: decimal("admin_debit_outstanding", { precision: 18, scale: 6 }).default("0.00"),
  loyaltyPoints: integer("loyalty_points").default(0),
  referralCode: varchar("referral_code").unique(),
  referredBy: varchar("referred_by"),
  investorCode: varchar("investor_code"),
  haitiCommissionEnabled: boolean("haiti_commission_enabled").default(true), // Allow investor to enable/disable commission per user
  haitiCommissionRate: decimal("haiti_commission_rate", { precision: 5, scale: 2 }).default("10.00"), // Custom commission rate per user (default 10%)
  topupCommissionPercentage: decimal("topup_commission_percentage", { precision: 5, scale: 2 }).default("0.00"), // Admin commission % on topups (deducted before sending to Reloadly/Ding)
  platformCommissionPercentage: decimal("platform_commission_percentage", { precision: 5, scale: 2 }).default("0.00"), // Platform commission % on topups (formerly global, now per-user configurable)
  // MonCash/NatCash cashback rates per user (set by admin)
  moncashCustomerCashback: decimal("moncash_customer_cashback", { precision: 5, scale: 2 }).default("0.00"), // % credited to user wallet after MonCash transfer
  moncashPlatformCashback: decimal("moncash_platform_cashback", { precision: 5, scale: 2 }).default("0.00"), // % deducted from sent amount as platform profit
  natcashCustomerCashback: decimal("natcash_customer_cashback", { precision: 5, scale: 2 }).default("0.00"), // % credited to user wallet after NatCash transfer
  natcashPlatformCashback: decimal("natcash_platform_cashback", { precision: 5, scale: 2 }).default("0.00"), // % deducted from sent amount as platform profit
  availableCommission: decimal("available_commission", { precision: 10, scale: 2 }).default("0.00"), // Total commission admin can collect from topups
  globalTopupCommissionBalance: decimal("global_topup_commission_balance", { precision: 10, scale: 2 }).default("0.00"), // Balance from global topup commission (applies to ALL topups)
  language: varchar("language").default("en"),
  preferredCurrency: varchar("preferred_currency").default("USD"), // User's preferred display currency for emails/PDFs
  themePreference: varchar("theme_preference").default("auto"), // 'light', 'dark', 'auto'
  themeAutoTime: boolean("theme_auto_time").default(true), // Enable time-based theme switching
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  isBlocked: boolean("is_blocked").default(false),
  isAgent: boolean("is_agent").default(false), // BuyFast Pick Up agent - can access agent portal
  blockedReason: text("blocked_reason"),
  blockedBy: varchar("blocked_by").references(() => users.id),
  blockedAt: timestamp("blocked_at"),
  multiAccountWarningAt: timestamp("multi_account_warning_at"), // Set when 2+ accounts detected on same device; auto-block after 24h
  deleteRequestedAt: timestamp("delete_requested_at"), // Set when user requests account deletion; auto-delete after 24h if not cancelled
  fraudDebtAmount: decimal("fraud_debt_amount", { precision: 18, scale: 2 }).default("0.00"),
  fraudDebtReason: text("fraud_debt_reason"),
  fraudDebtCreatedAt: timestamp("fraud_debt_created_at"),
  hasPlayedWelcomeBox: boolean("has_played_welcome_box").default(false),
  emailVerified: boolean("email_verified").default(false),
  // Kept false at the database level so schema publication never opts existing
  // customers into onboarding. New accounts are explicitly opted in by
  // DatabaseStorage.upsertUser.
  onboardingRequired: boolean("onboarding_required").notNull().default(false),
  emailVerificationCode: varchar("email_verification_code"),
  emailVerificationExpires: timestamp("email_verification_expires"),
  emailNotifications: boolean("email_notifications").default(true),
  smsNotifications: boolean("sms_notifications").default(true),
  waiveFees: boolean("waive_fees").default(false), // Admin can disable service fees for specific users
  walletCardFrozen: boolean("wallet_card_frozen").default(false), // User-controlled freeze for BuyFast Wallet Card; blocks all wallet-funded payments
  walletCardFrozenAt: timestamp("wallet_card_frozen_at"), // Last time the card was frozen
  // KYC/ID Verification fields
  kycStatus: varchar("kyc_status").default("unverified"), // 'unverified', 'pending_review', 'info_requested', 'resubmitted', 'verified', 'rejected', 'expired', 'escalated'
  kycLevel: varchar("kyc_level").default("1"), // "1" = basic, "2" = enhanced
  kycVerifiedAt: timestamp("kyc_verified_at"),
  stripeCustomerId: varchar("stripe_customer_id"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// One immutable identity-bound onboarding response per user. PUT uses an
// idempotent upsert so a user can safely resubmit/update their questionnaire.
export const onboardingResponses = pgTable("onboarding_responses", {
  userId: varchar("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  answers: jsonb("answers").notNull(),
  language: varchar("language", { length: 2 }).notNull(),
  completedAt: timestamp("completed_at").notNull().defaultNow(),
});

// Email verification logs table
export const emailVerifications = pgTable("email_verifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  email: varchar("email").notNull(),
  verificationCode: varchar("verification_code").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  isUsed: boolean("is_used").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// Password reset tokens table
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  email: varchar("email").notNull(),
  hashedToken: varchar("hashed_token").notNull(), // Store hashed token for security
  expiresAt: timestamp("expires_at").notNull(), // Token expires after 20 minutes
  usedAt: timestamp("used_at"), // Timestamp when token was used (null if unused)
  createdAt: timestamp("created_at").defaultNow(),
});

// Countries table
export const countries = pgTable("countries", {
  id: varchar("id").primaryKey(),
  name: varchar("name").notNull(),
  code: varchar("code", { length: 2 }).notNull(),
  flag: varchar("flag"),
  currency: varchar("currency"),
  prefix: varchar("prefix"),
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
});

// Exchange rates table for multi-currency conversion
export const exchangeRates = pgTable("exchange_rates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  currencyCode: varchar("currency_code", { length: 3 }).notNull().unique(),
  currencyName: varchar("currency_name").notNull(),
  currencySymbol: varchar("currency_symbol").notNull(),
  rateToUSD: decimal("rate_to_usd", { precision: 18, scale: 8 }).notNull(), // High precision for accuracy
  lastUpdated: timestamp("last_updated").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Mobile operators table
export const operators = pgTable("operators", {
  id: varchar("id").primaryKey(),
  name: varchar("name").notNull(),
  countryId: varchar("country_id").references(() => countries.id),
  logo: varchar("logo"),
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  reloadlyId: varchar("reloadly_id"),
  minAmount: decimal("min_amount", { precision: 10, scale: 2 }),
  maxAmount: decimal("max_amount", { precision: 10, scale: 2 }),
});

// Transactions table
export const transactions = pgTable("transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id), // Nullable for guest transactions
  type: varchar("type").notNull(), // 'topup', 'wallet_deposit', 'wallet_withdrawal'
  amount: decimal("amount", { precision: 10, scale: 6 }).notNull(), // 🔧 HTG FIX: 6 decimals for exact HTG→USD conversion (150÷132=1.136363)
  fee: decimal("fee", { precision: 10, scale: 6 }).default("0.00"), // 🔧 HTG FIX: 6 decimals for precision
  currency: varchar("currency").default("USD"),
  destinationAmount: decimal("destination_amount", { precision: 10, scale: 2 }), // Amount received in local currency
  destinationCurrency: varchar("destination_currency"), // Local currency (e.g. GDS for Haiti)
  exchangeRate: decimal("exchange_rate", { precision: 10, scale: 4 }), // 🔧 PDF FIX: Exchange rate for currency conversion
  recipientPhone: varchar("recipient_phone"),
  operatorId: varchar("operator_id"), // Remove foreign key constraint - using dynamic Reloadly operators
  countryId: varchar("country_id"), // Remove foreign key constraint - using dynamic Reloadly countries
  status: varchar("status").notNull(), // 'pending', 'completed', 'failed', 'phone_failed', 'technical_failed', 'cancelled', 'refunded'
  paymentMethod: varchar("payment_method"), // 'wallet', 'paypal', 'moncash'
  externalTransactionId: varchar("external_transaction_id"),
  reloadlyTransactionId: varchar("reloadly_transaction_id"),
  errorMessage: text("error_message"),
  description: text("description"), // Added description field
  metadata: jsonb("metadata"),
  // Credit Source Tracking for Commission Calculation
  fundingBreakdown: jsonb("funding_breakdown"), // { investorCredits: X, adminCredits: Y, otherCredits: Z }
  // Fraud Prevention & Device Tracking
  ipAddress: varchar("ip_address"), // Client IP address
  deviceFingerprint: varchar("device_fingerprint"), // Device fingerprint reference
  paymentSourceRef: varchar("payment_source_ref"), // Payment method reference hash
  paymentProvider: varchar("payment_provider"), // 'paypal', 'stripe', 'moncash'
  paymentSourceLast4: varchar("payment_source_last4"), // Last 4 digits of payment method
  paymentNetwork: varchar("payment_network"), // Visa, Mastercard, etc.
  // Chargeback Protection & Legal Evidence
  termsAcceptedAt: timestamp("terms_accepted_at"), // When user accepted terms
  termsAcceptedIp: varchar("terms_accepted_ip"), // IP address when accepting terms
  userAgent: varchar("user_agent"), // Browser/device user agent
  guestEmail: varchar("guest_email"), // Email for guest transactions
  // Discount Code Tracking
  discountCodeId: varchar("discount_code_id"), // Reference to discount_codes.id (no FK constraint - code might be deleted)
  discountAmount: decimal("discount_amount", { precision: 10, scale: 6 }), // Amount saved with discount
  originalAmount: decimal("original_amount", { precision: 10, scale: 6 }), // Amount before discount
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// PayPal Order Tracking table for fraud prevention
export const paypalOrderTracking = pgTable("paypal_order_tracking", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  paypalOrderId: varchar("paypal_order_id").notNull().unique(),
  status: varchar("status").notNull().default("created"), // 'created', 'processing', 'completed', 'failed'
  userId: varchar("user_id"),
  amount: decimal("amount", { precision: 10, scale: 6 }).notNull(), // 🔧 HTG FIX: 6 decimals for precision
  currency: varchar("currency").notNull().default("USD"),
  recipientPhone: varchar("recipient_phone"),
  operatorId: varchar("operator_id"),
  countryId: varchar("country_id"),
  isGuestTransaction: boolean("is_guest_transaction").notNull().default(false),
  serviceType: varchar("service_type"), // 'natcash', 'moncash', 'topup', 'wallet', 'gift_card', etc.
  transactionId: varchar("transaction_id"), // Link to main transaction
  baseAmount: decimal("base_amount", { precision: 10, scale: 6 }), // Amount to credit to wallet (without fees)
  processedAt: timestamp("processed_at"),
  clientIp: varchar("client_ip"),
  userAgent: varchar("user_agent"),
  reminderCount: integer("reminder_count").default(0),
  reminderSentAt: timestamp("reminder_sent_at"),
  lastReminderAt: timestamp("last_reminder_at"),
  // ── Anti-Fraud & Chargeback Defense columns ──────────────────────────────
  // Populated after every PayPal capture — stored as dispute/chargeback evidence
  captureId: varchar("capture_id"),               // PayPal payment capture ID (for refunds/disputes)
  payerEmail: varchar("payer_email"),             // Buyer's verified PayPal email
  payerName: varchar("payer_name"),               // Buyer's full name from PayPal
  sellerProtectionStatus: varchar("seller_protection_status"), // ELIGIBLE | NOT_ELIGIBLE | PARTIALLY_ELIGIBLE
  liabilityShifted: boolean("liability_shifted"),  // true = bank liable (3DS), false = we may be liable
  threeDsAuthResult: varchar("three_ds_auth_result"), // Y=auth, A=attempt, U=unavailable, N=failed
  rawCaptureResponse: text("raw_capture_response"), // Full PayPal capture JSON (dispute evidence)
  deliveryProof: text("delivery_proof"),           // JSON: Reloadly/provider delivery confirmation
  fraudDataSent: text("fraud_data_sent"),          // JSON: anti-fraud fields we sent to PayPal
  // ─────────────────────────────────────────────────────────────────────────
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Wallet transactions table
// Application fulfillment/order state, not a duplicate of Stripe's managed mirror.
export const stripePaymentOrders = pgTable("stripe_payment_orders", {
  id: varchar("id").primaryKey(),
  livemode: boolean("livemode").notNull().default(false),
  stripeAccountId: varchar("stripe_account_id"),
  providerReference: varchar("provider_reference"),
  pricingSnapshot: jsonb("pricing_snapshot"),
  userId: varchar("user_id").notNull().references(() => users.id),
  requestKey: varchar("request_key").notNull().unique(),
  purpose: varchar("purpose").notNull(),
  principalCents: integer("principal_cents").notNull(),
  feeCents: integer("fee_cents").notNull(),
  totalCents: integer("total_cents").notNull(),
  operatorId: varchar("operator_id"),
  recipientPhone: varchar("recipient_phone"),
  paymentIntentId: varchar("payment_intent_id").unique(),
  state: varchar("state").notNull().default("created"),
  transactionId: varchar("transaction_id").unique().references(() => transactions.id),
  checkedAt: timestamp("checked_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const walletTransactions = pgTable("wallet_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  type: varchar("type").notNull(), // 'deposit', 'withdrawal', 'topup', 'refund', 'bonus', 'admin_credit', 'admin_debit'
  amount: decimal("amount", { precision: 18, scale: 6 }).notNull(),
  balanceBefore: decimal("balance_before", { precision: 18, scale: 6 }),
  balanceAfter: decimal("balance_after", { precision: 18, scale: 6 }),
  creditType: varchar("credit_type"), // 'investor', 'admin', 'other' - which credit pool this affects
  description: text("description"),
  relatedTransactionId: varchar("related_transaction_id").references(() => transactions.id),
  status: varchar("status").default("completed"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Promotions table
export const squareWalletIntents = pgTable("square_wallet_intents", {
  id: varchar("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => users.id),
  requestId: varchar("request_id").notNull(),
  locationId: varchar("location_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  feeCents: integer("fee_cents").notNull(),
  totalCents: integer("total_cents").notNull(),
  status: varchar("status").notNull().default("created"),
  orderId: varchar("order_id").unique(),
  paymentId: varchar("payment_id").unique(),
  transactionId: varchar("transaction_id").unique().references(() => transactions.id),
  credited: boolean("credited").notNull().default(false),
  reversed: boolean("reversed").notNull().default(false),
  errorCode: varchar("error_code"),
  termsAcceptedAt: timestamp("terms_accepted_at").notNull().defaultNow(),
  ipAddress: varchar("ip_address").notNull(),
  userAgent: varchar("user_agent").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  checkedAt: timestamp("checked_at").notNull().defaultNow(),
  lastAttemptAt: timestamp("last_attempt_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("square_wallet_user_request_idx").on(table.userId, table.requestId),
  index("square_wallet_monitor_idx").on(table.status, table.checkedAt),
  index("square_wallet_attempt_idx").on(table.status, table.lastAttemptAt),
]);
export type SquareWalletIntent = typeof squareWalletIntents.$inferSelect;

export const promotions = pgTable("promotions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: varchar("title").notNull(),
  description: text("description"),
  code: varchar("code").unique(),
  promotionType: varchar("promotion_type").notNull().default("all"), // 'wallet', 'topup', 'all'
  discountType: varchar("discount_type").notNull(), // 'percentage', 'fixed'
  discountValue: decimal("discount_value", { precision: 5, scale: 2 }).notNull(),
  minAmount: decimal("min_amount", { precision: 10, scale: 2 }),
  maxDiscount: decimal("max_discount", { precision: 10, scale: 2 }),
  usageLimit: integer("usage_limit"),
  usageCount: integer("usage_count").default(0),
  imageUrl: varchar("image_url"), // Photo upload field
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  createdAt: timestamp("created_at").defaultNow(),
});

// User promotions (usage tracking)
export const userPromotions = pgTable("user_promotions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  promotionId: varchar("promotion_id").references(() => promotions.id).notNull(),
  transactionId: varchar("transaction_id").references(() => transactions.id),
  usedAt: timestamp("used_at").defaultNow(),
});

// Loyalty rewards table
export const loyaltyRewards = pgTable("loyalty_rewards", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: varchar("title").notNull(),
  description: text("description"),
  pointsCost: integer("points_cost").notNull(),
  rewardType: varchar("reward_type").notNull(), // 'discount', 'free_topup'
  rewardValue: decimal("reward_value", { precision: 10, scale: 2 }).notNull(),
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  createdAt: timestamp("created_at").defaultNow(),
});

// User loyalty redemptions
export const loyaltyRedemptions = pgTable("loyalty_redemptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  rewardId: varchar("reward_id").references(() => loyaltyRewards.id).notNull(),
  pointsSpent: integer("points_spent").notNull(),
  transactionId: varchar("transaction_id").references(() => transactions.id),
  redeemedAt: timestamp("redeemed_at").defaultNow(),
});

// Referrals table
export const referrals = pgTable("referrals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  referrerId: varchar("referrer_id").references(() => users.id).notNull(),
  refereeId: varchar("referee_id").references(() => users.id).notNull(),
  bonusAmount: decimal("bonus_amount", { precision: 10, scale: 2 }).default("0.50"),
  referrerBonusAmount: decimal("referrer_bonus_amount", { precision: 10, scale: 2 }).default("0.50"),
  status: varchar("status").default("pending"), // 'pending', 'completed'
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Invite codes table
export const inviteCodes = pgTable("invite_codes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  code: varchar("code").notNull().unique(),
  description: text("description").notNull(),
  bonusAmount: decimal("bonus_amount", { precision: 10, scale: 2 }).default("0.50"),
  maxUses: integer("max_uses").default(100),
  currentUses: integer("current_uses").default(0),
  expiresAt: timestamp("expires_at").notNull(),
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Support tickets table
export const supportTickets = pgTable("support_tickets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  subject: varchar("subject").notNull(),
  message: text("message").notNull(),
  status: varchar("status").default("open"), // 'open', 'in_progress', 'resolved', 'closed'
  priority: varchar("priority").default("medium"), // 'low', 'medium', 'high', 'urgent'
  assignedTo: varchar("assigned_to").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Support ticket replies table
export const supportTicketReplies = pgTable("support_ticket_replies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ticketId: varchar("ticket_id").references(() => supportTickets.id).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  message: text("message").notNull(),
  isAdminReply: boolean("is_admin_reply").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Reviews table
export const reviews = pgTable("reviews", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  rating: integer("rating").notNull(), // 1-5 stars
  title: varchar("title").notNull(),
  comment: text("comment").notNull(),
  isApproved: boolean("is_approved").default(false),
  isPublic: boolean("is_public").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Notifications table for admin-to-user notifications
export const notifications = pgTable("notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  titleEn: varchar("title_en").notNull(),
  titleFr: varchar("title_fr").notNull(),
  titleEs: varchar("title_es").notNull(),
  titleHt: varchar("title_ht").notNull(),
  messageEn: text("message_en").notNull(),
  messageFr: text("message_fr").notNull(),
  messageEs: text("message_es").notNull(),
  messageHt: text("message_ht").notNull(),
  type: varchar("type").default("general"), // 'general', 'promotion', 'warning', 'success', 'announcement'
  targetType: varchar("target_type").default("all"), // 'all', 'specific', 'admin'
  targetUserId: varchar("target_user_id").references(() => users.id), // for specific users
  isRead: boolean("is_read").default(false),
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  priority: varchar("priority").default("medium"), // 'low', 'medium', 'high', 'urgent'
  expiresAt: timestamp("expires_at"), // optional expiration
  createdBy: varchar("created_by").references(() => users.id), // admin who created (nullable for system-generated)
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type Notification = typeof notifications.$inferSelect;
export type InsertNotification = typeof notifications.$inferInsert;

// Blocked-account security appeals — questionnaire submitted by blocked users
export const blockAppeals = pgTable("block_appeals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id"),
  email: varchar("email"),
  fullName: varchar("full_name"),
  blockedReason: text("blocked_reason"),
  answers: jsonb("answers").$type<{ key: string; question: string; answer: string }[]>().default(sql`'[]'::jsonb`),
  bankInfo: text("bank_info"),
  status: varchar("status").default("pending"), // 'pending' | 'reviewed'
  reviewedBy: varchar("reviewed_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type BlockAppeal = typeof blockAppeals.$inferSelect;
export type InsertBlockAppeal = typeof blockAppeals.$inferInsert;

// Invite page settings table
export const invitePageSettings = pgTable("invite_page_settings", {
  id: varchar("id").primaryKey().default("default"),
  title: varchar("title").default("Invite Friends & Earn Bonuses!"),
  description: text("description").default("Refer your friends to BuyFast TopUp and earn $5 for each successful referral. Your friends also get a $5 bonus when they join!"),
  bonusAmount: decimal("bonus_amount", { precision: 10, scale: 2 }).default("0.50"),
  referrerBonusAmount: decimal("referrer_bonus_amount", { precision: 10, scale: 2 }).default("0.50"),
  minimumTopupAmount: decimal("minimum_topup_amount", { precision: 10, scale: 2 }).default("20.00"),
  shareMessage: text("share_message").default("Join BuyFast TopUp with my code {CODE} and get ${BONUS} bonus! {LINK}"),
  whatsappEnabled: boolean("whatsapp_enabled").default(true),
  smsEnabled: boolean("sms_enabled").default(true),
  emailEnabled: boolean("email_enabled").default(true),
  socialEnabled: boolean("social_enabled").default(true),
  backgroundColor: varchar("background_color").default("#F97316"),
  headerColor: varchar("header_color").default("#EC4899"),
  textColor: varchar("text_color").default("#FFFFFF"),
  buttonColor: varchar("button_color").default("#EC008C"),
  logoSize: integer("logo_size").default(8),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Fee structure table
export const feeStructures = pgTable("fee_structures", {
  id: varchar("id").primaryKey().default("default"),
  walletTopupFee: decimal("wallet_topup_fee", { precision: 5, scale: 2 }).default("0.00"),
  paypalTopupFee: decimal("paypal_topup_fee", { precision: 5, scale: 2 }).default("10.00"),
  paypalProcessingFee: decimal("paypal_processing_fee", { precision: 5, scale: 2 }).default("3.49"),
  paypalFixedFee: decimal("paypal_fixed_fee", { precision: 5, scale: 2 }).default("0.49"),
  walletFundingFee: decimal("wallet_funding_fee", { precision: 5, scale: 2 }).default("5.00"),
  guestServiceFee: decimal("guest_service_fee", { precision: 5, scale: 2 }).default("30.00"),
  minimumTopupAmount: decimal("minimum_topup_amount", { precision: 10, scale: 2 }).default("1.00"),
  maximumTopupAmount: decimal("maximum_topup_amount", { precision: 10, scale: 2 }).default("500.00"),
  loyaltyPointsRate: decimal("loyalty_points_rate", { precision: 5, scale: 2 }).default("1.00"),
  referralBonus: decimal("referral_bonus", { precision: 10, scale: 2 }).default("5.00"),
  natcashFee: decimal("natcash_fee", { precision: 5, scale: 2 }).default("5.00"), // NatCash transfer fee percentage
  moncashFee: decimal("moncash_fee", { precision: 5, scale: 2 }).default("5.00"), // MonCash transfer fee percentage
  moncashEnabled: boolean("moncash_enabled").default(false), // Toggle MonCash feature on/off
  cashPickEnabled: boolean("cash_pick_enabled").default(false), // Toggle Cash Pick feature on/off
  natcashEnabled: boolean("natcash_enabled").default(false), // Toggle NatCash feature on/off
  moncashFeeEnabled: boolean("moncash_fee_enabled").default(true), // Toggle MonCash service fee on/off
  natcashFeeEnabled: boolean("natcash_fee_enabled").default(true), // Toggle NatCash service fee on/off
  billPaymentFee: decimal("bill_payment_fee", { precision: 5, scale: 2 }).default("5.00"), // Bill Payment service fee percentage
  giftCardFee: decimal("gift_card_fee", { precision: 5, scale: 2 }).default("5.00"), // Gift Card service fee percentage
  globalTopupCommissionPercent: decimal("global_topup_commission_percent", { precision: 5, scale: 2 }).default("0.00"), // Global topup commission % (applies to ALL topups after per-user commission)
  cashbackRate: decimal("cashback_rate", { precision: 5, scale: 2 }).default("2.00"), // Global cashback % given to user after every topup (independent of commission)
  exchangeRate: decimal("exchange_rate", { precision: 10, scale: 2 }).default("135.00"), // USD to HTG exchange rate
  fundRequestFee: decimal("fund_request_fee", { precision: 5, scale: 2 }).default("10.00"), // Fund request fee %
  fundRequestEnabled: boolean("fund_request_enabled").default(true), // Toggle Fund Request feature on/off
  internationalSurcharge: decimal("international_surcharge", { precision: 5, scale: 2 }).default("6.00"), // % added for international PayPal/Stripe payers (not USA)
  internationalSurchargeEnabled: boolean("international_surcharge_enabled").default(true), // Toggle international surcharge on/off
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Dynamic Service Fee Rules — tiered fee system per service
export const SERVICE_NAMES = ['natcash', 'moncash', 'topup_paypal', 'topup_wallet', 'topup_guest', 'billpayment', 'giftcard'] as const;
export type ServiceName = typeof SERVICE_NAMES[number];

export const serviceFeeRules = pgTable("service_fee_rules", {
  id: serial("id").primaryKey(),
  serviceName: varchar("service_name", { length: 50 }).notNull(),
  minAmount: decimal("min_amount", { precision: 10, scale: 2 }).notNull().default("0.00"),
  maxAmount: decimal("max_amount", { precision: 10, scale: 2 }), // null = no upper limit
  feeType: varchar("fee_type", { length: 20 }).notNull().default("percentage"), // 'percentage' | 'fixed'
  feeValue: decimal("fee_value", { precision: 10, scale: 4 }).notNull(),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertServiceFeeRuleSchema = createInsertSchema(serviceFeeRules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type ServiceFeeRule = typeof serviceFeeRules.$inferSelect;
export type InsertServiceFeeRule = z.infer<typeof insertServiceFeeRuleSchema>;

// Discount codes table for influencer marketing
export const PROMO_SERVICE_TYPES = ['all', 'topup', 'add-funds', 'bill-payment', 'gift-card', 'natcash', 'moncash', 'guest-topup'] as const;
export type PromoServiceType = typeof PROMO_SERVICE_TYPES[number];

export const discountCodes = pgTable("discount_codes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  code: varchar("code").notNull().unique(),
  influencerName: varchar("influencer_name").notNull(),
  discountType: varchar("discount_type").default("percentage"), // 'percentage', 'fixed'
  discountValue: decimal("discount_value", { precision: 5, scale: 2 }).notNull(),
  minAmount: decimal("min_amount", { precision: 10, scale: 2 }).default("0.00"), // Minimum purchase amount to use code
  maxUses: integer("max_uses").default(1000),
  currentUses: integer("current_uses").default(0),
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  applicableTo: varchar("applicable_to").default("all"), // 'all' | 'topup' | 'add-funds' | 'bill-payment' | 'gift-card' | 'natcash' | 'moncash' | 'guest-topup'
  expiresAt: timestamp("expires_at").notNull(),
  description: text("description"),
  userId: varchar("user_id").references(() => users.id), // If set, code is personal to this user only
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Discount code usage tracking
export const discountCodeUsage = pgTable("discount_code_usage", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  codeId: varchar("code_id").references(() => discountCodes.id).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  transactionId: varchar("transaction_id").references(() => transactions.id),
  discountAmount: decimal("discount_amount", { precision: 10, scale: 2 }).notNull(),
  originalAmount: decimal("original_amount", { precision: 10, scale: 2 }).notNull(),
  finalAmount: decimal("final_amount", { precision: 10, scale: 2 }).notNull(),
  usedAt: timestamp("used_at").defaultNow(),
});

export type DiscountCode = typeof discountCodes.$inferSelect;
export type InsertDiscountCode = typeof discountCodes.$inferInsert;
export type DiscountCodeUsage = typeof discountCodeUsage.$inferSelect;
export type InsertDiscountCodeUsage = typeof discountCodeUsage.$inferInsert;

// Insert schemas
export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertTransactionSchema = createInsertSchema(transactions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertWalletTransactionSchema = createInsertSchema(walletTransactions).omit({
  id: true,
  createdAt: true,
});

export const insertPromotionSchema = createInsertSchema(promotions).omit({
  id: true,
  createdAt: true,
});

export const insertSupportTicketSchema = createInsertSchema(supportTickets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertSupportTicketReplySchema = createInsertSchema(supportTicketReplies).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertReviewSchema = createInsertSchema(reviews).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertNotificationSchema = createInsertSchema(notifications).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertDiscountCodeSchema = createInsertSchema(discountCodes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertDiscountCodeUsageSchema = createInsertSchema(discountCodeUsage).omit({
  id: true,
  usedAt: true,
});

export const insertInvitePageSettingsSchema = createInsertSchema(invitePageSettings).omit({
  id: true,
  updatedAt: true,
});

export const insertFeeStructureSchema = createInsertSchema(feeStructures).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Types
export type User = typeof users.$inferSelect;
export type UpsertUser = typeof users.$inferInsert;

// Investors table
export const investors = pgTable("investors", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  firstName: varchar("first_name").notNull(),
  lastName: varchar("last_name").notNull(),
  email: varchar("email").unique().notNull(),
  phoneNumber: varchar("phone_number"),
  investorCode: varchar("investor_code").unique().notNull(),
  totalInvested: decimal("total_invested", { precision: 12, scale: 2 }).default("0.00"),
  availableBalance: decimal("available_balance", { precision: 12, scale: 2 }).default("0.00"),
  totalProfit: decimal("total_profit", { precision: 12, scale: 2 }).default("0.00"),
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  canAccessAdminPanel: boolean("can_access_admin_panel").default(false),
  enableHaitiInterest: boolean("enable_haiti_interest").default(true), // Allow Haiti commission system
  haitiCommissionRate: decimal("haiti_commission_rate", { precision: 5, scale: 2 }).default("10.00"), // Commission percentage (default 10%)
  adminUserId: varchar("admin_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Investor transactions table for tracking top-ups and profits
export const investorTransactions = pgTable("investor_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  investorId: varchar("investor_id").references(() => investors.id).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  transactionId: varchar("transaction_id").references(() => transactions.id).notNull(),
  topupAmount: decimal("topup_amount", { precision: 10, scale: 2 }).notNull(),
  paymentMethod: varchar("payment_method").notNull(), // 'wallet', 'paypal', 'investor_fund'
  officialFees: decimal("official_fees", { precision: 10, scale: 2 }).default("0.00"),
  serviceFees: decimal("service_fees", { precision: 10, scale: 2 }).notNull(), // Total service fees
  netAmount: decimal("net_amount", { precision: 10, scale: 2 }).notNull(),
  investorShare: decimal("investor_share", { precision: 10, scale: 2 }).notNull(),
  buyfastShare: decimal("buyfast_share", { precision: 10, scale: 2 }).notNull(),
  balanceDeducted: decimal("balance_deducted", { precision: 10, scale: 2 }).notNull(), // Amount taken from investor balance
  fundedByInvestor: boolean("funded_by_investor").default(true), // True if funded by investor balance
  investorBalanceBefore: decimal("investor_balance_before", { precision: 12, scale: 2 }), // Balance before deduction
  investorBalanceAfter: decimal("investor_balance_after", { precision: 12, scale: 2 }), // Balance after deduction
  status: varchar("status").default("completed"), // 'completed', 'pending', 'failed'
  createdAt: timestamp("created_at").defaultNow(),
});

// Investor deposits table for tracking admin investments
export const investorDeposits = pgTable("investor_deposits", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  investorId: varchar("investor_id").references(() => investors.id).notNull(),
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  adminUserId: varchar("admin_user_id").references(() => users.id).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Investor withdrawals table for tracking money removed from investor accounts
export const investorWithdrawals = pgTable("investor_withdrawals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  investorId: varchar("investor_id").references(() => investors.id).notNull(),
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  adminUserId: varchar("admin_user_id").references(() => users.id).notNull(),
  description: text("description"),
  status: varchar("status").default("pending"), // 'pending', 'approved', 'completed', 'rejected'
  balanceBefore: decimal("balance_before", { precision: 12, scale: 2 }),
  balanceAfter: decimal("balance_after", { precision: 12, scale: 2 }),
  createdAt: timestamp("created_at").defaultNow(),
  processedAt: timestamp("processed_at"),
});

export type Investor = typeof investors.$inferSelect;
export type InsertInvestor = typeof investors.$inferInsert;
export type InvestorTransaction = typeof investorTransactions.$inferSelect;
export type InsertInvestorTransaction = typeof investorTransactions.$inferInsert;
export type InvestorDeposit = typeof investorDeposits.$inferSelect;
export type InsertInvestorDeposit = typeof investorDeposits.$inferInsert;
export type InvestorWithdrawal = typeof investorWithdrawals.$inferSelect;
export type InsertInvestorWithdrawal = typeof investorWithdrawals.$inferInsert;

// Haiti Interest Transactions - Special table for tracking 10% GDS profit display
export const haitiInterestTransactions = pgTable("haiti_interest_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  investorId: varchar("investor_id").references(() => investors.id).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  transactionId: varchar("transaction_id").references(() => transactions.id).notNull(),
  topupAmountUSD: decimal("topup_amount_usd", { precision: 10, scale: 2 }).notNull(), // Amount user paid in USD
  destinationAmountGDS: decimal("destination_amount_gds", { precision: 12, scale: 2 }).notNull(), // Amount received in Haitian Gourdes (GDS)
  investorProfitGDS: decimal("investor_profit_gds", { precision: 12, scale: 2 }).notNull(), // 10% of GDS amount for display
  exchangeRate: decimal("exchange_rate", { precision: 10, scale: 4 }), // USD to GDS exchange rate used
  interestPercentageUSD: decimal("interest_percentage_usd", { precision: 10, scale: 2 }).default("0.10"), // 10% in USD
  interestAmountUSD: decimal("interest_amount_usd", { precision: 10, scale: 2 }).notNull(), // Actual 10% deducted in USD
  description: text("description").notNull(),
  status: varchar("status").default("completed"), // 'completed', 'pending', 'failed'
  createdAt: timestamp("created_at").defaultNow(),
});

export type HaitiInterestTransaction = typeof haitiInterestTransactions.$inferSelect;
export type InsertHaitiInterestTransaction = typeof haitiInterestTransactions.$inferInsert;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type Transaction = typeof transactions.$inferSelect;
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type WalletTransaction = typeof walletTransactions.$inferSelect;
export type InsertWalletTransaction = z.infer<typeof insertWalletTransactionSchema>;
export type Country = typeof countries.$inferSelect;
export type Operator = typeof operators.$inferSelect;
export type Promotion = typeof promotions.$inferSelect;
export type InsertPromotion = z.infer<typeof insertPromotionSchema>;
export type LoyaltyReward = typeof loyaltyRewards.$inferSelect;
export type SupportTicket = typeof supportTickets.$inferSelect;
export type InsertSupportTicket = z.infer<typeof insertSupportTicketSchema>;
export type SupportTicketReply = typeof supportTicketReplies.$inferSelect;
export type InsertSupportTicketReply = z.infer<typeof insertSupportTicketReplySchema>;
export type Review = typeof reviews.$inferSelect;
export type InsertReview = z.infer<typeof insertReviewSchema>;
export type Referral = typeof referrals.$inferSelect;
export type InvitePageSettings = typeof invitePageSettings.$inferSelect;
export type InsertInvitePageSettings = z.infer<typeof insertInvitePageSettingsSchema>;
export type FeeStructure = typeof feeStructures.$inferSelect;
export type InsertFeeStructure = z.infer<typeof insertFeeStructureSchema>;

// Color themes table for application styling
export const colorThemes = pgTable("color_themes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  description: text("description"),
  
  // Primary brand colors
  primaryGreen: varchar("primary_green").notNull().default("#D6F000"), // Main action color
  darkBlue: varchar("dark_blue").notNull().default("#00424C"),         // Headers, navigation
  accentPink: varchar("accent_pink").notNull().default("#EC008C"),     // Promotions, warnings
  backgroundWhite: varchar("background_white").notNull().default("#FFFFFF"), // Main backgrounds
  lightBlue: varchar("light_blue").notNull().default("#CFF6F5"),       // Card backgrounds
  
  // Text colors
  textPrimary: varchar("text_primary").notNull().default("#1C1C1C"),
  textSecondary: varchar("text_secondary").notNull().default("#5A5A5A"),
  textOnDark: varchar("text_on_dark").notNull().default("#FFFFFF"),
  textOnGreen: varchar("text_on_green").notNull().default("#00424C"),
  
  // Status colors
  successColor: varchar("success_color").notNull().default("#10B981"),
  warningColor: varchar("warning_color").notNull().default("#FFB020"),
  errorColor: varchar("error_color").notNull().default("#EC008C"),
  infoColor: varchar("info_color").notNull().default("#3B82F6"),
  
  // Button colors
  buttonPrimary: varchar("button_primary").notNull().default("#D6F000"),
  buttonSecondary: varchar("button_secondary").notNull().default("#CFF6F5"),
  buttonDanger: varchar("button_danger").notNull().default("#EC008C"),
  
  // Additional UI colors
  borderColor: varchar("border_color").notNull().default("#E5E7EB"),
  shadowColor: varchar("shadow_color").notNull().default("rgba(0, 0, 0, 0.1)"),
  
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  isDefault: boolean("is_default").default(false),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Insert schema and types for color themes
export const insertColorThemeSchema = createInsertSchema(colorThemes);
export type ColorTheme = typeof colorThemes.$inferSelect;
export type InsertColorTheme = z.infer<typeof insertColorThemeSchema>;

// Text Management System
export const textContent = pgTable("text_content", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: varchar("key").notNull().unique(), // Unique identifier for each text element
  category: varchar("category").notNull(), // Page or section category
  content: text("content").notNull(), // The actual text content
  description: text("description"), // Description of what this text is for
  isEditable: boolean("is_editable").default(true), // Whether this text can be edited
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertTextContentSchema = createInsertSchema(textContent);
export type TextContent = typeof textContent.$inferSelect;
export type InsertTextContent = z.infer<typeof insertTextContentSchema>;

// Promotional offers table for time-limited discounts
export const promotionalOffers = pgTable("promotional_offers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  offerCode: varchar("offer_code").unique().notNull(),
  discountPercentage: decimal("discount_percentage", { precision: 5, scale: 2 }).default("5.00"), // Default 5%
  minAmount: decimal("min_amount", { precision: 10, scale: 2 }).default("5.00"), // Minimum purchase amount
  maxDiscount: decimal("max_discount", { precision: 10, scale: 2 }).default("10.00"), // Maximum discount amount
  expiresAt: timestamp("expires_at").notNull(), // Expires in 10 minutes by default
  isUsed: boolean("is_used").default(false),
  usedAt: timestamp("used_at"),
  triggerTransactionId: varchar("trigger_transaction_id").references(() => transactions.id), // Transaction that triggered this offer
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  createdAt: timestamp("created_at").defaultNow(),
});

// Promotional campaigns table for admin management
export const promotionalCampaigns = pgTable("promotional_campaigns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  description: text("description"),
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  discountPercentage: decimal("discount_percentage", { precision: 5, scale: 2 }).default("5.00"),
  validityMinutes: integer("validity_minutes").default(10), // How long offers last
  minAmount: decimal("min_amount", { precision: 10, scale: 2 }).default("5.00"),
  maxDiscount: decimal("max_discount", { precision: 10, scale: 2 }).default("10.00"),
  triggerAfterSuccess: boolean("trigger_after_success").default(true), // Trigger after successful topup
  messageTemplate: text("message_template").default("🎉 Congratulations! Complete another top-up within 10 minutes and get 5% off your next purchase!"),
  imageUrl: varchar("image_url", { length: 2048 }), // Campaign image URL
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Insert schemas for promotional tables
export const insertPromotionalOfferSchema = createInsertSchema(promotionalOffers);
export const insertPromotionalCampaignSchema = createInsertSchema(promotionalCampaigns);

export type PromotionalOffer = typeof promotionalOffers.$inferSelect;
export type InsertPromotionalOffer = z.infer<typeof insertPromotionalOfferSchema>;
export type PromotionalCampaign = typeof promotionalCampaigns.$inferSelect;
export type InsertPromotionalCampaign = z.infer<typeof insertPromotionalCampaignSchema>;

// Device tokens table for FCM push notifications
export const deviceTokens = pgTable("device_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  token: text("token").notNull().unique(), // FCM registration token
  platform: varchar("platform").notNull(), // 'android', 'ios', 'web'
  deviceInfo: jsonb("device_info"), // Additional device information
  isActive: boolean("is_active").default(true), // Whether notifications are enabled
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  lastUsed: timestamp("last_used").defaultNow(), // Track token usage
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Push notification templates for admin configuration with multi-language support
export const pushNotificationTemplates = pgTable("push_notification_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull().unique(),
  
  // Multi-language support for titles (at least one language required)
  titleEn: varchar("title_en"), // English title
  titleFr: varchar("title_fr"), // French title
  titleEs: varchar("title_es"), // Spanish title
  titleHt: varchar("title_ht"), // Haitian Creole title
  
  // Multi-language support for body messages (at least one language required)
  bodyEn: text("body_en"), // English body
  bodyFr: text("body_fr"), // French body
  bodyEs: text("body_es"), // Spanish body
  bodyHt: text("body_ht"), // Haitian Creole body
  
  // Legacy fields for backward compatibility (will be removed later)
  title: varchar("title"), // Deprecated: use titleEn
  body: text("body"), // Deprecated: use bodyEn
  
  icon: varchar("icon").default("/logo-buyfast-favicon.jpg"), // Notification icon
  clickAction: varchar("click_action").default("/"), // URL to open when clicked
  category: varchar("category").default("general"), // 'general', 'reminder', 'promotion'
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Push notification logs for tracking sent notifications
export const pushNotificationLogs = pgTable("push_notification_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  templateId: varchar("template_id").references(() => pushNotificationTemplates.id),
  userId: varchar("user_id").references(() => users.id),
  deviceTokenId: varchar("device_token_id").references(() => deviceTokens.id),
  title: varchar("title").notNull(),
  body: text("body").notNull(),
  status: varchar("status").default("pending"), // 'pending', 'sent', 'delivered', 'failed'
  errorMessage: text("error_message"), // FCM error details if failed
  sentAt: timestamp("sent_at"),
  deliveredAt: timestamp("delivered_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Insert schemas and types for FCM tables
export const insertDeviceTokenSchema = createInsertSchema(deviceTokens);
export const insertPushNotificationTemplateSchema = createInsertSchema(pushNotificationTemplates);
export const insertPushNotificationLogSchema = createInsertSchema(pushNotificationLogs);

export type DeviceToken = typeof deviceTokens.$inferSelect;
export type InsertDeviceToken = z.infer<typeof insertDeviceTokenSchema>;
export type PushNotificationTemplate = typeof pushNotificationTemplates.$inferSelect;
export type InsertPushNotificationTemplate = z.infer<typeof insertPushNotificationTemplateSchema>;
export type PushNotificationLog = typeof pushNotificationLogs.$inferSelect;
export type InsertPushNotificationLog = z.infer<typeof insertPushNotificationLogSchema>;

// FRAUD MANAGEMENT SYSTEM TABLES

// Fraud attempts table - tracks all fraud attempts and activities
export const fraudAttempts = pgTable("fraud_attempts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  ipAddress: varchar("ip_address").notNull(),
  userAgent: text("user_agent"),
  deviceFingerprint: text("device_fingerprint"),
  location: jsonb("location"), // {country, city, lat, lng}
  attemptType: varchar("attempt_type").notNull(), // 'login', 'transaction', 'registration', 'payment'
  riskScore: integer("risk_score").default(0), // 0-100
  flagReasons: jsonb("flag_reasons"), // Array of strings
  isBlocked: boolean("is_blocked").default(false),
  metadata: jsonb("metadata"), // Additional context data
  createdAt: timestamp("created_at").defaultNow(),
});

// User security events - tracks all security-related events
export const securityEvents = pgTable("security_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  eventType: varchar("event_type").notNull(), // 'login_attempt', 'password_change', 'suspicious_activity', 'account_locked'
  severity: varchar("severity").default("low"), // 'low', 'medium', 'high', 'critical'
  ipAddress: varchar("ip_address"),
  userAgent: text("user_agent"),
  description: text("description"),
  metadata: jsonb("metadata"),
  resolved: boolean("resolved").default(false),
  resolvedBy: varchar("resolved_by").references(() => users.id),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// User device tracking - tracks devices used by users
export const userDevices = pgTable("user_devices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  deviceFingerprint: text("device_fingerprint").notNull(),
  deviceInfo: jsonb("device_info"), // Browser, OS, screen resolution, etc.
  ipAddress: varchar("ip_address"),
  location: jsonb("location"), // {country, city, lat, lng}
  isTrusted: boolean("is_trusted").default(false),
  isBlocked: boolean("is_blocked").default(false),
  firstSeen: timestamp("first_seen").defaultNow(),
  lastSeen: timestamp("last_seen").defaultNow(),
  loginCount: integer("login_count").default(1),
});

// Blacklist entries - IP addresses, emails, devices, etc.
export const blacklistEntries = pgTable("blacklist_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: varchar("type").notNull(), // 'ip', 'email', 'device', 'phone', 'domain'
  value: varchar("value").notNull(),
  reason: text("reason").notNull(),
  severity: varchar("severity").default("medium"), // 'low', 'medium', 'high'
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  expiresAt: timestamp("expires_at"), // Optional expiration
  addedBy: varchar("added_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Security policies - configurable rules and thresholds
export const securityPolicies = pgTable("security_policies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull().unique(),
  description: text("description"),
  type: varchar("type").notNull(), // 'threshold', 'rule', 'automation'
  config: jsonb("config").notNull(), // Policy configuration
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  priority: integer("priority").default(5), // 1-10, higher = more important
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Manual review queue - items that need admin review
export const reviewQueue = pgTable("review_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: varchar("type").notNull(), // 'user', 'transaction', 'device', 'pattern'
  entityId: varchar("entity_id").notNull(), // ID of the entity being reviewed
  userId: varchar("user_id").references(() => users.id),
  priority: varchar("priority").default("medium"), // 'low', 'medium', 'high', 'urgent'
  status: varchar("status").default("pending"), // 'pending', 'in_review', 'approved', 'rejected', 'escalated'
  riskScore: integer("risk_score"),
  flagReasons: jsonb("flag_reasons"),
  notes: text("notes"),
  reviewedBy: varchar("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at"),
  resolution: varchar("resolution"), // 'approved', 'blocked', 'restricted', 'escalated'
  resolutionNotes: text("resolution_notes"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Risk assessment rules - dynamic rules for calculating risk scores
export const riskRules = pgTable("risk_rules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  description: text("description"),
  category: varchar("category").notNull(), // 'user', 'transaction', 'device', 'location'
  conditions: jsonb("conditions").notNull(), // Rule conditions
  riskPoints: integer("risk_points").notNull(), // Points to add to risk score
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  priority: integer("priority").default(5),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Fraud reports - comprehensive fraud analytics
export const fraudReports = pgTable("fraud_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: varchar("title").notNull(),
  reportType: varchar("report_type").notNull(), // 'daily', 'weekly', 'monthly', 'incident'
  dateRange: jsonb("date_range"), // {from, to}
  data: jsonb("data").notNull(), // Report data and statistics
  insights: jsonb("insights"), // AI-generated insights
  recommendations: jsonb("recommendations"), // Security recommendations
  generatedBy: varchar("generated_by").references(() => users.id),
  isAutomated: boolean("is_automated").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// Insert schemas for fraud management tables
export const insertFraudAttemptSchema = createInsertSchema(fraudAttempts);
export const insertSecurityEventSchema = createInsertSchema(securityEvents);
export const insertUserDeviceSchema = createInsertSchema(userDevices);
export const insertBlacklistEntrySchema = createInsertSchema(blacklistEntries);
export const insertSecurityPolicySchema = createInsertSchema(securityPolicies);
export const insertReviewQueueSchema = createInsertSchema(reviewQueue);
export const insertRiskRuleSchema = createInsertSchema(riskRules);
export const insertFraudReportSchema = createInsertSchema(fraudReports);

// Types for fraud management
export type FraudAttempt = typeof fraudAttempts.$inferSelect;
export type InsertFraudAttempt = z.infer<typeof insertFraudAttemptSchema>;
export type SecurityEvent = typeof securityEvents.$inferSelect;
export type InsertSecurityEvent = z.infer<typeof insertSecurityEventSchema>;
export type UserDevice = typeof userDevices.$inferSelect;
export type InsertUserDevice = z.infer<typeof insertUserDeviceSchema>;
export type BlacklistEntry = typeof blacklistEntries.$inferSelect;
export type InsertBlacklistEntry = z.infer<typeof insertBlacklistEntrySchema>;
export type SecurityPolicy = typeof securityPolicies.$inferSelect;
export type InsertSecurityPolicy = z.infer<typeof insertSecurityPolicySchema>;
export type ReviewQueueItem = typeof reviewQueue.$inferSelect;
export type InsertReviewQueueItem = z.infer<typeof insertReviewQueueSchema>;
export type RiskRule = typeof riskRules.$inferSelect;
export type InsertRiskRule = z.infer<typeof insertRiskRuleSchema>;
export type FraudReport = typeof fraudReports.$inferSelect;
export type InsertFraudReport = z.infer<typeof insertFraudReportSchema>;

// KYC Verification System - Current database schema (to avoid migration conflicts)
export const kycVerifications = pgTable("kyc_verifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  documentType: varchar("document_type").notNull(),
  documentNumber: varchar("document_number").notNull(), 
  documentImageUrl: text("document_image_url"),
  selfieImageUrl: text("selfie_image_url"),
  verificationStatus: varchar("verification_status").notNull().default("pending"),
  verificationLevel: varchar("verification_level").notNull().default("basic"),
  rejectionReason: varchar("rejection_reason"),
  verifiedBy: varchar("verified_by").references(() => users.id),
  verifiedAt: timestamp("verified_at"),
  expiresAt: timestamp("expires_at"),
  diditSessionId: varchar("didit_session_id"),
  diditStatus: varchar("didit_status"),
  diditDecision: jsonb("didit_decision"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// KYC Documents Storage - Secure file tracking for ID verification
export const kycDocuments = pgTable("kyc_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  kycVerificationId: varchar("kyc_verification_id").notNull().references(() => kycVerifications.id, { onDelete: "cascade" }),
  type: varchar("type").notNull(), // 'front', 'back', 'selfie'
  objectKey: varchar("object_key").notNull(), // Private storage key - no public URLs
  mimeType: varchar("mime_type").notNull(),
  fileSize: integer("file_size").notNull(), // Size in bytes
  sha256Hash: varchar("sha256_hash").notNull(), // File integrity verification
  createdAt: timestamp("created_at").defaultNow(),
});

// KYC Audit Events - Immutable audit trail for KYC review actions
export const kycAuditEvents = pgTable("kyc_audit_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  kycVerificationId: varchar("kyc_verification_id").notNull().references(() => kycVerifications.id, { onDelete: "cascade" }),
  eventType: varchar("event_type").notNull(), // 'status_change', 'assignment', 'note_added', 'document_viewed'
  previousStatus: varchar("previous_status"),
  newStatus: varchar("new_status"),
  actionBy: varchar("action_by").notNull().references(() => users.id), // Admin who performed action
  reasonCode: varchar("reason_code"), // Standardized reason codes
  notes: text("notes"), // Action notes/comments
  requestedInfo: text("requested_info"), // What info was requested
  ipAddress: varchar("ip_address"),
  userAgent: text("user_agent"),
  metadata: jsonb("metadata"), // Additional context data
  createdAt: timestamp("created_at").defaultNow(),
});

// Card Scan Verification - Post-KYC physical-card name check (anti-stolen-card).
// The cardholder NAME is OCR'd client-side from the physical card and verified
// server-side against the KYC legal name. The full card number (PAN) is NEVER
// stored here — only the last 4 digits and card brand are kept for reference.
export const cardScanVerifications = pgTable("card_scan_verifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  nameOnCard: text("name_on_card").notNull(), // OCR'd cardholder name (no PAN)
  last4: varchar("last4"), // last 4 digits only, optional
  cardBrand: varchar("card_brand"), // visa / mastercard / amex, optional
  matched: boolean("matched").notNull().default(false), // server-decided name match
  kycNameUsed: text("kyc_name_used"), // KYC legal name compared against (audit)
  createdAt: timestamp("created_at").defaultNow(),
});

// 2FA System
export const twoFactorAuth = pgTable("two_factor_auth", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  secret: varchar("secret").notNull(), // TOTP secret
  isEnabled: boolean("is_enabled").notNull().default(false),
  backupCodes: text("backup_codes").array(), // Recovery codes
  lastUsed: timestamp("last_used"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Phone OTP Verification
export const phoneOtpVerifications = pgTable("phone_otp_verifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  phoneNumber: varchar("phone_number").notNull(),
  otpCode: varchar("otp_code").notNull(),
  isVerified: boolean("is_verified").notNull().default(false),
  attemptCount: integer("attempt_count").notNull().default(0),
  expiresAt: timestamp("expires_at").notNull(),
  verifiedAt: timestamp("verified_at"),
  purpose: varchar("purpose").notNull(), // login, transaction, withdrawal
  createdAt: timestamp("created_at").defaultNow(),
});

// Transaction Velocity Tracking
export const transactionVelocity = pgTable("transaction_velocity", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  timeWindow: varchar("time_window").notNull(), // 1min, 5min, 1hour, 1day
  transactionCount: integer("transaction_count").notNull().default(0),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull().default("0.00"),
  lastTransactionAt: timestamp("last_transaction_at"),
  isBlocked: boolean("is_blocked").notNull().default(false),
  resetAt: timestamp("reset_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Geographic Risk Rules
export const geoRiskRules = pgTable("geo_risk_rules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  countryCode: varchar("country_code").notNull(),
  riskLevel: varchar("risk_level").notNull(), // low, medium, high, blocked
  isBlocked: boolean("is_blocked").notNull().default(false),
  requiresKyc: boolean("requires_kyc").notNull().default(false),
  maxTransactionAmount: decimal("max_transaction_amount", { precision: 10, scale: 2 }),
  additionalVerification: varchar("additional_verification"), // 2fa, phone_otp, manual_review
  reason: varchar("reason"),
  createdBy: varchar("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Enhanced Device Fingerprinting
export const deviceFingerprints = pgTable("device_fingerprints", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }),
  fingerprint: varchar("fingerprint").notNull().unique(),
  userAgent: text("user_agent"),
  screenResolution: varchar("screen_resolution"),
  timezone: varchar("timezone"),
  language: varchar("language"),
  platform: varchar("platform"),
  cookiesEnabled: boolean("cookies_enabled"),
  localStorageEnabled: boolean("local_storage_enabled"),
  sessionStorageEnabled: boolean("session_storage_enabled"),
  indexedDbEnabled: boolean("indexed_db_enabled"),
  webglSupported: boolean("webgl_supported"),
  canvasFingerprint: text("canvas_fingerprint"),
  audioFingerprint: text("audio_fingerprint"),
  riskScore: integer("risk_score").notNull().default(0),
  isBlocked: boolean("is_blocked").notNull().default(false),
  kycRequired: boolean("kyc_required").notNull().default(false), // Flag for KYC requirement
  flagReason: text("flag_reason"), // Reason for KYC requirement
  lastIpAddress: varchar("last_ip_address"),
  lastSeen: timestamp("last_seen").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Device IP Events - Track IP address history for devices
export const deviceIpEvents = pgTable("device_ip_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceFingerprint: varchar("device_fingerprint").notNull().references(() => deviceFingerprints.fingerprint),
  ipAddress: varchar("ip_address").notNull(),
  userAgent: text("user_agent"),
  country: varchar("country"),
  city: varchar("city"),
  region: varchar("region"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Payment Sources - Track payment method fingerprints per device
export const paymentSources = pgTable("payment_sources", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceFingerprint: varchar("device_fingerprint").notNull().references(() => deviceFingerprints.fingerprint),
  provider: varchar("provider").notNull(), // 'paypal', 'stripe', 'moncash'
  referenceHash: varchar("reference_hash").notNull().unique(), // Hashed payment method fingerprint
  last4: varchar("last4"), // Last 4 digits (safe to store)
  network: varchar("network"), // Visa, Mastercard, etc.
  usageCount: integer("usage_count").notNull().default(1),
  firstSeen: timestamp("first_seen").defaultNow(),
  lastSeen: timestamp("last_seen").defaultNow(),
});

// Fraud Triggers - Track automatic fraud rule violations
export const fraudTriggers = pgTable("fraud_triggers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: varchar("type").notNull(), // 'multi_card_device', 'velocity_limit', 'geo_risk'
  deviceFingerprint: varchar("device_fingerprint").references(() => deviceFingerprints.fingerprint),
  userId: varchar("user_id").references(() => users.id),
  severity: varchar("severity").notNull().default("medium"), // 'low', 'medium', 'high', 'critical'
  rule: varchar("rule").notNull(), // Rule identifier
  triggerWindow: varchar("trigger_window"), // Time window for the trigger
  metrics: jsonb("metrics"), // Trigger metrics and counts
  isResolved: boolean("is_resolved").notNull().default(false),
  resolvedBy: varchar("resolved_by").references(() => users.id),
  resolutionNotes: text("resolution_notes"),
  triggeredAt: timestamp("triggered_at").defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

// Compliance & Audit Logs
export const complianceLogs = pgTable("compliance_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  eventType: varchar("event_type").notNull(), // kyc_submission, fraud_detection, transaction_block
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }),
  entityId: varchar("entity_id"), // transaction_id, verification_id, etc
  eventData: text("event_data"), // JSON string
  ipAddress: varchar("ip_address"),
  userAgent: text("user_agent"),
  location: varchar("location"),
  riskScore: integer("risk_score"),
  complianceStatus: varchar("compliance_status"), // compliant, flagged, investigated
  investigatedBy: varchar("investigated_by"),
  investigatedAt: timestamp("investigated_at"),
  resolution: text("resolution"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ===========================
// NATCASH TRANSFER SYSTEM
// ===========================

// NatCash Transfer table for Diaspora → NatCash functionality
export const natcashTransfers = pgTable("natcash_transfers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id), // Nullable for guest transfers
  
  // 🛡️ IDEMPOTENCY PROTECTION
  idempotencyKey: varchar("idempotency_key").unique().notNull(), // Prevent duplicate transactions
  
  // Recipient Information
  recipientFullName: varchar("recipient_full_name").notNull(),
  recipientNatcashPhone: varchar("recipient_natcash_phone").notNull(),
  recipientEmail: varchar("recipient_email"), // Optional notification email
  
  // Transfer Details
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(), // USD amount paid by sender
  amountHTG: decimal("amount_htg", { precision: 10, scale: 2 }), // HTG equivalent that recipient receives (after cashback deductions)
  exchangeRate: decimal("exchange_rate", { precision: 8, scale: 4 }), // USD to HTG rate
  fee: decimal("fee", { precision: 10, scale: 2 }).default("0.00"),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(), // amount + fee
  recipientAmount: decimal("recipient_amount", { precision: 10, scale: 2 }), // USD amount recipient actually receives (amount - cashbacks)

  // Cashback System
  customerCashbackRate: decimal("customer_cashback_rate", { precision: 5, scale: 2 }).default("0.00"),
  customerCashbackAmount: decimal("customer_cashback_amount", { precision: 10, scale: 2 }).default("0.00"),
  platformCashbackRate: decimal("platform_cashback_rate", { precision: 5, scale: 2 }).default("0.00"),
  platformCashbackAmount: decimal("platform_cashback_amount", { precision: 10, scale: 2 }).default("0.00"),
  cashbackCredited: boolean("cashback_credited").default(false),

  // Status Management
  status: varchar("status").notNull().default("pending"), // pending, completed, failed, cancelled
  
  // Payment Information
  paymentMethod: varchar("payment_method").notNull(), // paypal, wallet, stripe
  paymentOrderId: varchar("payment_order_id"), // PayPal order ID, Stripe payment intent, etc.
  paymentCapturedAt: timestamp("payment_captured_at"),
  
  // Admin Processing
  processedBy: varchar("processed_by").references(() => users.id), // Admin who processed
  processedAt: timestamp("processed_at"),
  adminNotes: text("admin_notes"), // Admin notes for processing
  completionReason: text("completion_reason"), // Reason for completion/failure
  
  // Notification & Communication
  senderNotified: boolean("sender_notified").default(false),
  recipientNotified: boolean("recipient_notified").default(false),
  notificationMethod: varchar("notification_method"), // sms, email, whatsapp
  
  // Security & Tracking
  ipAddress: varchar("ip_address"),
  userAgent: text("user_agent"),
  fraudScore: integer("fraud_score").default(0),
  isBlocked: boolean("is_blocked").default(false),
  
  // Metadata
  metadata: jsonb("metadata"), // Additional data (device info, referrer, etc.)
  
  // Timestamps
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Daily NatCash limits tracking per user
export const natcashLimits = pgTable("natcash_limits", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  date: varchar("date").notNull(), // YYYY-MM-DD format
  dailyAmount: decimal("daily_amount", { precision: 10, scale: 2 }).default("0.00"),
  dailyCount: integer("daily_count").default(0),
  lastTransferAt: timestamp("last_transfer_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ===========================
// MONCASH TRANSFER SYSTEM
// ===========================

// MonCash Transfer table for Diaspora → MonCash functionality
export const moncashTransfers = pgTable("moncash_transfers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id), // Nullable for guest transfers
  
  // 🛡️ IDEMPOTENCY PROTECTION
  idempotencyKey: varchar("idempotency_key").unique().notNull(), // Prevent duplicate transactions
  
  // Recipient Information
  recipientFullName: varchar("recipient_full_name").notNull(),
  recipientMoncashPhone: varchar("recipient_moncash_phone").notNull(),
  recipientEmail: varchar("recipient_email"), // Optional notification email
  
  // Transfer Details
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(), // USD amount paid by sender
  amountHTG: decimal("amount_htg", { precision: 10, scale: 2 }), // HTG equivalent that recipient receives (after cashback deductions)
  exchangeRate: decimal("exchange_rate", { precision: 8, scale: 4 }), // USD to HTG rate
  fee: decimal("fee", { precision: 10, scale: 2 }).default("0.00"),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(), // amount + fee
  recipientAmount: decimal("recipient_amount", { precision: 10, scale: 2 }), // USD amount recipient actually receives (amount - cashbacks)

  // Cashback System
  customerCashbackRate: decimal("customer_cashback_rate", { precision: 5, scale: 2 }).default("0.00"),
  customerCashbackAmount: decimal("customer_cashback_amount", { precision: 10, scale: 2 }).default("0.00"),
  platformCashbackRate: decimal("platform_cashback_rate", { precision: 5, scale: 2 }).default("0.00"),
  platformCashbackAmount: decimal("platform_cashback_amount", { precision: 10, scale: 2 }).default("0.00"),
  cashbackCredited: boolean("cashback_credited").default(false),

  // Status Management
  status: varchar("status").notNull().default("pending"), // pending, completed, failed, cancelled
  
  // Payment Information
  paymentMethod: varchar("payment_method").notNull(), // paypal, wallet, stripe
  paymentOrderId: varchar("payment_order_id"), // PayPal order ID, Stripe payment intent, etc.
  paymentCapturedAt: timestamp("payment_captured_at"),
  
  // Admin Processing
  processedBy: varchar("processed_by").references(() => users.id), // Admin who processed
  processedAt: timestamp("processed_at"),
  adminNotes: text("admin_notes"), // Admin notes for processing
  completionReason: text("completion_reason"), // Reason for completion/failure
  
  // Notification & Communication
  senderNotified: boolean("sender_notified").default(false),
  recipientNotified: boolean("recipient_notified").default(false),
  notificationMethod: varchar("notification_method"), // sms, email, whatsapp
  
  // Security & Tracking
  ipAddress: varchar("ip_address"),
  userAgent: text("user_agent"),
  fraudScore: integer("fraud_score").default(0),
  isBlocked: boolean("is_blocked").default(false),
  
  // Metadata
  metadata: jsonb("metadata"), // Additional data (device info, referrer, etc.)
  
  // Timestamps
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Daily MonCash limits tracking per user
export const moncashLimits = pgTable("moncash_limits", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  date: varchar("date").notNull(), // YYYY-MM-DD format
  dailyAmount: decimal("daily_amount", { precision: 10, scale: 2 }).default("0.00"),
  dailyCount: integer("daily_count").default(0),
  lastTransferAt: timestamp("last_transfer_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Fraud Detection Logs table
export const fraudLogs = pgTable("fraud_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id), // Nullable for anonymous attempts
  ip: varchar("ip").notNull(),
  userAgent: text("user_agent"),
  fraudType: varchar("fraud_type").notNull(), // 'paypal_amount_mismatch', 'minimum_deposit_violation', 'duplicate_payment', 'invalid_signature'
  reason: text("reason").notNull(),
  details: jsonb("details"), // Store additional context
  severity: varchar("severity").notNull().default("medium"), // 'low', 'medium', 'high', 'critical'
  resolved: boolean("resolved").default(false),
  resolvedBy: varchar("resolved_by").references(() => users.id),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// PayPal Order Tracking schemas  
export const insertPayPalOrderTrackingSchema = createInsertSchema(paypalOrderTracking);
export type PayPalOrderTracking = typeof paypalOrderTracking.$inferSelect;
export type InsertPayPalOrderTracking = z.infer<typeof insertPayPalOrderTrackingSchema>;

// Fraud Logs schemas
export const insertFraudLogSchema = createInsertSchema(fraudLogs);
export type FraudLog = typeof fraudLogs.$inferSelect;
export type InsertFraudLog = z.infer<typeof insertFraudLogSchema>;

// Insert schemas for KYC verification system
export const insertKycVerificationSchema = createInsertSchema(kycVerifications).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertKycDocumentSchema = createInsertSchema(kycDocuments).omit({
  id: true,
  createdAt: true,
});
// Card scan verification: client only supplies the scanned name + (optional)
// last4/cardBrand; matched + kycNameUsed are decided server-side.
export const insertCardScanVerificationSchema = createInsertSchema(cardScanVerifications).omit({
  id: true,
  matched: true,
  kycNameUsed: true,
  createdAt: true,
});

// Insert schemas for enhanced fraud protection
export const insertTwoFactorAuthSchema = createInsertSchema(twoFactorAuth);
export const insertPhoneOtpVerificationSchema = createInsertSchema(phoneOtpVerifications);
export const insertTransactionVelocitySchema = createInsertSchema(transactionVelocity);
export const insertGeoRiskRuleSchema = createInsertSchema(geoRiskRules);
export const insertDeviceFingerprintSchema = createInsertSchema(deviceFingerprints);
export const insertComplianceLogSchema = createInsertSchema(complianceLogs);

// Insert schemas for multi-card fraud detection
export const insertDeviceIpEventSchema = createInsertSchema(deviceIpEvents).omit({
  id: true,
  createdAt: true,
});
export const insertPaymentSourceSchema = createInsertSchema(paymentSources).omit({
  id: true,
  firstSeen: true,
  lastSeen: true,
});
export const insertFraudTriggerSchema = createInsertSchema(fraudTriggers).omit({
  id: true,
  triggeredAt: true,
});

// Types for KYC verification system
export type KycVerification = typeof kycVerifications.$inferSelect;
export type InsertKycVerification = z.infer<typeof insertKycVerificationSchema>;
export type KycDocument = typeof kycDocuments.$inferSelect;
export type InsertKycDocument = z.infer<typeof insertKycDocumentSchema>;
export type CardScanVerification = typeof cardScanVerifications.$inferSelect;
export type InsertCardScanVerification = z.infer<typeof insertCardScanVerificationSchema>;

// Types for enhanced fraud protection
export type TwoFactorAuth = typeof twoFactorAuth.$inferSelect;
export type InsertTwoFactorAuth = z.infer<typeof insertTwoFactorAuthSchema>;
export type PhoneOtpVerification = typeof phoneOtpVerifications.$inferSelect;
export type InsertPhoneOtpVerification = z.infer<typeof insertPhoneOtpVerificationSchema>;
export type TransactionVelocity = typeof transactionVelocity.$inferSelect;
export type InsertTransactionVelocity = z.infer<typeof insertTransactionVelocitySchema>;
export type GeoRiskRule = typeof geoRiskRules.$inferSelect;
export type InsertGeoRiskRule = z.infer<typeof insertGeoRiskRuleSchema>;
export type DeviceFingerprint = typeof deviceFingerprints.$inferSelect;
export type InsertDeviceFingerprint = z.infer<typeof insertDeviceFingerprintSchema>;
export type ComplianceLog = typeof complianceLogs.$inferSelect;
export type InsertComplianceLog = z.infer<typeof insertComplianceLogSchema>;

// Types for multi-card fraud detection
export type DeviceIpEvent = typeof deviceIpEvents.$inferSelect;
export type InsertDeviceIpEvent = z.infer<typeof insertDeviceIpEventSchema>;
export type PaymentSource = typeof paymentSources.$inferSelect;
export type InsertPaymentSource = z.infer<typeof insertPaymentSourceSchema>;
export type FraudTrigger = typeof fraudTriggers.$inferSelect;
export type InsertFraudTrigger = z.infer<typeof insertFraudTriggerSchema>;

// Invite code schemas
export const insertInviteCodeSchema = createInsertSchema(inviteCodes);
export type InsertInviteCode = z.infer<typeof insertInviteCodeSchema>;
export type InviteCode = typeof inviteCodes.$inferSelect;

// NatCash Transfer schemas
export const insertNatcashTransferSchema = createInsertSchema(natcashTransfers);
export const insertNatcashLimitSchema = createInsertSchema(natcashLimits);

// NatCash Transfer types
export type NatcashTransfer = typeof natcashTransfers.$inferSelect;
export type InsertNatcashTransfer = z.infer<typeof insertNatcashTransferSchema>;
export type NatcashLimit = typeof natcashLimits.$inferSelect;
export type InsertNatcashLimit = z.infer<typeof insertNatcashLimitSchema>;

// MonCash Transfer schemas
export const insertMoncashTransferSchema = createInsertSchema(moncashTransfers);
export const insertMoncashLimitSchema = createInsertSchema(moncashLimits);

// MonCash Transfer types
export type MoncashTransfer = typeof moncashTransfers.$inferSelect;
export type InsertMoncashTransfer = z.infer<typeof insertMoncashTransferSchema>;
export type MoncashLimit = typeof moncashLimits.$inferSelect;
export type InsertMoncashLimit = z.infer<typeof insertMoncashLimitSchema>;

// Location tracking table for mandatory geolocation
export const locationTrackings = pgTable("location_trackings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  device_id: varchar("device_id").notNull(),
  user_id: varchar("user_id").references(() => users.id),
  latitude: decimal("latitude", { precision: 10, scale: 8 }).notNull(), // High precision for GPS coordinates
  longitude: decimal("longitude", { precision: 11, scale: 8 }).notNull(), // High precision for GPS coordinates
  accuracy: decimal("accuracy", { precision: 10, scale: 2 }), // GPS accuracy in meters
  timestamp: timestamp("timestamp").notNull(),
  consent_flag: boolean("consent_flag").notNull().default(true),
  ip_address: varchar("ip_address"),
  user_agent: text("user_agent"),
  session_id: varchar("session_id"),
  purpose: varchar("purpose").default("app_access"), // 'app_access', 'transaction', 'verification', etc.
  is_valid: boolean("is_valid").default(true), // For marking invalid/test locations
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("location_device_idx").on(table.device_id),
  index("location_user_idx").on(table.user_id),
  index("location_timestamp_idx").on(table.timestamp),
]);

// Location tracking schemas
export const insertLocationTrackingSchema = createInsertSchema(locationTrackings).omit({
  id: true,
  createdAt: true,
});

// Location tracking types
export type LocationTracking = typeof locationTrackings.$inferSelect;
export type InsertLocationTracking = z.infer<typeof insertLocationTrackingSchema>;

// User Active Sessions - Single Device Login Enforcement
export const userActiveSessions = pgTable("user_active_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  firebaseUid: varchar("firebase_uid"),
  sessionId: varchar("session_id").notNull(), // Express session ID
  deviceFingerprint: varchar("device_fingerprint"),
  deviceId: varchar("device_id"), // From localStorage
  userAgent: text("user_agent"),
  ipAddress: varchar("ip_address"),
  locationSnapshot: jsonb("location_snapshot"), // GPS data at login
  loginAt: timestamp("login_at").defaultNow(),
  lastSeenAt: timestamp("last_seen_at").defaultNow(),
  logoutAt: timestamp("logout_at"),
  logoutReason: varchar("logout_reason"), // 'user_logout', 'terminated_by_new_login', 'expired', 'forced_admin'
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
}, (table) => [
  index("active_sessions_user_idx").on(table.userId),
  index("active_sessions_session_idx").on(table.sessionId),
  index("active_sessions_device_idx").on(table.deviceId),
]);

// Multi-Device Login Events - Audit & Fraud Detection
export const multiDeviceEvents = pgTable("multi_device_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  eventType: varchar("event_type").notNull(), // 'device_conflict_detected', 'forced_logout', 'login_blocked', 'login_allowed'
  existingDeviceId: varchar("existing_device_id"),
  existingIpAddress: varchar("existing_ip_address"),
  newDeviceId: varchar("new_device_id"),
  newIpAddress: varchar("new_ip_address"),
  newUserAgent: text("new_user_agent"),
  userChoice: varchar("user_choice"), // 'logout_other_device', 'cancel_login', null
  riskScore: integer("risk_score"), // Fraud risk assessment
  locationDistance: decimal("location_distance", { precision: 10, scale: 2 }), // Distance between devices in km
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("multi_device_user_idx").on(table.userId),
  index("multi_device_type_idx").on(table.eventType),
  index("multi_device_created_idx").on(table.createdAt),
]);

// Active Sessions schemas
export const insertUserActiveSessionSchema = createInsertSchema(userActiveSessions).omit({
  id: true,
  loginAt: true,
  lastSeenAt: true,
});

// Multi-Device Events schemas
export const insertMultiDeviceEventSchema = createInsertSchema(multiDeviceEvents).omit({
  id: true,
  createdAt: true,
});

// Active Sessions types
export type UserActiveSession = typeof userActiveSessions.$inferSelect;
export type InsertUserActiveSession = z.infer<typeof insertUserActiveSessionSchema>;

// Multi-Device Events types
export type MultiDeviceEvent = typeof multiDeviceEvents.$inferSelect;
export type InsertMultiDeviceEvent = z.infer<typeof insertMultiDeviceEventSchema>;

// ===== BILL PAYMENTS (UTILITIES) =====

// Bill Transactions table
export const billTransactions = pgTable("bill_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  billerId: integer("biller_id").notNull(), // Reloadly Utilities biller ID
  subscriberAccountNumber: varchar("subscriber_account_number").notNull(), // Meter/account number
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  fee: decimal("fee", { precision: 10, scale: 2 }).default("0.00"),
  currency: varchar("currency").default("USD"),
  status: varchar("status").notNull().default("pending"), // 'pending', 'completed', 'failed', 'refunded'
  reloadlyTransactionId: varchar("reloadly_transaction_id"),
  customIdentifier: varchar("custom_identifier"),
  errorMessage: text("error_message"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("bill_txn_user_idx").on(table.userId),
  index("bill_txn_status_idx").on(table.status),
  index("bill_txn_created_idx").on(table.createdAt),
]);

// Bill Transactions schemas
export const insertBillTransactionSchema = createInsertSchema(billTransactions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Bill Transactions types
export type BillTransaction = typeof billTransactions.$inferSelect;
export type InsertBillTransaction = z.infer<typeof insertBillTransactionSchema>;

// ===== GIFT CARDS =====

// Gift Card Transactions table
export const giftCardTransactions = pgTable("gift_card_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  productId: integer("product_id").notNull(), // Reloadly Gift Cards product ID
  productName: varchar("product_name"),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  quantity: integer("quantity").default(1),
  fee: decimal("fee", { precision: 10, scale: 2 }).default("0.00"),
  currency: varchar("currency").default("USD"),
  status: varchar("status").notNull().default("pending"), // 'pending', 'completed', 'failed', 'refunded'
  reloadlyTransactionId: varchar("reloadly_transaction_id"),
  customIdentifier: varchar("custom_identifier"),
  recipientEmail: varchar("recipient_email"),
  giftCodes: jsonb("gift_codes"), // Array of gift card codes with PIN, expiry, instructions
  errorMessage: text("error_message"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("gift_card_txn_user_idx").on(table.userId),
  index("gift_card_txn_status_idx").on(table.status),
  index("gift_card_txn_created_idx").on(table.createdAt),
]);

// Gift Card Transactions schemas
export const insertGiftCardTransactionSchema = createInsertSchema(giftCardTransactions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Gift Card Transactions types
export type GiftCardTransaction = typeof giftCardTransactions.$inferSelect;
export type InsertGiftCardTransaction = z.infer<typeof insertGiftCardTransactionSchema>;

// ===== CHAT SUPPORT SYSTEM =====

// Chat Conversations - Konvèsasyon chat yo
export const chatConversations = pgTable("chat_conversations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  status: varchar("status").default("active"), // 'active', 'closed', 'waiting_admin', 'bot_only'
  assignedAdminId: varchar("assigned_admin_id").references(() => users.id),
  language: varchar("language").default("en"), // 'en', 'fr', 'es', 'ht'
  lastMessageAt: timestamp("last_message_at").defaultNow(),
  userSatisfactionRating: integer("user_satisfaction_rating"), // 1-5 stars
  createdAt: timestamp("created_at").defaultNow(),
  closedAt: timestamp("closed_at"),
}, (table) => [
  index("chat_conv_user_idx").on(table.userId),
  index("chat_conv_admin_idx").on(table.assignedAdminId),
  index("chat_conv_status_idx").on(table.status),
]);

// Chat Messages - Mesaj chat yo
export const chatMessages = pgTable("chat_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").references(() => chatConversations.id).notNull(),
  senderType: varchar("sender_type").notNull(), // 'user', 'bot', 'admin'
  senderId: varchar("sender_id"), // userId or adminId
  message: text("message").notNull(),
  isAutomated: boolean("is_automated").default(false), // true if from chatbot
  isRead: boolean("is_read").default(false),
  metadata: jsonb("metadata"), // Extra data like attachments, quick replies, etc.
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("chat_msg_conv_idx").on(table.conversationId),
  index("chat_msg_sender_idx").on(table.senderId),
  index("chat_msg_created_idx").on(table.createdAt),
]);

// Automated Chat Responses - Repons otomatik bot la
export const chatAutomatedResponses = pgTable("chat_automated_responses", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  trigger: varchar("trigger").notNull(), // Keyword or phrase that triggers response
  responseEn: text("response_en").notNull(), // English response
  responseFr: text("response_fr").notNull(), // French response
  responseEs: text("response_es").notNull(), // Spanish response
  responseHt: text("response_ht").notNull(), // Haitian Creole response
  category: varchar("category").default("general"), // 'greeting', 'faq', 'support', 'general'
  priority: integer("priority").default(0), // Higher priority triggers checked first
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  triggerConnectAdmin: boolean("trigger_connect_admin").default(false), // If true, offer to connect to admin
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("chat_auto_trigger_idx").on(table.trigger),
  index("chat_auto_active_idx").on(table.isActive),
]);

// Chat schemas
export const insertChatConversationSchema = createInsertSchema(chatConversations).omit({
  id: true,
  createdAt: true,
  lastMessageAt: true,
});

export const insertChatMessageSchema = createInsertSchema(chatMessages).omit({
  id: true,
  createdAt: true,
});

export const insertChatAutomatedResponseSchema = createInsertSchema(chatAutomatedResponses).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Chat types
export type ChatConversation = typeof chatConversations.$inferSelect;
export type InsertChatConversation = z.infer<typeof insertChatConversationSchema>;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;
export type ChatAutomatedResponse = typeof chatAutomatedResponses.$inferSelect;
export type InsertChatAutomatedResponse = z.infer<typeof insertChatAutomatedResponseSchema>;

// ===== GUEST FRAUD PREVENTION =====

// Guest top-up tracking table - tracks all guest transactions for fraud detection
export const guestTopupTracking = pgTable("guest_topup_tracking", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  recipientPhone: varchar("recipient_phone").notNull(),
  ipAddress: varchar("ip_address"),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  transactionId: varchar("transaction_id"), // Reference to transaction ID if completed
  guestEmail: varchar("guest_email"),
  countryCode: varchar("country_code"),
  requiresKyc: boolean("requires_kyc").default(false), // Flag when 3+ transactions detected
  kycSubmitted: boolean("kyc_submitted").default(false),
  kycDocumentUrl: varchar("kyc_document_url"),
  kycStatus: varchar("kyc_status").default("not_required"), // 'not_required', 'required', 'pending', 'verified', 'rejected'
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("guest_topup_phone_idx").on(table.recipientPhone),
  index("guest_topup_ip_idx").on(table.ipAddress),
  index("guest_topup_created_idx").on(table.createdAt),
]);

// Blocked phones table - phones that admins have blocked from making transactions
export const blockedPhones = pgTable("blocked_phones", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phoneNumber: varchar("phone_number").notNull().unique(),
  reason: text("reason"),
  blockedBy: varchar("blocked_by").references(() => users.id),
  blockedAt: timestamp("blocked_at").defaultNow(),
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  notes: text("notes"),
  transactionCount: integer("transaction_count").default(0), // How many transactions before block
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("blocked_phone_number_idx").on(table.phoneNumber),
  index("blocked_phone_active_idx").on(table.isActive),
]);

// Guest top-up tracking schemas
export const insertGuestTopupTrackingSchema = createInsertSchema(guestTopupTracking).omit({
  id: true,
  createdAt: true,
});

export const insertBlockedPhoneSchema = createInsertSchema(blockedPhones).omit({
  id: true,
  createdAt: true,
  blockedAt: true,
});

// Guest fraud prevention types
export type GuestTopupTracking = typeof guestTopupTracking.$inferSelect;
export type InsertGuestTopupTracking = z.infer<typeof insertGuestTopupTrackingSchema>;
export type BlockedPhone = typeof blockedPhones.$inferSelect;
export type InsertBlockedPhone = z.infer<typeof insertBlockedPhoneSchema>;

// ===== CHARGEBACK PROTECTION SYSTEM =====

// Chargebacks table - tracks all PayPal/credit card chargebacks and disputes
export const chargebacks = pgTable("chargebacks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  transactionId: varchar("transaction_id").references(() => transactions.id),
  userId: varchar("user_id").references(() => users.id), // Nullable for guest transactions
  chargebackType: varchar("chargeback_type").notNull(), // 'unauthorized', 'item_not_received', 'not_as_described', 'duplicate', 'fraud'
  status: varchar("status").notNull().default("received"), // 'received', 'under_review', 'evidence_submitted', 'won', 'lost', 'reversed'
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  currency: varchar("currency").default("USD"),
  chargebackFee: decimal("chargeback_fee", { precision: 10, scale: 2 }).default("20.00"), // PayPal chargeback fee
  paymentProvider: varchar("payment_provider").notNull(), // 'paypal', 'stripe', 'credit_card'
  externalChargebackId: varchar("external_chargeback_id"), // PayPal/Stripe dispute ID
  externalTransactionId: varchar("external_transaction_id"), // Original PayPal order ID
  reasonCode: varchar("reason_code"), // Provider's reason code
  reasonDescription: text("reason_description"),
  // Customer Information
  customerEmail: varchar("customer_email"),
  customerName: varchar("customer_name"),
  customerIp: varchar("customer_ip"),
  customerPhone: varchar("customer_phone"),
  // Evidence & Documentation
  evidenceSubmitted: boolean("evidence_submitted").default(false),
  evidenceSubmittedAt: timestamp("evidence_submitted_at"),
  evidenceDocument: text("evidence_document"), // JSON with all evidence data
  deliveryProof: text("delivery_proof"), // Reloadly confirmation, timestamps, etc.
  communicationLogs: text("communication_logs"), // Email history with customer
  // Response & Resolution
  responseDeadline: timestamp("response_deadline"),
  respondedAt: timestamp("responded_at"),
  resolvedAt: timestamp("resolved_at"),
  resolutionNotes: text("resolution_notes"),
  adminNotes: text("admin_notes"),
  // Automatic Blacklist Trigger
  autoBlacklistedUser: boolean("auto_blacklisted_user").default(false),
  blacklistTriggeredAt: timestamp("blacklist_triggered_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("chargeback_transaction_idx").on(table.transactionId),
  index("chargeback_user_idx").on(table.userId),
  index("chargeback_status_idx").on(table.status),
  index("chargeback_created_idx").on(table.createdAt),
]);

// Chargeback Blacklist table - blocks fraudulent users, IPs, emails, PayPal accounts
export const chargebackBlacklist = pgTable("chargeback_blacklist", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  entityType: varchar("entity_type").notNull(), // 'email', 'ip', 'paypal_account', 'phone', 'user_id', 'device_fingerprint'
  entityValue: varchar("entity_value").notNull(), // The actual email/IP/etc to block
  reason: varchar("reason").notNull(), // 'chargeback_abuse', 'fraud', 'manual_block', 'repeated_violations'
  severity: varchar("severity").default("high"), // 'low', 'medium', 'high', 'permanent'
  // Related Information
  relatedUserId: varchar("related_user_id").references(() => users.id),
  relatedTransactionId: varchar("related_transaction_id").references(() => transactions.id),
  relatedChargebackId: varchar("related_chargeback_id").references(() => chargebacks.id),
  // Block Details
  blockCount: integer("block_count").default(1), // How many times this entity was blocked
  totalChargebacks: integer("total_chargebacks").default(0),
  totalLoss: decimal("total_loss", { precision: 10, scale: 2 }).default("0.00"),
  // Admin Actions
  blockedBy: varchar("blocked_by").references(() => users.id), // Admin who added to blacklist
  isActive: boolean("is_active").default(true),
  isGuestOnly: boolean("is_guest_only").default(false), // 🎟️ Flag for guest-only promo codes
  expiresAt: timestamp("expires_at"), // For temporary blocks
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("blacklist_entity_idx").on(table.entityType, table.entityValue),
  index("blacklist_active_idx").on(table.isActive),
  index("blacklist_user_idx").on(table.relatedUserId),
]);

// Password reset token schemas
export const insertPasswordResetTokenSchema = createInsertSchema(passwordResetTokens).omit({
  id: true,
  createdAt: true,
});

export type InsertPasswordResetToken = z.infer<typeof insertPasswordResetTokenSchema>;
export type SelectPasswordResetToken = typeof passwordResetTokens.$inferSelect;

// Chargeback schemas
export const insertChargebackSchema = createInsertSchema(chargebacks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertChargebackBlacklistSchema = createInsertSchema(chargebackBlacklist).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Email Delivery Logs - tracks all email confirmations for PayPal dispute defense
export const emailDeliveryLogs = pgTable("email_delivery_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  transactionId: varchar("transaction_id").references(() => transactions.id),
  userId: varchar("user_id").references(() => users.id),
  emailType: varchar("email_type").notNull(), // 'transaction_confirmation', 'gift_card_delivery', 'bill_payment_confirmation', 'topup_confirmation'
  recipientEmail: varchar("recipient_email").notNull(),
  recipientName: varchar("recipient_name"),
  subject: text("subject").notNull(),
  htmlContent: text("html_content"),
  textContent: text("text_content"),
  // Delivery Proof
  deliveryStatus: varchar("delivery_status").default("sent"), // 'sent', 'delivered', 'failed', 'bounced'
  deliveryProof: text("delivery_proof"), // JSON with provider response
  sentAt: timestamp("sent_at").defaultNow(),
  deliveredAt: timestamp("delivered_at"),
  // Legal Protection Data
  customerIp: varchar("customer_ip"),
  userAgent: varchar("user_agent"),
  acceptedTerms: boolean("accepted_terms").default(false),
  termsVersion: varchar("terms_version"),
  transactionDetails: text("transaction_details"), // JSON with complete transaction data
  // Metadata
  emailProvider: varchar("email_provider").default("twilio_sendgrid"), // 'twilio_sendgrid', 'ses', 'manual'
  messageId: varchar("message_id"), // Provider message ID
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("email_log_transaction_idx").on(table.transactionId),
  index("email_log_user_idx").on(table.userId),
  index("email_log_email_idx").on(table.recipientEmail),
  index("email_log_created_idx").on(table.createdAt),
]);

// Email delivery log schemas
export const insertEmailDeliveryLogSchema = createInsertSchema(emailDeliveryLogs).omit({
  id: true,
  createdAt: true,
});

// Chargeback types
export type Chargeback = typeof chargebacks.$inferSelect;
export type InsertChargeback = z.infer<typeof insertChargebackSchema>;
export type ChargebackBlacklistEntry = typeof chargebackBlacklist.$inferSelect;
export type InsertChargebackBlacklistEntry = z.infer<typeof insertChargebackBlacklistSchema>;
export type EmailDeliveryLog = typeof emailDeliveryLogs.$inferSelect;
export type InsertEmailDeliveryLog = z.infer<typeof insertEmailDeliveryLogSchema>;

// Promo Popup Settings - Admin configurable promotional popup
export const promoPopupSettings = pgTable("promo_popup_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  isActive: boolean("is_active").default(true),
  imageUrl: text("image_url"), // URL or base64 of the promo image
  // Multi-language text content
  titleEn: varchar("title_en").default("NEW USER BONUS"),
  titleFr: varchar("title_fr").default("BONUS NOUVEAU UTILISATEUR"),
  titleEs: varchar("title_es").default("BONO NUEVO USUARIO"),
  titleHt: varchar("title_ht").default("BONIS NOUVO ITILIZATÈ"),
  subtitleEn: varchar("subtitle_en").default("+10% FREE CREDIT!"),
  subtitleFr: varchar("subtitle_fr").default("+10% CRÉDIT GRATUIT!"),
  subtitleEs: varchar("subtitle_es").default("+10% CRÉDITO GRATIS!"),
  subtitleHt: varchar("subtitle_ht").default("+10% KREDI GRATIS!"),
  // Button text translations
  buttonTextEn: varchar("button_text_en").default("Top-up Now"),
  buttonTextFr: varchar("button_text_fr").default("Recharger Maintenant"),
  buttonTextEs: varchar("button_text_es").default("Recargar Ahora"),
  buttonTextHt: varchar("button_text_ht").default("Rechaje Kounye a"),
  // Settings
  buttonLink: varchar("button_link").default("/topup"),
  displayIntervalMinutes: integer("display_interval_minutes").default(10),
  // Operator display settings
  hideDataOperators: boolean("hide_data_operators").default(false), // Hide bundle/data operators from topup page
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertPromoPopupSettingsSchema = createInsertSchema(promoPopupSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type PromoPopupSettings = typeof promoPopupSettings.$inferSelect;
export type InsertPromoPopupSettings = z.infer<typeof insertPromoPopupSettingsSchema>;

// WebAuthn Credentials for biometric/passkey login
export const webauthnCredentials = pgTable("webauthn_credentials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  credentialId: text("credential_id").notNull().unique(), // Base64 encoded credential ID from authenticator
  publicKey: text("public_key").notNull(), // Base64 encoded public key
  counter: integer("counter").default(0).notNull(), // Signature counter for replay attack prevention
  deviceType: varchar("device_type").default("unknown"), // 'platform' (built-in) or 'cross-platform' (USB key)
  transports: text("transports"), // JSON array of transports: ['internal', 'usb', 'ble', 'nfc']
  deviceName: varchar("device_name"), // User-friendly name like "iPhone 15 Pro" or "MacBook Pro Touch ID"
  isActive: boolean("is_active").default(true),
  lastUsed: timestamp("last_used"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("webauthn_user_idx").on(table.userId),
  index("webauthn_credential_idx").on(table.credentialId),
]);

export const insertWebauthnCredentialSchema = createInsertSchema(webauthnCredentials).omit({
  id: true,
  createdAt: true,
  lastUsed: true,
});

export type WebauthnCredential = typeof webauthnCredentials.$inferSelect;
export type InsertWebauthnCredential = z.infer<typeof insertWebauthnCredentialSchema>;

// ==========================================
// BETTING TIPS SYSTEM
// ==========================================

// Betting Tips table - Main tips created by admin
export const bettingTips = pgTable("betting_tips", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Type: 'single' (one match) or 'combination' (multiple matches)
  tipType: varchar("tip_type").notNull().default("single"), // 'single', 'combination'
  sport: varchar("sport").notNull(), // 'football', 'tennis', 'basketball'
  // For single tips - main match info
  league: varchar("league"), // Competition/League name
  team1: varchar("team1"), // Team/Player 1
  team2: varchar("team2"), // Team/Player 2
  country1: varchar("country1"), // Country code for team1 flag
  country2: varchar("country2"), // Country code for team2 flag
  matchDate: timestamp("match_date"),
  tip: varchar("tip"), // Over/Under, 1X2, BTTS, Handicap, etc.
  odds: decimal("odds", { precision: 6, scale: 2 }), // Optional odds info
  // Risk and stake
  risk: varchar("risk").default("medium"), // 'low', 'medium', 'high'
  stake: integer("stake").default(3), // 1-5 units
  // Analysis
  analysis: text("analysis"), // Short analysis (3-6 points)
  // Access control
  isVip: boolean("is_vip").default(false), // VIP-only tip
  isFree: boolean("is_free").default(true), // Free tip (overrides VIP)
  // Per-tip purchase option (for non-VIP users who want to buy individual tips)
  tipPrice: decimal("tip_price", { precision: 6, scale: 2 }), // Price to buy this single tip (null = not available for individual purchase)
  // Status
  status: varchar("status").default("draft"), // 'draft', 'published', 'scheduled'
  publishAt: timestamp("publish_at"), // For scheduled publishing
  // API-Football fixture ID (for auto result update)
  fixtureId: integer("fixture_id"), // API-Football fixture ID to fetch final score
  // Results (after match)
  result: varchar("result"), // 'won', 'lost', 'void', 'pending'
  finalScore: varchar("final_score"), // "2-1", "6-4 3-6 7-5", etc.
  resultUpdatedAt: timestamp("result_updated_at"),
  resultUpdatedBy: varchar("result_updated_by").references(() => users.id),
  // For combination tips - total odds
  totalOdds: decimal("total_odds", { precision: 8, scale: 2 }),
  // Timestamps
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("betting_tips_sport_idx").on(table.sport),
  index("betting_tips_status_idx").on(table.status),
  index("betting_tips_result_idx").on(table.result),
  index("betting_tips_date_idx").on(table.matchDate),
]);

// Betting Tip Matches - For combination tips with multiple matches
export const bettingTipMatches = pgTable("betting_tip_matches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tipId: varchar("tip_id").references(() => bettingTips.id).notNull(),
  // Match info
  sport: varchar("sport").notNull(), // 'football', 'tennis', 'basketball'
  league: varchar("league"),
  team1: varchar("team1").notNull(),
  team2: varchar("team2").notNull(),
  country1: varchar("country1"), // Country code for flag
  country2: varchar("country2"), // Country code for flag
  matchDate: timestamp("match_date"),
  tip: varchar("tip").notNull(), // Prediction type
  odds: decimal("odds", { precision: 6, scale: 2 }),
  fixtureId: integer("fixture_id"), // API-Football fixture ID
  // Result
  result: varchar("result"), // 'won', 'lost', 'void', 'pending'
  finalScore: varchar("final_score"),
  // Order in combination
  orderIndex: integer("order_index").default(0),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("betting_tip_matches_tip_idx").on(table.tipId),
]);

// VIP Subscriptions - User access to VIP betting tips
export const vipSubscriptions = pgTable("vip_subscriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  // Subscription type
  planType: varchar("plan_type").notNull(), // 'daily', 'weekly', 'monthly'
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  currency: varchar("currency").default("USD"),
  // Duration
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date").notNull(),
  // Status
  status: varchar("status").default("active"), // 'active', 'expired', 'cancelled'
  // Payment reference
  paymentMethod: varchar("payment_method"), // 'wallet', 'paypal'
  transactionId: varchar("transaction_id"),
  // Metadata
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("vip_sub_user_idx").on(table.userId),
  index("vip_sub_status_idx").on(table.status),
  index("vip_sub_end_idx").on(table.endDate),
]);

// Tip Purchases - Individual tip purchases for non-VIP users
export const tipPurchases = pgTable("tip_purchases", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  tipId: varchar("tip_id").references(() => bettingTips.id).notNull(),
  price: decimal("price", { precision: 6, scale: 2 }).notNull(),
  currency: varchar("currency").default("USD"),
  paymentMethod: varchar("payment_method").notNull(), // 'wallet', 'paypal'
  transactionId: varchar("transaction_id"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("tip_purchases_user_idx").on(table.userId),
  index("tip_purchases_tip_idx").on(table.tipId),
]);

// Betting Tips Schemas
export const insertBettingTipSchema = createInsertSchema(bettingTips).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertBettingTipMatchSchema = createInsertSchema(bettingTipMatches).omit({
  id: true,
  createdAt: true,
});

export const insertVipSubscriptionSchema = createInsertSchema(vipSubscriptions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertTipPurchaseSchema = createInsertSchema(tipPurchases).omit({
  id: true,
  createdAt: true,
});

// Betting Tips Types
export type BettingTip = typeof bettingTips.$inferSelect;
export type InsertBettingTip = z.infer<typeof insertBettingTipSchema>;
export type BettingTipMatch = typeof bettingTipMatches.$inferSelect;
export type InsertBettingTipMatch = z.infer<typeof insertBettingTipMatchSchema>;
export type VipSubscription = typeof vipSubscriptions.$inferSelect;
export type InsertVipSubscription = z.infer<typeof insertVipSubscriptionSchema>;
export type TipPurchase = typeof tipPurchases.$inferSelect;
export type InsertTipPurchase = z.infer<typeof insertTipPurchaseSchema>;

// ============================================================
// FAVORITES / QUICK CONTACTS - Save beneficiaries for fast top-up
// ============================================================

export const favorites = pgTable("favorites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  nickname: varchar("nickname").notNull(), // Display name for the contact (e.g., "Manman", "Papa", "Ti Frè")
  phoneNumber: varchar("phone_number").notNull(), // Full phone number with country code
  countryCode: varchar("country_code", { length: 2 }), // ISO country code (e.g., "HT", "US")
  countryName: varchar("country_name"), // Country name for display
  operatorId: varchar("operator_id"), // Preferred operator ID
  operatorName: varchar("operator_name"), // Operator name for display
  operatorLogo: varchar("operator_logo"), // Operator logo URL
  lastTopupAmount: decimal("last_topup_amount", { precision: 10, scale: 2 }), // Last amount sent
  lastTopupDate: timestamp("last_topup_date"), // Last time this contact was topped up
  topupCount: integer("topup_count").default(0), // Number of times topped up
  isFavorite: boolean("is_favorite").default(true), // Can be toggled off
  notes: text("notes"), // Optional notes
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("favorites_user_idx").on(table.userId),
  index("favorites_phone_idx").on(table.phoneNumber),
]);

// Favorites Schemas
export const insertFavoriteSchema = createInsertSchema(favorites).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastTopupDate: true,
  topupCount: true,
});

// Favorites Types
export type Favorite = typeof favorites.$inferSelect;
export type InsertFavorite = z.infer<typeof insertFavoriteSchema>;

// ============================================================
// BUYFAST CASH PICK - Local agent cash pickup service
// ============================================================

// Cash Pick Agents - Local agents who process cash pickups
export const cashPickAgents = pgTable("cash_pick_agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id), // Link to user account if agent has one
  agentCode: varchar("agent_code").unique().notNull(), // Unique agent code (e.g., "BF-AGT-001")
  businessName: varchar("business_name").notNull(), // Business/shop name
  ownerName: varchar("owner_name").notNull(), // Agent owner name
  phoneNumber: varchar("phone_number").notNull(),
  whatsappNumber: varchar("whatsapp_number"),
  email: varchar("email"),
  address: text("address").notNull(),
  city: varchar("city").notNull(),
  department: varchar("department"), // State/Province/Department
  country: varchar("country").default("Haiti"),
  gpsLatitude: decimal("gps_latitude", { precision: 10, scale: 7 }),
  gpsLongitude: decimal("gps_longitude", { precision: 10, scale: 7 }),
  commissionRate: decimal("commission_rate", { precision: 5, scale: 2 }).default("2.00"), // Agent commission % per pickup
  commissionBalance: decimal("commission_balance", { precision: 10, scale: 2 }).default("0.00"), // Earned commission
  walletBalance: decimal("wallet_balance", { precision: 12, scale: 2 }).default("0.00"), // Agent's wallet balance for payouts
  reservedBalance: decimal("reserved_balance", { precision: 12, scale: 2 }).default("0.00"), // Reserved for pending transactions
  dailyLimit: decimal("daily_limit", { precision: 10, scale: 2 }).default("5000.00"), // Max daily payout in USD
  todayPayouts: decimal("today_payouts", { precision: 10, scale: 2 }).default("0.00"), // Today's total payouts
  totalPickups: integer("total_pickups").default(0), // Total pickups processed
  totalPayoutAmount: decimal("total_payout_amount", { precision: 12, scale: 2 }).default("0.00"), // Total amount paid out
  rating: decimal("rating", { precision: 3, scale: 2 }).default("5.00"), // Agent rating (1-5)
  isActive: boolean("is_active").default(true),
  isVerified: boolean("is_verified").default(false), // Admin verified agent
  isCentralAgent: boolean("is_central_agent").default(false), // Central agent with special portal access
  dailyPickupsCount: integer("daily_pickups_count").default(0), // Today's pickup count (resets daily)
  dailyCommissionEarned: decimal("daily_commission_earned", { precision: 10, scale: 2 }).default("0.00"), // Today's commission (resets daily)
  lastDailyReset: timestamp("last_daily_reset"), // When daily stats were last reset
  verifiedAt: timestamp("verified_at"),
  verifiedBy: varchar("verified_by").references(() => users.id),
  pin: varchar("pin"), // 4-digit PIN for agent login
  lastActiveAt: timestamp("last_active_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("cash_pick_agents_code_idx").on(table.agentCode),
  index("cash_pick_agents_city_idx").on(table.city),
  index("cash_pick_agents_active_idx").on(table.isActive),
]);

// Cash Pick Transactions - Money transfers for cash pickup
export const cashPickTransactions = pgTable("cash_pick_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  pickupCode: varchar("pickup_code").unique().notNull(), // Unique code (e.g., "BP-847291")
  senderId: varchar("sender_id").references(() => users.id).notNull(), // User who sent the money
  senderName: varchar("sender_name").notNull(),
  senderPhone: varchar("sender_phone"),
  senderEmail: varchar("sender_email"),
  recipientName: varchar("recipient_name").notNull(), // Person who will pick up
  recipientPhone: varchar("recipient_phone").notNull(),
  recipientIdType: varchar("recipient_id_type"), // ID type required (e.g., "national_id", "passport", "driver_license")
  recipientIdNumber: varchar("recipient_id_number"), // ID number for verification
  amountUSD: decimal("amount_usd", { precision: 10, scale: 2 }).notNull(), // Amount in USD
  amountHTG: decimal("amount_htg", { precision: 12, scale: 2 }).notNull(), // Amount in HTG
  exchangeRate: decimal("exchange_rate", { precision: 10, scale: 4 }).notNull(), // USD to HTG rate used
  serviceFee: decimal("service_fee", { precision: 8, scale: 2 }).default("0.00"), // BuyFast service fee
  govtTax: decimal("govt_tax", { precision: 8, scale: 2 }).default("0.00"), // Haiti government tax
  agentFee: decimal("agent_fee", { precision: 8, scale: 2 }).default("0.00"), // Agent fee
  totalFees: decimal("total_fees", { precision: 8, scale: 2 }).default("0.00"), // Total fees deducted
  agentCommission: decimal("agent_commission", { precision: 8, scale: 2 }).default("0.00"), // Agent commission
  netAmountToRecipient: decimal("net_amount_to_recipient", { precision: 12, scale: 2 }).notNull(), // Final amount recipient gets
  paymentMethod: varchar("payment_method").notNull(), // 'wallet', 'paypal', 'moncash'
  paymentReference: varchar("payment_reference"), // Payment transaction ID
  status: varchar("status").default("pending"), // 'pending', 'ready', 'picked_up', 'expired', 'cancelled', 'refunded'
  pickupAgentId: varchar("pickup_agent_id").references(() => cashPickAgents.id), // Agent who processed pickup
  pickupAgentCode: varchar("pickup_agent_code"), // Agent code for reference
  pickedUpAt: timestamp("picked_up_at"), // When money was picked up
  pickedUpBy: varchar("picked_up_by"), // Name of person who picked up
  pickupIdPhoto: varchar("pickup_id_photo"), // Photo of ID used for pickup
  pickupSignature: text("pickup_signature"), // Digital signature if any
  expiresAt: timestamp("expires_at").notNull(), // When pickup code expires
  secretQuestion: varchar("secret_question"), // Optional security question
  secretAnswer: varchar("secret_answer"), // Answer to security question
  senderNotified: boolean("sender_notified").default(false),
  recipientNotified: boolean("recipient_notified").default(false),
  cancelledAt: timestamp("cancelled_at"),
  cancelledBy: varchar("cancelled_by").references(() => users.id),
  cancellationReason: text("cancellation_reason"),
  refundedAt: timestamp("refunded_at"),
  refundAmount: decimal("refund_amount", { precision: 10, scale: 2 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("cash_pick_tx_code_idx").on(table.pickupCode),
  index("cash_pick_tx_sender_idx").on(table.senderId),
  index("cash_pick_tx_status_idx").on(table.status),
  index("cash_pick_tx_agent_idx").on(table.pickupAgentId),
  index("cash_pick_tx_expires_idx").on(table.expiresAt),
]);

// Cash Pick Agent Activity Log
export const cashPickAgentLogs = pgTable("cash_pick_agent_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").references(() => cashPickAgents.id).notNull(),
  transactionId: varchar("transaction_id").references(() => cashPickTransactions.id),
  action: varchar("action").notNull(), // 'login', 'logout', 'pickup_verify', 'pickup_complete', 'pickup_reject'
  details: text("details"),
  ipAddress: varchar("ip_address"),
  deviceInfo: text("device_info"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("cash_pick_log_agent_idx").on(table.agentId),
  index("cash_pick_log_tx_idx").on(table.transactionId),
]);

// Cash Pick Agent Wallet Transactions - Ledger for agent wallet movements
export const cashPickAgentWalletTransactions = pgTable("cash_pick_agent_wallet_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").references(() => cashPickAgents.id).notNull(),
  transactionType: varchar("transaction_type").notNull(), // 'funding', 'deduction', 'adjustment', 'commission'
  amountUSD: decimal("amount_usd", { precision: 12, scale: 2 }).notNull(),
  amountHTG: decimal("amount_htg", { precision: 14, scale: 2 }),
  exchangeRate: decimal("exchange_rate", { precision: 10, scale: 4 }),
  balanceBefore: decimal("balance_before", { precision: 12, scale: 2 }).notNull(),
  balanceAfter: decimal("balance_after", { precision: 12, scale: 2 }).notNull(),
  referenceId: varchar("reference_id"), // Reference to cash pick transaction ID
  referenceType: varchar("reference_type"), // 'cash_pick', 'manual', 'refund'
  description: text("description"),
  processedBy: varchar("processed_by").references(() => users.id), // Admin who processed funding
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("cash_pick_agent_wallet_tx_agent_idx").on(table.agentId),
  index("cash_pick_agent_wallet_tx_type_idx").on(table.transactionType),
  index("cash_pick_agent_wallet_tx_ref_idx").on(table.referenceId),
]);

// Cash Pick Fee Settings - Configurable fees for cash pick service (ALL FEES ARE PERCENTAGES based on HTG amount)
export const cashPickFeeSettings = pgTable("cash_pick_fee_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  serviceFeeType: varchar("service_fee_type").default("percentage"), // Always 'percentage' - calculated on HTG amount
  serviceFeeValue: decimal("service_fee_value", { precision: 8, scale: 2 }).default("5.00"), // BuyFast service fee % (based on HTG)
  govtTaxUSD: decimal("govt_tax_usd", { precision: 8, scale: 2 }).default("2.00"), // Government tax % (based on HTG) - field name kept for compatibility
  agentFeeUSD: decimal("agent_fee_usd", { precision: 8, scale: 2 }).default("5.00"), // Agent fee % (based on HTG) - field name kept for compatibility
  minAmountUSD: decimal("min_amount_usd", { precision: 10, scale: 2 }).default("10.00"), // Minimum send amount in USD
  maxAmountUSD: decimal("max_amount_usd", { precision: 10, scale: 2 }).default("1000.00"), // Maximum send amount in USD
  expirationDays: integer("expiration_days").default(7), // Days until pickup code expires
  isActive: boolean("is_active").default(true),
  updatedBy: varchar("updated_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Cash Pick Schemas
export const insertCashPickAgentSchema = createInsertSchema(cashPickAgents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  verifiedAt: true,
  lastActiveAt: true,
  totalPickups: true,
  totalPayoutAmount: true,
  todayPayouts: true,
  commissionBalance: true,
  walletBalance: true,
  reservedBalance: true,
});

export const insertCashPickTransactionSchema = createInsertSchema(cashPickTransactions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  pickedUpAt: true,
  cancelledAt: true,
  refundedAt: true,
});

export const insertCashPickAgentLogSchema = createInsertSchema(cashPickAgentLogs).omit({
  id: true,
  createdAt: true,
});

export const insertCashPickAgentWalletTransactionSchema = createInsertSchema(cashPickAgentWalletTransactions).omit({
  id: true,
  createdAt: true,
});

export const insertCashPickFeeSettingsSchema = createInsertSchema(cashPickFeeSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Cash Pick Types
export type CashPickAgent = typeof cashPickAgents.$inferSelect;
export type InsertCashPickAgent = z.infer<typeof insertCashPickAgentSchema>;
export type CashPickTransaction = typeof cashPickTransactions.$inferSelect;
export type InsertCashPickTransaction = z.infer<typeof insertCashPickTransactionSchema>;
export type CashPickAgentLog = typeof cashPickAgentLogs.$inferSelect;
export type InsertCashPickAgentLog = z.infer<typeof insertCashPickAgentLogSchema>;
export type CashPickAgentWalletTransaction = typeof cashPickAgentWalletTransactions.$inferSelect;
export type InsertCashPickAgentWalletTransaction = z.infer<typeof insertCashPickAgentWalletTransactionSchema>;
export type CashPickFeeSettings = typeof cashPickFeeSettings.$inferSelect;
export type InsertCashPickFeeSettings = z.infer<typeof insertCashPickFeeSettingsSchema>;

// Platform Statistics - Dynamic counters for trusted stats display
export const platformStats = pgTable("platform_stats", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  statKey: varchar("stat_key").notNull().unique(), // 'customers', 'transactions', 'countries', 'success_rate'
  statValue: integer("stat_value").notNull().default(0),
  displayValue: varchar("display_value"), // e.g., "15K+", "98.5%"
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertPlatformStatsSchema = createInsertSchema(platformStats).omit({
  id: true,
  updatedAt: true,
});

export type PlatformStats = typeof platformStats.$inferSelect;
export type InsertPlatformStats = z.infer<typeof insertPlatformStatsSchema>;

// ─── Payment Visibility Settings ──────────────────────────────────────────────
// Controls whether Stripe/PayPal buttons are shown on each service page
export const paymentVisibility = pgTable("payment_visibility", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  service: varchar("service", { length: 50 }).notNull().unique(),
  stripeEnabled: boolean("stripe_enabled").notNull().default(true),
  paypalEnabled: boolean("paypal_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type PaymentVisibility = typeof paymentVisibility.$inferSelect;

// ─── Thunes International Transfer ────────────────────────────────────────────
// All Thunes payouts: Mobile Money, Bank Transfer, Cash Pick-up, Mobile Top-Up
// Fund Requests table — WU/MoneyGram/MonCash/NatCash → PayPal or Wallet
export const fundRequests = pgTable("fund_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),

  receiveType: varchar("receive_type").notNull(), // 'paypal' | 'wallet'
  fullName: varchar("full_name").notNull(),
  phone: varchar("phone").notNull(),
  country: varchar("country").notNull(),
  paypalEmail: varchar("paypal_email"),

  sendAmount: decimal("send_amount", { precision: 10, scale: 2 }).notNull(),
  feeAmount: decimal("fee_amount", { precision: 10, scale: 2 }).notNull(),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
  feePercentage: decimal("fee_percentage", { precision: 5, scale: 2 }).notNull(),

  paymentMethod: varchar("payment_method").notNull(), // 'western_union' | 'moneygram' | 'moncash' | 'natcash'

  referenceNumber: varchar("reference_number").notNull(),
  senderName: varchar("sender_name").notNull(),
  sentAmount: decimal("sent_amount", { precision: 10, scale: 2 }).notNull(),
  sentDate: varchar("sent_date").notNull(),
  proofImageData: text("proof_image_data"),
  customerProofImageData: text("customer_proof_image_data"),

  status: varchar("status").notNull().default("pending"),
  adminNote: text("admin_note"),
  processedBy: varchar("processed_by"),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertFundRequestSchema = createInsertSchema(fundRequests).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  processedAt: true,
  processedBy: true,
  adminNote: true,
  status: true,
  customerProofImageData: true,
});

export type FundRequest = typeof fundRequests.$inferSelect;
export type InsertFundRequest = z.infer<typeof insertFundRequestSchema>;

export const thunesTransactions = pgTable("thunes_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  thunesTransactionId: varchar("thunes_transaction_id"),     // Thunes internal ID
  thunesQuotationId: varchar("thunes_quotation_id"),         // Thunes quotation ID
  serviceType: varchar("service_type").notNull(),            // 'mobile_money' | 'bank_transfer' | 'cash_pickup' | 'mobile_topup'
  status: varchar("status").notNull().default("pending"),    // pending | approved | completed | failed | cancelled
  payerCode: varchar("payer_code"),                          // e.g. NATCOM_HTI_NATCASH
  payerName: varchar("payer_name"),                          // Human-readable payer name
  destinationCountry: varchar("destination_country"),        // ISO code e.g. HT, BR, MX
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),        // USD sent
  fee: decimal("fee", { precision: 10, scale: 2 }).default("0.00"),        // Service fee USD
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }),       // amount + fee
  recipientAmount: decimal("recipient_amount", { precision: 10, scale: 2 }),// Local currency
  recipientCurrency: varchar("recipient_currency"),          // HTG, BRL, MXN...
  exchangeRate: decimal("exchange_rate", { precision: 12, scale: 4 }),
  recipientName: varchar("recipient_name"),
  recipientPhone: varchar("recipient_phone"),                // For mobile money
  recipientAccountNumber: varchar("recipient_account_number"), // For bank transfer
  recipientBankCode: varchar("recipient_bank_code"),         // For bank transfer
  recipientBankName: varchar("recipient_bank_name"),
  recipientIban: varchar("recipient_iban"),                  // For SEPA
  pickupCode: varchar("pickup_code"),                        // For cash pick-up
  paymentMethod: varchar("payment_method").notNull().default("wallet"), // wallet | stripe | paypal
  completionReason: text("completion_reason"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertThunesTransactionSchema = createInsertSchema(thunesTransactions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type ThunesTransaction = typeof thunesTransactions.$inferSelect;
export type InsertThunesTransaction = z.infer<typeof insertThunesTransactionSchema>;

// Hero Image Settings - Admin configurable hero banner image
export const heroImageSettings = pgTable("hero_image_settings", {
  id: varchar("id").primaryKey().default('default'),
  heroImageUrl: text("hero_image_url").default('/hero-banner.webp'),
  imageData: text("image_data"),
  imageMimeType: varchar("image_mime_type").default('image/webp'),
});

export type HeroImageSettings = typeof heroImageSettings.$inferSelect;

// Hero Slides - Multiple animated hero images/videos (slideshow)
export const heroSlides = pgTable("hero_slides", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  imageData: text("image_data"),
  imageMimeType: varchar("image_mime_type").default("image/jpeg"),
  mediaType: varchar("media_type").default("image").notNull(), // 'image' | 'video'
  sortOrder: integer("sort_order").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type HeroSlide = typeof heroSlides.$inferSelect;

// ============================================================
// WALLET FINANCIAL SYSTEM — BuyFast v2
// Wallet-to-Wallet Transfers, Cash Out QR, Payment Requests
// ============================================================

// Wallet-to-Wallet Transfers
export const walletTransfers = pgTable("wallet_transfers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fromUserId: varchar("from_user_id").references(() => users.id).notNull(),
  toUserId: varchar("to_user_id").references(() => users.id).notNull(),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  fee: decimal("fee", { precision: 10, scale: 2 }).default("0.00"),
  note: text("note"),
  status: varchar("status").default("completed").notNull(), // completed, failed, reversed
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertWalletTransferSchema = createInsertSchema(walletTransfers).omit({ id: true, createdAt: true });
export type WalletTransfer = typeof walletTransfers.$inferSelect;
export type InsertWalletTransfer = z.infer<typeof insertWalletTransferSchema>;

// Cashout Requests (QR-based cash out via agent)
export const cashoutRequests = pgTable("cashout_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  agentId: varchar("agent_id").references(() => users.id),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  fee: decimal("fee", { precision: 10, scale: 2 }).default("0.00"),
  agentCommission: decimal("agent_commission", { precision: 10, scale: 2 }).default("0.00"),
  netAmount: decimal("net_amount", { precision: 10, scale: 2 }).notNull(),
  qrToken: varchar("qr_token").unique().notNull(),
  transactionCode: varchar("transaction_code").unique().notNull(),
  status: varchar("status").default("pending").notNull(), // pending, completed, expired, cancelled
  expiresAt: timestamp("expires_at").notNull(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertCashoutRequestSchema = createInsertSchema(cashoutRequests).omit({ id: true, createdAt: true });
export type CashoutRequest = typeof cashoutRequests.$inferSelect;
export type InsertCashoutRequest = z.infer<typeof insertCashoutRequestSchema>;

// Payment Requests between users
export const paymentRequests = pgTable("payment_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  requesterId: varchar("requester_id").references(() => users.id).notNull(),
  payerId: varchar("payer_id").references(() => users.id),
  payerEmail: varchar("payer_email"),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  note: text("note"),
  status: varchar("status").default("pending").notNull(), // pending, paid, rejected, expired, cancelled
  paidAt: timestamp("paid_at"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertPaymentRequestSchema = createInsertSchema(paymentRequests).omit({ id: true, createdAt: true });
export type PaymentRequest = typeof paymentRequests.$inferSelect;
export type InsertPaymentRequest = z.infer<typeof insertPaymentRequestSchema>;

// Cashout Fee Settings (Admin-configurable)
export const cashoutFeeSettings = pgTable("cashout_fee_settings", {
  id: integer("id").primaryKey().default(1),
  feeType: varchar("fee_type").default("percentage").notNull(), // 'percentage' | 'fixed'
  feeValue: decimal("fee_value", { precision: 5, scale: 2 }).default("2.00").notNull(),
  minFee: decimal("min_fee", { precision: 10, scale: 2 }).default("0.50"),
  maxFee: decimal("max_fee", { precision: 10, scale: 2 }).default("50.00"),
  agentCommissionRate: decimal("agent_commission_rate", { precision: 5, scale: 2 }).default("1.00"),
  minCashoutAmount: decimal("min_cashout_amount", { precision: 10, scale: 2 }).default("5.00"),
  maxCashoutAmount: decimal("max_cashout_amount", { precision: 10, scale: 2 }).default("2000.00"),
  qrExpiryMinutes: integer("qr_expiry_minutes").default(15),
  isEnabled: boolean("is_enabled").default(true),
  updatedBy: varchar("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertCashoutFeeSettingsSchema = createInsertSchema(cashoutFeeSettings).omit({ updatedAt: true });
export type CashoutFeeSettings = typeof cashoutFeeSettings.$inferSelect;
export type InsertCashoutFeeSettings = z.infer<typeof insertCashoutFeeSettingsSchema>;

// Wallet Transfer Fee Settings (Admin-configurable)
export const walletTransferFeeSettings = pgTable("wallet_transfer_fee_settings", {
  id: integer("id").primaryKey().default(1),
  feeType: varchar("fee_type").default("percentage").notNull(), // 'percentage' | 'fixed'
  feeValue: decimal("fee_value", { precision: 5, scale: 2 }).default("0.00").notNull(),
  minFee: decimal("min_fee", { precision: 10, scale: 2 }).default("0.00"),
  maxFee: decimal("max_fee", { precision: 10, scale: 2 }).default("10.00"),
  minTransferAmount: decimal("min_transfer_amount", { precision: 10, scale: 2 }).default("1.00"),
  maxTransferAmount: decimal("max_transfer_amount", { precision: 10, scale: 2 }).default("10000.00"),
  isEnabled: boolean("is_enabled").default(true),
  updatedBy: varchar("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertWalletTransferFeeSettingsSchema = createInsertSchema(walletTransferFeeSettings).omit({ updatedAt: true });
export type WalletTransferFeeSettings = typeof walletTransferFeeSettings.$inferSelect;
export type InsertWalletTransferFeeSettings = z.infer<typeof insertWalletTransferFeeSettingsSchema>;

// ============================================================
// NATCASH → MONCASH EXCHANGE SYSTEM
// ============================================================

export const natcashMoncashExchangeSettings = pgTable("natcash_moncash_exchange_settings", {
  id: integer("id").primaryKey().default(1),
  exchangeRate: decimal("exchange_rate", { precision: 6, scale: 4 }).default("1.0000").notNull(), // multiplier: 1 NatCash HTG → X MonCash HTG
  minAmount: decimal("min_amount", { precision: 10, scale: 2 }).default("100.00").notNull(),
  maxAmount: decimal("max_amount", { precision: 10, scale: 2 }).default("50000.00").notNull(),
  natcashBusinessNumber: varchar("natcash_business_number").default("").notNull(),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  updatedBy: varchar("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertNatcashMoncashExchangeSettingsSchema = createInsertSchema(natcashMoncashExchangeSettings).omit({ updatedAt: true });
export type NatcashMoncashExchangeSettings = typeof natcashMoncashExchangeSettings.$inferSelect;

export const natcashMoncashExchanges = pgTable("natcash_moncash_exchanges", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orderId: varchar("order_id").unique().notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  amountSent: decimal("amount_sent", { precision: 10, scale: 2 }).notNull(),     // HTG user sends via NatCash
  amountToReceive: decimal("amount_to_receive", { precision: 10, scale: 2 }).notNull(), // HTG user gets on MonCash
  exchangeRate: decimal("exchange_rate", { precision: 6, scale: 4 }).notNull(),
  moncashPhone: varchar("moncash_phone").notNull(),
  status: varchar("status").default("pending").notNull(), // pending | waiting_confirmation | processing | completed | cancelled
  proofImageData: text("proof_image_data"),
  adminNote: text("admin_note"),
  processedBy: varchar("processed_by").references(() => users.id),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertNatcashMoncashExchangeSchema = createInsertSchema(natcashMoncashExchanges).omit({ id: true, createdAt: true });
export type NatcashMoncashExchange = typeof natcashMoncashExchanges.$inferSelect;
export type InsertNatcashMoncashExchange = z.infer<typeof insertNatcashMoncashExchangeSchema>;

// ============================================================
// BUYFAST INVESTMENT — variable profit-sharing pool
// Users lock wallet funds for a fixed term and earn a VARIABLE share of a
// profit pool that is fed by a small % of real platform transaction revenue.
// Safety invariant: the pool only ever distributes money it actually collected,
// so the platform can never owe more profit than it has taken in.
// ============================================================
export const investmentSettings = pgTable("investment_settings", {
  id: integer("id").primaryKey().default(1),
  isEnabled: boolean("is_enabled").default(false).notNull(),
  poolPercentage: decimal("pool_percentage", { precision: 5, scale: 2 }).default("0.50").notNull(), // % of platform fee revenue fed into the pool
  minAmount: decimal("min_amount", { precision: 10, scale: 2 }).default("5.00").notNull(), // USD
  maxAmount: decimal("max_amount", { precision: 10, scale: 2 }).default("1000.00").notNull(), // USD per investment
  durationOptions: jsonb("duration_options"), // [{ days, weight }] — longer locks get a bigger share weight
  poolBalance: decimal("pool_balance", { precision: 14, scale: 6 }).default("0").notNull(), // undistributed buffer
  totalContributed: decimal("total_contributed", { precision: 14, scale: 6 }).default("0").notNull(), // lifetime revenue routed to pool
  totalDistributed: decimal("total_distributed", { precision: 14, scale: 6 }).default("0").notNull(), // lifetime profit paid to investors
  lastAccrualAt: timestamp("last_accrual_at").defaultNow(),
  updatedBy: varchar("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertInvestmentSettingsSchema = createInsertSchema(investmentSettings).omit({ updatedAt: true });
export type InvestmentSettings = typeof investmentSettings.$inferSelect;

export const investments = pgTable("investments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  serviceType: varchar("service_type").default("topup").notNull(), // which service pool this investment earns from
  principal: decimal("principal", { precision: 10, scale: 6 }).notNull(), // USD locked
  durationDays: integer("duration_days").notNull(),
  weight: decimal("weight", { precision: 5, scale: 2 }).default("1.00").notNull(), // share weight snapshot at creation
  accruedProfit: decimal("accrued_profit", { precision: 14, scale: 6 }).default("0").notNull(),
  fundingBreakdown: jsonb("funding_breakdown"), // { investorCredits, adminCredits, otherCredits } locked, restored on withdrawal
  status: varchar("status").default("active").notNull(), // active | matured | withdrawn | cancelled
  startDate: timestamp("start_date").defaultNow(),
  maturityDate: timestamp("maturity_date").notNull(),
  withdrawnAt: timestamp("withdrawn_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertInvestmentSchema = createInsertSchema(investments).omit({ id: true, createdAt: true });
export type Investment = typeof investments.$inferSelect;
export type InsertInvestment = z.infer<typeof insertInvestmentSchema>;

// Per-service profit pools — each service has its own pool funded ONLY by that
// service's own revenue, and investors who pick that service share ONLY its pool.
export const investmentServicePools = pgTable("investment_service_pools", {
  serviceType: varchar("service_type").primaryKey(), // 'topup','moncash','natcash','giftcard','billpayment','crypto','cashpick'
  displayName: varchar("display_name").notNull(),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  poolPercentage: decimal("pool_percentage", { precision: 5, scale: 2 }).default("0.50").notNull(), // % of this service's revenue fed into its pool
  poolBalance: decimal("pool_balance", { precision: 14, scale: 6 }).default("0").notNull(), // undistributed buffer for this service
  totalContributed: decimal("total_contributed", { precision: 14, scale: 6 }).default("0").notNull(),
  totalDistributed: decimal("total_distributed", { precision: 14, scale: 6 }).default("0").notNull(),
  lastAccrualAt: timestamp("last_accrual_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertInvestmentServicePoolSchema = createInsertSchema(investmentServicePools).omit({ updatedAt: true });
export type InvestmentServicePool = typeof investmentServicePools.$inferSelect;

// Per-investment daily profit accrual ledger — one row per investment per accrual
// run. Powers the investor's "profit over time" analytics chart on /invest.
export const investmentAccruals = pgTable("investment_accruals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  investmentId: varchar("investment_id").references(() => investments.id).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  serviceType: varchar("service_type").notNull(),
  amount: decimal("amount", { precision: 14, scale: 6 }).notNull(), // profit credited this run (USD)
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_investment_accruals_user_date").on(table.userId, table.createdAt),
]);

export const insertInvestmentAccrualSchema = createInsertSchema(investmentAccruals).omit({ id: true, createdAt: true });
export type InvestmentAccrual = typeof investmentAccruals.$inferSelect;
export type InsertInvestmentAccrual = z.infer<typeof insertInvestmentAccrualSchema>;

// ============================================================
// GAMIFIED REFERRAL MYSTERY BOX SYSTEM
// ============================================================

// Admin-configurable reward pool for mystery boxes
export const mysteryBoxRewardsConfig = pgTable("mystery_box_rewards_config", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  rewardType: varchar("reward_type").notNull(), // 'wallet_bonus','gift_card','moncash','natcash','tshirt','cap'
  nameEn: varchar("name_en").notNull(),
  nameHt: varchar("name_ht").notNull(),
  nameFr: varchar("name_fr").notNull(),
  nameEs: varchar("name_es").notNull(),
  descEn: text("desc_en").default(""),
  descHt: text("desc_ht").default(""),
  descFr: text("desc_fr").default(""),
  descEs: text("desc_es").default(""),
  rewardValue: decimal("reward_value", { precision: 10, scale: 2 }).default("0.00"),
  emoji: varchar("emoji").default("🎁"),
  color: varchar("color").default("#D6F000"),
  probability: integer("probability").default(20), // weight out of total
  isActive: boolean("is_active").default(true),
  maxPerUser: integer("max_per_user").default(0), // 0 = unlimited
  depositRequirement: decimal("deposit_requirement", { precision: 10, scale: 2 }).default("100.00"),
  isPhysical: boolean("is_physical").default(false), // tshirt/cap need manual delivery
  imageUrl: text("image_url"), // product photo for physical items
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertMysteryBoxRewardsConfigSchema = createInsertSchema(mysteryBoxRewardsConfig).omit({ id: true, createdAt: true, updatedAt: true });
export type MysteryBoxRewardConfig = typeof mysteryBoxRewardsConfig.$inferSelect;
export type InsertMysteryBoxRewardConfig = z.infer<typeof insertMysteryBoxRewardsConfigSchema>;

// Groups of 10 referrals — each group unlocks one game
export const referralGameGroups = pgTable("referral_game_groups", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  referrerId: varchar("referrer_id").references(() => users.id).notNull(),
  groupNumber: integer("group_number").notNull(), // 1st group, 2nd group, ...
  referralCount: integer("referral_count").default(0), // current count toward 10
  isUnlocked: boolean("is_unlocked").default(false),
  unlockedAt: timestamp("unlocked_at"),
  sessionId: varchar("session_id"), // set after game is played
  groupBonus: decimal("group_bonus", { precision: 10, scale: 2 }).default("1.00"), // $1 per group bonus
  groupBonusPaid: boolean("group_bonus_paid").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertReferralGameGroupSchema = createInsertSchema(referralGameGroups).omit({ id: true, createdAt: true });
export type ReferralGameGroup = typeof referralGameGroups.$inferSelect;

// Individual mystery box game sessions
export const mysteryBoxSessions = pgTable("mystery_box_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  gameGroupId: varchar("game_group_id").references(() => referralGameGroups.id),
  chosenBox: integer("chosen_box").notNull(), // 0-4 index of chosen box
  boxContents: text("box_contents").notNull(), // JSON: array of 5 reward ids or 'empty'
  rewardConfigId: varchar("reward_config_id").references(() => mysteryBoxRewardsConfig.id),
  rewardType: varchar("reward_type"),
  rewardValue: decimal("reward_value", { precision: 10, scale: 2 }).default("0.00"),
  isEmpty: boolean("is_empty").default(false),
  antiFraudIp: varchar("anti_fraud_ip"),
  antiFraudFingerprint: varchar("anti_fraud_fingerprint"),
  playedAt: timestamp("played_at").defaultNow(),
});

export const insertMysteryBoxSessionSchema = createInsertSchema(mysteryBoxSessions).omit({ id: true, playedAt: true });
export type MysteryBoxSession = typeof mysteryBoxSessions.$inferSelect;

// Locked bonuses — rewards locked until $100 qualifying deposits
export const lockedBonuses = pgTable("locked_bonuses", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  sessionId: varchar("session_id").references(() => mysteryBoxSessions.id),
  rewardType: varchar("reward_type").notNull(),
  nameEn: varchar("name_en").notNull(),
  nameHt: varchar("name_ht").notNull(),
  nameFr: varchar("name_fr").notNull(),
  nameEs: varchar("name_es").notNull(),
  rewardValue: decimal("reward_value", { precision: 10, scale: 2 }).default("0.00"),
  emoji: varchar("emoji").default("🎁"),
  depositRequired: decimal("deposit_required", { precision: 10, scale: 2 }).default("100.00"),
  depositsSoFar: decimal("deposits_so_far", { precision: 10, scale: 2 }).default("0.00"),
  status: varchar("status").default("locked"), // 'locked','unlocked','claimed','expired','pending_delivery'
  whatsappShareCount: integer("whatsapp_share_count").default(0), // number of WhatsApp shares done
  sharesRequired: integer("shares_required").default(10),         // shares needed to confirm
  sharesConfirmed: boolean("shares_confirmed").default(false),    // true when shareCount >= sharesRequired
  isPhysical: boolean("is_physical").default(false),
  imageUrl: text("image_url"),
  unlockedAt: timestamp("unlocked_at"),
  claimedAt: timestamp("claimed_at"),
  expiresAt: timestamp("expires_at"),
  adminNote: text("admin_note"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertLockedBonusSchema = createInsertSchema(lockedBonuses).omit({ id: true, createdAt: true });
export type LockedBonus = typeof lockedBonuses.$inferSelect;
export type InsertLockedBonus = z.infer<typeof insertLockedBonusSchema>;

// Saved Payment Methods — PayPal vaulted cards
export const savedPaymentMethods = pgTable("saved_payment_methods", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  paypalVaultId: varchar("paypal_vault_id").notNull(),
  cardBrand: varchar("card_brand").default("UNKNOWN"), // VISA, MASTERCARD, AMEX, DISCOVER
  lastFour: varchar("last_four").default("****"),
  expiryMonth: varchar("expiry_month"),
  expiryYear: varchar("expiry_year"),
  billingName: varchar("billing_name"),
  isDefault: boolean("is_default").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSavedPaymentMethodSchema = createInsertSchema(savedPaymentMethods).omit({ id: true, createdAt: true });
export type SavedPaymentMethod = typeof savedPaymentMethods.$inferSelect;
export type InsertSavedPaymentMethod = z.infer<typeof insertSavedPaymentMethodSchema>;

// ===========================
// BuyFast Store Orders
// ===========================
export const storeOrders = pgTable("store_orders", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").references(() => users.id),
  paypalOrderId: varchar("paypal_order_id"),
  productId: integer("product_id").notNull(),
  productName: varchar("product_name", { length: 200 }).notNull(),
  size: varchar("size", { length: 20 }),
  color: varchar("color", { length: 50 }),
  quantity: integer("quantity").notNull().default(1),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 }).notNull(),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName: varchar("last_name", { length: 100 }).notNull(),
  email: varchar("email", { length: 200 }).notNull(),
  phone: varchar("phone", { length: 30 }),
  address: text("address").notNull(),
  city: varchar("city", { length: 100 }).notNull(),
  state: varchar("state", { length: 100 }),
  zipCode: varchar("zip_code", { length: 20 }),
  country: varchar("country", { length: 100 }).notNull().default("US"),
  status: varchar("status", { length: 30 }).default("pending"),
  paymentStatus: varchar("payment_status", { length: 30 }).default("pending"),
  trackingNumber: varchar("tracking_number", { length: 100 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertStoreOrderSchema = createInsertSchema(storeOrders).omit({ id: true, createdAt: true, updatedAt: true });
export type StoreOrder = typeof storeOrders.$inferSelect;
export type InsertStoreOrder = z.infer<typeof insertStoreOrderSchema>;

// ===========================
// BuyFast Deposit Center
// ===========================
export const depositRequests = pgTable("deposit_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orderId: varchar("order_id").unique().notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  service: varchar("service").notNull(),
  amountUsd: decimal("amount_usd", { precision: 10, scale: 2 }).notNull(),
  feePercent: decimal("fee_percent", { precision: 5, scale: 2 }).notNull(),
  feeAmount: decimal("fee_amount", { precision: 10, scale: 2 }).notNull(),
  netAmount: decimal("net_amount", { precision: 10, scale: 2 }).notNull(),
  totalCharged: decimal("total_charged", { precision: 10, scale: 2 }),
  paymentMethod: varchar("payment_method").default("wallet"),
  paypalOrderId: varchar("paypal_order_id"),
  recipientName: varchar("recipient_name"),
  recipientContact: varchar("recipient_contact"),
  recipientCurrency: varchar("recipient_currency").default("USD"),
  senderName: varchar("sender_name"),
  senderReference: varchar("sender_reference"),
  userNote: text("user_note"),
  couponCode: varchar("coupon_code"),
  discountAmount: decimal("discount_amount", { precision: 10, scale: 2 }).default("0.00"),
  status: varchar("status").default("pending").notNull(),
  adminNote: text("admin_note"),
  receiptUrl: text("receipt_url"),
  processedBy: varchar("processed_by").references(() => users.id),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  paypalOrderIdUnique: uniqueIndex("deposit_requests_paypal_order_id_unique")
    .on(table.paypalOrderId)
    .where(sql`${table.paypalOrderId} IS NOT NULL`),
}));

export const depositServiceSettings = pgTable("deposit_service_settings", {
  id: serial("id").primaryKey(),
  service: varchar("service").unique().notNull(),
  isEnabled: boolean("is_enabled").default(true),
  feePercent: decimal("fee_percent", { precision: 5, scale: 2 }).default("3.00"),
  paypalFeePercent: decimal("paypal_fee_percent", { precision: 5, scale: 2 }),
  walletFeeTiers: jsonb("wallet_fee_tiers"),
  paypalFeeTiers: jsonb("paypal_fee_tiers"),
  minAmount: decimal("min_amount", { precision: 10, scale: 2 }).default("5.00"),
  maxAmount: decimal("max_amount", { precision: 10, scale: 2 }).default("1000.00"),
  accountInfo: text("account_info"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertDepositRequestSchema = createInsertSchema(depositRequests).omit({ id: true, createdAt: true });
export type DepositRequest = typeof depositRequests.$inferSelect;
export type InsertDepositRequest = z.infer<typeof insertDepositRequestSchema>;

// ── Crypto Purchase Requests ──────────────────────────────────────────────────
export const cryptoPurchaseRequests = pgTable("crypto_purchase_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orderId: varchar("order_id").unique().notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  cryptoSymbol: varchar("crypto_symbol").notNull(),
  cryptoName: varchar("crypto_name").notNull(),
  network: varchar("network").notNull(),
  walletAddress: text("wallet_address").notNull(),
  walletExtraId: text("wallet_extra_id"),
  amountUsd: decimal("amount_usd", { precision: 10, scale: 2 }).notNull(),
  feeAmountUsd: decimal("fee_amount_usd", { precision: 10, scale: 2 }).notNull(),
  totalUsd: decimal("total_usd", { precision: 10, scale: 2 }).notNull(),
  status: varchar("status").default("pending").notNull(),
  paymentMethod: varchar("payment_method").default("wallet").notNull(),
  paypalOrderId: varchar("paypal_order_id"),
  adminNote: text("admin_note"),
  // ── ChangeNOW automation fields ──
  changenowId: varchar("changenow_id"),
  changenowStatus: varchar("changenow_status"),
  payinAddress: text("payin_address"),
  payinTxId: varchar("payin_tx_id"),
  payoutAmount: varchar("payout_amount"),
  autoAttempted: boolean("auto_attempted").default(false),
  processedBy: varchar("processed_by").references(() => users.id),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  // One PayPal capture may fund exactly ONE crypto purchase (anti-replay).
  paypalOrderIdUnique: uniqueIndex("crypto_purchase_paypal_order_id_unique")
    .on(table.paypalOrderId)
    .where(sql`${table.paypalOrderId} IS NOT NULL`),
}));

export const insertCryptoPurchaseSchema = createInsertSchema(cryptoPurchaseRequests).omit({ id: true, createdAt: true });
export type CryptoPurchaseRequest = typeof cryptoPurchaseRequests.$inferSelect;
export type InsertCryptoPurchaseRequest = z.infer<typeof insertCryptoPurchaseSchema>;

export const insertDepositServiceSettingSchema = createInsertSchema(depositServiceSettings).omit({ id: true });
export type DepositServiceSetting = typeof depositServiceSettings.$inferSelect;
export type InsertDepositServiceSetting = z.infer<typeof insertDepositServiceSettingSchema>;

// ── OFAC Geoblocked Attempts Log ──────────────────────────────────────────────
export const geoblockedAttempts = pgTable("geoblocked_attempts", {
  id: serial("id").primaryKey(),
  ipAddress: varchar("ip_address").notNull(),
  countryCode: varchar("country_code", { length: 4 }).notNull(),
  countryName: varchar("country_name").notNull(),
  requestPath: text("request_path").notNull(),
  userId: varchar("user_id").references(() => users.id),
  blockedAt: timestamp("blocked_at").defaultNow(),
});

export type GeoblockedAttempt = typeof geoblockedAttempts.$inferSelect;

// ── Fraud Radar: device → account links (one account per device enforcement) ──
export const deviceAccountLinks = pgTable("device_account_links", {
  id: serial("id").primaryKey(),
  fingerprint: varchar("fingerprint").notNull(),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ipAddress: varchar("ip_address"),
  signupContext: varchar("signup_context"), // 'register' | 'google'
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertDeviceAccountLinkSchema = createInsertSchema(deviceAccountLinks).omit({ id: true, createdAt: true });
export type DeviceAccountLink = typeof deviceAccountLinks.$inferSelect;
export type InsertDeviceAccountLink = z.infer<typeof insertDeviceAccountLinkSchema>;

// ── Fraud Radar: persisted suspect flags ──────────────────────────────────────
export const fraudRadarFlags = pgTable("fraud_radar_flags", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  riskLevel: varchar("risk_level").notNull().default("low"), // low | medium | high | critical
  riskScore: integer("risk_score").notNull().default(0),
  reasons: jsonb("reasons").$type<string[]>().default([]),
  signals: jsonb("signals").$type<Record<string, any>>().default({}),
  autoBlocked: boolean("auto_blocked").notNull().default(false),
  status: varchar("status").notNull().default("open"), // open | confirmed | cleared
  reviewedBy: varchar("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertFraudRadarFlagSchema = createInsertSchema(fraudRadarFlags).omit({ id: true, createdAt: true, updatedAt: true });
export type FraudRadarFlag = typeof fraudRadarFlags.$inferSelect;
export type InsertFraudRadarFlag = z.infer<typeof insertFraudRadarFlagSchema>;

// Unified exchange is isolated from wallet purchases and manual admin payouts.
export const exchangeQuotes = pgTable("exchange_quotes", {
  id: uuid("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  purpose: text("purpose").notNull().default("user_funded_swap"),
  data: jsonb("data").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const exchangeOrders = pgTable("exchange_orders", {
  id: uuid("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  quoteId: uuid("quote_id").notNull().references(() => exchangeQuotes.id),
  idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
  purpose: text("purpose").notNull().default("user_funded_swap"),
  status: text("status").notNull(),
  providerId: varchar("provider_id", { length: 128 }),
  data: jsonb("data").notNull(),
  version: integer("version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
  uniqueIndex("exchange_order_user_idempotency").on(table.userId, table.idempotencyKey),
  uniqueIndex("exchange_order_quote_once").on(table.quoteId),
  uniqueIndex("exchange_order_provider_once").on(table.providerId),
]);
export const exchangeOrderEvents = pgTable("exchange_order_events", {
  id: uuid("id").primaryKey(),
  orderId: uuid("order_id").notNull().references(() => exchangeOrders.id),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Deliberately isolated from walletBalances/transactions: virtual funds only.
export const alpacaDemoAccounts = pgTable("alpaca_demo_accounts", {
  userId: varchar("user_id").primaryKey().references(() => users.id),
  syntheticEmail: text("synthetic_email").notNull().unique(),
  accountId: uuid("account_id").unique(),
  provisioningStatus: text("provisioning_status").notNull().default("new"),
  fundingStatus: text("funding_status").notNull().default("new"),
  consentAt: timestamp("consent_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const alpacaDemoOrderRequests = pgTable("alpaca_demo_order_requests", {
  userId: varchar("user_id").notNull().references(() => users.id),
  requestId: uuid("request_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  clientOrderId: text("client_order_id").notNull().unique(),
  attempted: boolean("attempted").notNull().default(false),
}, table => [primaryKey({ columns: [table.userId, table.requestId] })]);

export const tradingSandboxAccounts = pgTable("trading_sandbox_accounts", {
  userId: varchar("user_id").primaryKey().references(() => users.id),
  state: jsonb("state").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export const tradingSandboxEvents = pgTable("trading_sandbox_events", {
  userId: varchar("user_id").notNull().references(() => tradingSandboxAccounts.userId),
  requestId: uuid("request_id").notNull(),
  request: jsonb("request").notNull(),
  response: jsonb("response").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [primaryKey({ columns: [table.userId, table.requestId] })]);
