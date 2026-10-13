import type { Request, Response, NextFunction } from "express";
import { db } from "../db";
import { sql } from "drizzle-orm";

// ─── OFAC Sanctioned Country Codes ───────────────────────────────────────────
// Comprehensive US sanctions (full embargo) + significant secondary sanctions
export const OFAC_SANCTIONED_COUNTRIES: Record<string, string> = {
  CU: "Cuba",
  IR: "Iran",
  KP: "North Korea",
  SY: "Syria",
  RU: "Russia",
  BY: "Belarus",
  MM: "Myanmar (Burma)",
  VE: "Venezuela",
  SD: "Sudan",
  SS: "South Sudan",
  LY: "Libya",
  SO: "Somalia",
  ZW: "Zimbabwe",
  CF: "Central African Republic",
  CD: "Democratic Republic of Congo",
  BI: "Burundi",
  YE: "Yemen",
  AF: "Afghanistan",
  IQ: "Iraq",
  ML: "Mali",
  NI: "Nicaragua",
  ET: "Ethiopia",
};

// ─── Regulatory-restricted countries (NOT OFAC — business/compliance decision) ─
// Owner decision (Aug 2026): block high-fraud markets the app does not serve.
// Russia is already covered by the OFAC list above.
export const RESTRICTED_COUNTRIES: Record<string, string> = {
  IN: "India",
  NG: "Nigeria",
  PH: "Philippines",
  ID: "Indonesia",
  CN: "China",
};

// Countries allowed regardless of any list (app's primary markets).
const ALWAYS_ALLOWED: string[] = ["HT", "US", "CA", "FR", "MX", "BR", "DO", "JM", "TT"];

// ─── In-memory IP→country cache (TTL: 1 hour) ────────────────────────────────
const ipCache = new Map<string, { countryCode: string; country: string; isVpn: boolean; cachedAt: number }>();
const IP_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─── Geoblocking enabled flag (read from DB setting) ─────────────────────────
let geoblockingEnabled = true;
let lastSettingCheck = 0;
const SETTING_CHECK_INTERVAL_MS = 5 * 60 * 1000; // re-check every 5 min

export async function isGeoblockingEnabled(): Promise<boolean> {
  const now = Date.now();
  if (now - lastSettingCheck < SETTING_CHECK_INTERVAL_MS) return geoblockingEnabled;
  try {
    const result = await db.execute(
      sql`SELECT value FROM app_settings WHERE key = 'geoblocking_enabled' LIMIT 1`
    );
    const rows = result.rows as any[];
    if (rows.length > 0) {
      geoblockingEnabled = rows[0].value !== "false";
    }
    lastSettingCheck = now;
  } catch {
    // table may not exist yet — default to enabled
  }
  return geoblockingEnabled;
}

// ─── Extract real client IP ───────────────────────────────────────────────────
export function getClientIp(req: Request): string {
  const cf = req.get("CF-Connecting-IP");
  const realIp = req.get("X-Real-IP");
  const forwarded = req.get("X-Forwarded-For");
  if (cf) return cf;
  if (realIp) return realIp;
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.ip || (req as any).connection?.remoteAddress || "127.0.0.1";
}

