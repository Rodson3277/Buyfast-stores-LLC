/**
 * 🛡️ IP BLACKLIST SYSTEM
 * Blocks IPs that violate fraud detection rules.
 * Blocked IPs cannot: create accounts, send guest topups, or access the app.
 */

interface BlacklistEntry {
  ip: string;
  reason: string;
  blockedAt: number;
  expiresAt: number;
}

const ipBlacklist = new Map<string, BlacklistEntry>();

const BLACKLIST_DURATION_MS = 24 * 60 * 60 * 1000;

function cleanupExpired(): void {
  const now = Date.now();
  const toDelete: string[] = [];
  ipBlacklist.forEach((entry, ip) => {
    if (now > entry.expiresAt) {
      toDelete.push(ip);
    }
  });
  toDelete.forEach(ip => ipBlacklist.delete(ip));
}

export function blacklistIP(ip: string, reason: string, durationMs?: number): void {
  const duration = durationMs || BLACKLIST_DURATION_MS;
  const now = Date.now();
  ipBlacklist.set(ip, {
    ip,
    reason,
    blockedAt: now,
    expiresAt: now + duration
  });
  console.log(`🚫 IP BLACKLISTED: ${ip} - Reason: ${reason} - Duration: ${Math.round(duration / 3600000)}h`);
}

export function isIPBlacklisted(ip: string): { blocked: boolean; reason?: string; remainingSeconds?: number } {
  cleanupExpired();

  const entry = ipBlacklist.get(ip);
  if (!entry) {
    return { blocked: false };
  }

  const now = Date.now();
  if (now > entry.expiresAt) {
    ipBlacklist.delete(ip);
    return { blocked: false };
  }

  const remainingMs = entry.expiresAt - now;
  return {
    blocked: true,
    reason: entry.reason,
    remainingSeconds: Math.ceil(remainingMs / 1000)
  };
}

export function removeFromBlacklist(ip: string): boolean {
  return ipBlacklist.delete(ip);
}

export function getBlacklistSize(): number {
  cleanupExpired();
  return ipBlacklist.size;
}

setInterval(cleanupExpired, 30 * 60 * 1000);

console.log('🛡️ IP BLACKLIST: System initialized (24h block for fraud violators)');