// ─── IP → country lookup (ip-api.com, free, 1000 req/hr) ─────────────────────
async function getCountryCode(ip: string): Promise<{ countryCode: string; country: string; isVpn: boolean }> {
  // Private/local IPs — always allow
  if (
    ip === "127.0.0.1" ||
    ip.startsWith("::1") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("10.") ||
    ip.startsWith("172.")
  ) {
    return { countryCode: "LOCAL", country: "Local Network", isVpn: false };
  }

  // Cache hit
  const cached = ipCache.get(ip);
  if (cached && Date.now() - cached.cachedAt < IP_CACHE_TTL_MS) {
    return { countryCode: cached.countryCode, country: cached.country, isVpn: cached.isVpn };
  }

  try {
    const response = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,countryCode,country,proxy,hosting`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (!response.ok) throw new Error(`ip-api ${response.status}`);
    const data: any = await response.json();
    if (data.status === "success") {
      // proxy = known VPN/proxy/Tor exit; hosting = datacenter IP (where VPN
      // servers live). A real customer on home/mobile internet is neither.
      const isVpn = data.proxy === true || data.hosting === true;
      const entry = { countryCode: data.countryCode, country: data.country, isVpn, cachedAt: Date.now() };
      ipCache.set(ip, entry);
      return { countryCode: data.countryCode, country: data.country, isVpn };
    }
  } catch {
    // Fail open — don't block if lookup fails
  }
  return { countryCode: "UNKNOWN", country: "Unknown", isVpn: false };
}

// ─── Log blocked attempt to DB ────────────────────────────────────────────────
async function logBlockedAttempt(
  ip: string,
  countryCode: string,
  country: string,
  path: string,
  userId?: string
) {
  try {
    await db.execute(sql`
      INSERT INTO geoblocked_attempts (ip_address, country_code, country_name, request_path, user_id, blocked_at)
      VALUES (${ip}, ${countryCode}, ${country}, ${path}, ${userId || null}, NOW())
    `);
  } catch {
    // Non-critical — table may not be created yet
  }
}

// ─── Paths EXCLUDED from geoblocking ─────────────────────────────────────────
// NOTE: middleware is mounted on app.use('/api', ...) so req.path is already
// stripped of the '/api' prefix (e.g. '/admin/transactions', not '/api/admin/...')
// We use req.originalUrl for consistent matching with the full path.
const EXCLUDED_PATHS = [
  "/api/health",
  "/api/auth/",
  "/api/admin/",
  "/api/firebase-proxy/",
  "/api/store/printify/",
  "/api/referral-info",
  "/api/geoblocking",
  "/api/geo-status",
  "/health",
  // Server-to-server webhooks: these come from provider datacenters (PayPal,
  // NOWPayments, Twilio, Didit), which ALWAYS look like hosting/VPN IPs and
  // often foreign countries. They verify themselves cryptographically
  // (signatures/webhook IDs) — geoblocking them breaks payment notifications.
  "/api/paypal/webhook",
  "/api/crypto/webhook",
  "/api/sms/webhook",
  "/api/didit/webhook",
];

function isExcluded(originalUrl: string): boolean {
  return EXCLUDED_PATHS.some((prefix) => originalUrl.startsWith(prefix));
}

// ─── Main middleware ──────────────────────────────────────────────────────────
export async function geoblockingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    // Use originalUrl (includes '/api' prefix) for correct path matching
    if (isExcluded(req.originalUrl)) return next();

    // Skip if geoblocking disabled
    const enabled = await isGeoblockingEnabled();
    if (!enabled) return next();

    const ip = getClientIp(req);
    const { countryCode, country, isVpn } = await getCountryCode(ip);

    // 🚫 VPN/proxy/datacenter IPs are blocked OUTRIGHT (owner decision, Aug 2026),
    // even when the exit country is allowed — otherwise a VPN trivially bypasses
    // the country block. Checked BEFORE the country allow-list on purpose.
    if (isVpn && countryCode !== "LOCAL") {
      const userId = (req as any).verifiedUser?.uid || (req as any).user?.id;
      console.warn(`🚫 VPN BLOCK: ${ip} (${country} / ${countryCode}, proxy/hosting) → ${req.path}`);
      await logBlockedAttempt(ip, `VPN-${countryCode}`, `VPN/Proxy (${country})`, req.path, userId);
      return res.status(403).json({
        error: "Access denied",
        code: "VPN_BLOCKED",
        message: "This service is not available over VPN or proxy connections. Please disable your VPN and try again.",
      });
    }

    // Always-allowed countries
    if (ALWAYS_ALLOWED.includes(countryCode)) return next();

    // Unknown / local — allow
    if (countryCode === "UNKNOWN" || countryCode === "LOCAL") return next();

    // OFAC sanctioned OR regulatory-restricted country → block
    const isOfac = !!OFAC_SANCTIONED_COUNTRIES[countryCode];
    const isRestricted = !!RESTRICTED_COUNTRIES[countryCode];
    if (isOfac || isRestricted) {
      const userId = (req as any).verifiedUser?.uid || (req as any).user?.id;
      console.warn(
        `🚫 GEOBLOCKING: Blocked ${ip} (${country} / ${countryCode}) → ${req.path}`
      );
      await logBlockedAttempt(ip, countryCode, country, req.path, userId);
      return res.status(403).json({
        error: "Access denied",
        code: isOfac ? "OFAC_RESTRICTED" : "REGION_RESTRICTED",
        message:
          "This service is not available in your region due to regulatory requirements.",
      });
    }

    next();
  } catch {
    // Fail open — never block legit users due to middleware error
    next();
  }
}

// ─── Public geo status (used by /api/geo-status + frontend region gate) ───────
// FAIL-OPEN: any uncertainty → not blocked, so legit users are never locked out.
export async function getGeoStatusForReq(
  req: Request
): Promise<{ blocked: boolean; countryCode: string; country: string; code: string | null }> {
  try {
    const enabled = await isGeoblockingEnabled();
    const ip = getClientIp(req);
    const { countryCode, country, isVpn } = await getCountryCode(ip);

    if (!enabled) return { blocked: false, countryCode, country, code: null };
    if (isVpn && countryCode !== "LOCAL") {
      return { blocked: true, countryCode, country, code: "VPN_BLOCKED" };
    }
    if (ALWAYS_ALLOWED.includes(countryCode)) return { blocked: false, countryCode, country, code: null };
    if (countryCode === "UNKNOWN" || countryCode === "LOCAL") return { blocked: false, countryCode, country, code: null };

    if (OFAC_SANCTIONED_COUNTRIES[countryCode]) {
      return { blocked: true, countryCode, country, code: "OFAC_RESTRICTED" };
    }
    if (RESTRICTED_COUNTRIES[countryCode]) {
      return { blocked: true, countryCode, country, code: "REGION_RESTRICTED" };
    }
    return { blocked: false, countryCode, country, code: null };
  } catch {
    return { blocked: false, countryCode: "UNKNOWN", country: "Unknown", code: null };
  }
}
