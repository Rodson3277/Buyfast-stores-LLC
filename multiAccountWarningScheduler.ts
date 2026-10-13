import * as cron from 'node-cron';
import { db } from '../db';
import { users, userActiveSessions } from '@shared/schema';
import { sql, eq, and, isNotNull, isNull } from 'drizzle-orm';
import { storage } from '../storage';
import { sendAccountBlockedEmail, sendEmail } from '../email.js';

const SYSTEM_BLOCKER_ID = 'restored_admin_rodson';

const EXEMPT_EMAILS = ['rodsondeneus9@gmail.com', 'support@buyfasttopup.com'];

const BLOCK_REASON_BY_LANG: Record<string, string> = {
  en: 'Multiple accounts detected on the same device. Automated security policy blocked all linked accounts immediately.',
  ht: 'Plizyè kont detekte sou menm aparèy la. Politik sekirite otomatik bloke tout kont ki lye yo imedyatman.',
  fr: "Plusieurs comptes détectés sur le même appareil. La politique de sécurité automatique a bloqué immédiatement tous les comptes liés.",
  es: 'Varias cuentas detectadas en el mismo dispositivo. La política de seguridad automática bloqueó inmediatamente todas las cuentas vinculadas.',
};

const SAME_NAME_BLOCK_REASON = 'Multiple accounts detected with the same name. Automated security policy blocked all accounts sharing this identity.';

/**
 * Helper: block a list of user IDs immediately with email notification.
 */
async function blockUsers(userIds: string[], reason: string): Promise<number> {
  let blocked = 0;
  for (const userId of userIds) {
    try {
      const userData = await storage.getUser(userId);
      if (!userData) continue;
      if (userData.isBlocked) continue;
      if (EXEMPT_EMAILS.includes((userData.email || '').toLowerCase())) continue;
      if ((userData as any).isOwner) continue;
      // Never auto-block privileged accounts (defense-in-depth, regardless of detector query filters)
      if ((userData as any).isAdmin || (userData as any).isSuperAdmin) continue;

      await storage.blockUser(userId, reason, SYSTEM_BLOCKER_ID);
      blocked++;
      console.log(`🚫 [AutoBlock] Blocked ${userData.email} — reason: ${reason}`);

      try {
        const lang = ((userData as any).language || 'en') as 'en' | 'fr' | 'es' | 'ht';
        await sendAccountBlockedEmail(userData.email!, userData.firstName || 'User', lang);
      } catch (emailErr) {
        console.warn(`⚠️ Could not send blocked email for ${userData.email}:`, (emailErr as any).message);
      }
    } catch (err) {
      console.error(`❌ Failed to block user ${userId}:`, err);
    }
  }
  return blocked;
}

/**
 * Step 1 — Detect accounts sharing the same device fingerprint via user_active_sessions.
 *
 * SMART POLICY (reduced false positives):
 *  - If AT LEAST ONE account in the group is < 30 days old → block all (new fraud pattern)
 *  - If ALL accounts are >= 30 days old → alert admin only (likely family/shared device)
 */
async function detectAndBlockSharedSessionAccounts(): Promise<void> {
  try {
    const sharedDevices = await db.execute(sql`
      SELECT
        uas.device_fingerprint,
        array_agg(DISTINCT uas.user_id) AS user_ids,
        MIN(u.created_at) AS oldest_account,
        MAX(u.created_at) AS newest_account
      FROM user_active_sessions uas
      JOIN users u ON uas.user_id = u.id
      WHERE uas.device_fingerprint IS NOT NULL
        AND uas.device_fingerprint != ''
        AND u.is_blocked = false
        AND u.is_active = true
        AND u.email NOT IN ('rodsondeneus9@gmail.com', 'support@buyfasttopup.com')
        AND COALESCE(u.is_owner, false) = false
      GROUP BY uas.device_fingerprint
      HAVING COUNT(DISTINCT uas.user_id) >= 2
    `);

    if (sharedDevices.rows.length === 0) return;

    let totalBlocked = 0;
    let totalAlerted = 0;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    for (const row of sharedDevices.rows as any[]) {
      const userIds: string[] = Array.isArray(row.user_ids)
        ? row.user_ids
        : JSON.parse(row.user_ids);

      const newestAccount = row.newest_account ? new Date(row.newest_account) : null;
      const hasNewAccount = newestAccount && newestAccount > thirtyDaysAgo;

      if (hasNewAccount) {
        // At least one NEW account → auto-block (active fraud pattern)
        const reason = BLOCK_REASON_BY_LANG['en'];
        const count = await blockUsers(userIds, reason);
        totalBlocked += count;
        if (count > 0) {
          console.log(`🚫 [AutoBlock] Device ${row.device_fingerprint.substring(0, 8)}... — blocked ${count} accounts (new account detected)`);
        }
      } else {
        // All accounts are established (> 30 days) → alert admin only, no auto-block
        try {
          const userDetails = await Promise.all(
            userIds.map(uid => storage.getUser(uid))
          );
          const accountList = userDetails
            .filter(Boolean)
            .map(u => `• ${(u as any).firstName || ''} ${(u as any).lastName || ''} &lt;${(u as any).email}&gt; (joined ${new Date((u as any).createdAt || 0).toDateString()}, balance $${parseFloat((u as any).balance || '0').toFixed(2)})`)
            .join('<br>');

          await sendEmail({
            to: 'rodsondeneus9@gmail.com',
            subject: '⚠️ Admin Review Needed: Shared Device Detected (No Auto-Block)',
            htmlContent: `
              <h2>⚠️ Shared Device Alert — Admin Review Required</h2>
              <p>The following <strong>${userIds.length} established accounts</strong> (all &gt; 30 days old) share the same device fingerprint. 
              They were <strong>NOT auto-blocked</strong> because all accounts are established. Please review and manually block if suspicious.</p>
              <p><strong>Device fingerprint:</strong> ${row.device_fingerprint.substring(0, 16)}...</p>
              <p><strong>Accounts sharing this device:</strong><br>${accountList}</p>
              <p>If these are family members sharing a device, no action needed. If fraud is suspected, block them manually from the admin panel.</p>
            `
          });
          totalAlerted++;
          console.log(`⚠️ [AutoBlock] Device ${row.device_fingerprint.substring(0, 8)}... — all accounts established, admin alerted (no auto-block)`);
        } catch (emailErr) {
          console.warn('⚠️ [AutoBlock] Could not send admin alert email:', emailErr);
        }
      }
    }

    if (totalBlocked > 0) {
      console.log(`🚫 [AutoBlock] Shared-session scan: ${totalBlocked} account(s) blocked, ${totalAlerted} group(s) flagged for admin review`);
    }
  } catch (err) {
    console.error('❌ [AutoBlock] Shared-session scan error:', err);
  }
}

/**
 * Step 2 — Detect accounts confirmed on the same device via multi_device_events forced_logout.
 * A forced_logout means user B logged into the SAME physical device while user A was logged in.
 * Both users are CONFIRMED same-device → block immediately.
 */
async function detectAndBlockForcedLogoutPairs(): Promise<void> {
  try {
    // Find ALL unprocessed forced_logout events (not yet flagged)
    // We join sessions to find the new user who caused the logout
    const pairs = await db.execute(sql`
      SELECT DISTINCT
        mde.user_id AS kicked_user_id,
        sess.sess::json->>'userId' AS new_user_id
      FROM multi_device_events mde
      CROSS JOIN LATERAL (
        SELECT sess
        FROM sessions s
        WHERE s.sess::text ILIKE '%' || (mde.metadata::json->>'newSessionId') || '%'
        LIMIT 1
      ) sess
      WHERE mde.event_type = 'forced_logout'
        AND mde.metadata IS NOT NULL
        AND mde.metadata::json->>'newSessionId' IS NOT NULL
        AND mde.created_at > NOW() - INTERVAL '48 hours'
    `);

    if (pairs.rows.length === 0) {
      // Fallback: just block everyone with a recent forced_logout event (the kicked user)
      await detectAndBlockRecentForcedLogoutVictims();
      return;
    }

    let totalBlocked = 0;

    for (const row of pairs.rows as any[]) {
      const userIds = [row.kicked_user_id, row.new_user_id].filter(Boolean);
      if (userIds.length === 0) continue;

      const reason = BLOCK_REASON_BY_LANG['en'];
      const count = await blockUsers(userIds, reason);
      totalBlocked += count;
    }

    if (totalBlocked > 0) {
      console.log(`🚫 [AutoBlock] Forced-logout pairs: ${totalBlocked} account(s) blocked immediately`);
    }

    // Also run victim-only fallback for any events the join missed
    await detectAndBlockRecentForcedLogoutVictims();
  } catch (err) {
    console.error('❌ [AutoBlock] Forced-logout pairs scan error:', err);
    // Always run victim fallback
    await detectAndBlockRecentForcedLogoutVictims();
  }
}

/**
 * Fallback: block the victim of a forced_logout if the pair-join failed.
 * The kicked user is CONFIRMED to have shared a device with someone → block them.
 * We also find the other user by matching device_id in user_active_sessions.
 */
async function detectAndBlockRecentForcedLogoutVictims(): Promise<void> {
  try {
    const victims = await db.execute(sql`
      SELECT DISTINCT
        mde.user_id AS victim_id,
        mde.new_device_id,
        mde.new_ip_address,
        mde.created_at
      FROM multi_device_events mde
      JOIN users u ON mde.user_id = u.id
      WHERE mde.event_type = 'forced_logout'
        AND u.is_blocked = false
        AND u.is_active = true
        AND u.email NOT IN ('rodsondeneus9@gmail.com', 'support@buyfasttopup.com')
        AND COALESCE(u.is_owner, false) = false
        AND mde.created_at > NOW() - INTERVAL '48 hours'
    `);

    if (victims.rows.length === 0) return;

    let totalBlocked = 0;

    for (const row of victims.rows as any[]) {
      // Try to find the other user who took over the device
      const companions: string[] = [];

      if (row.new_device_id && row.new_device_id !== 'unknown') {
        const found = await db.execute(sql`
          SELECT DISTINCT uas.user_id
          FROM user_active_sessions uas
          JOIN users u ON uas.user_id = u.id
          WHERE uas.device_id = ${row.new_device_id}
            AND uas.user_id != ${row.victim_id}
            AND u.is_blocked = false
            AND u.email NOT IN ('rodsondeneus9@gmail.com', 'support@buyfasttopup.com')
            AND COALESCE(u.is_owner, false) = false
        `);
        for (const r of found.rows as any[]) {
          companions.push(r.user_id);
        }
      }

      // Also search by new_ip_address within a short time window (same device, different session)
      if (row.new_ip_address && row.new_ip_address !== 'unknown') {
        const foundByIp = await db.execute(sql`
          SELECT DISTINCT uas.user_id
          FROM user_active_sessions uas
          JOIN users u ON uas.user_id = u.id
          WHERE uas.ip_address = ${row.new_ip_address}
            AND uas.user_id != ${row.victim_id}
            AND u.is_blocked = false
            AND u.email NOT IN ('rodsondeneus9@gmail.com', 'support@buyfasttopup.com')
            AND COALESCE(u.is_owner, false) = false
            AND uas.last_seen_at BETWEEN ${row.created_at}::timestamp - INTERVAL '10 minutes'
                                      AND ${row.created_at}::timestamp + INTERVAL '10 minutes'
        `);
        for (const r of foundByIp.rows as any[]) {
          if (!companions.includes(r.user_id)) companions.push(r.user_id);
        }
      }

      // Only block if we found a real companion — if nobody else is on this device,
      // the forced_logout was just a self-re-login (e.g. page refresh / Google auth proxy).
      // Blocking the victim with zero companions is a false positive.
      if (companions.length === 0) {
        console.log(`⏭️ [AutoBlock] Skipping forced-logout victim ${row.victim_id} — no companion found on same device (likely self re-login)`);
        continue;
      }

      const allIds = [row.victim_id, ...companions];
      const reason = BLOCK_REASON_BY_LANG['en'];
      const count = await blockUsers(allIds, reason);
      totalBlocked += count;
    }

    if (totalBlocked > 0) {
      console.log(`🚫 [AutoBlock] Forced-logout victims: ${totalBlocked} account(s) blocked`);
    }
  } catch (err) {
    console.error('❌ [AutoBlock] Forced-logout victims scan error:', err);
  }
}

/**
 * Step 3 — Detect rapid same-device registrations.
 * If 2+ accounts were created within 5 minutes from the same browser fingerprint
 * (device_fingerprints table), block them all immediately.
 */
async function detectAndBlockRapidRegistrations(): Promise<void> {
  try {
    const rapidGroups = await db.execute(sql`
      SELECT
        df.fingerprint,
        array_agg(DISTINCT df.user_id ORDER BY df.user_id) AS user_ids,
        MIN(df.created_at) AS first_created,
        MAX(df.created_at) AS last_created
      FROM device_fingerprints df
      JOIN users u ON df.user_id = u.id
      WHERE u.is_blocked = false
        AND u.is_active = true
        AND u.email NOT IN ('rodsondeneus9@gmail.com', 'support@buyfasttopup.com')
        AND COALESCE(u.is_owner, false) = false
        AND df.user_id IS NOT NULL
      GROUP BY df.fingerprint
      HAVING COUNT(DISTINCT df.user_id) >= 2
         AND EXTRACT(EPOCH FROM (MAX(df.created_at) - MIN(df.created_at))) <= 600
    `);

    if (rapidGroups.rows.length === 0) return;

    let totalBlocked = 0;

    for (const row of rapidGroups.rows as any[]) {
      const userIds: string[] = Array.isArray(row.user_ids)
        ? row.user_ids
        : JSON.parse(row.user_ids);

      const reason = BLOCK_REASON_BY_LANG['en'];
      const count = await blockUsers(userIds, reason);
      totalBlocked += count;

      if (count > 0) {
        console.log(`🚫 [AutoBlock] Rapid registration on fingerprint ${row.fingerprint?.substring(0, 8)}... — ${count} accounts blocked`);
      }
    }

    if (totalBlocked > 0) {
      console.log(`🚫 [AutoBlock] Rapid-registration scan: ${totalBlocked} account(s) blocked`);
    }
  } catch (err) {
    console.error('❌ [AutoBlock] Rapid-registration scan error:', err);
  }
}

/**
 * Step 4 — Detect same-IP rapid registrations (2+ accounts within 5 min from the same IP).
 * Covers cases where device fingerprinting is bypassed (e.g. cleared cookies).
 */
async function detectAndBlockSameIpRegistrations(): Promise<void> {
  try {
    const ipGroups = await db.execute(sql`
      SELECT
        df.last_ip_address AS ip,
        array_agg(DISTINCT df.user_id ORDER BY df.user_id) AS user_ids,
        MIN(df.created_at) AS first_created,
        MAX(df.created_at) AS last_created
      FROM device_fingerprints df
      JOIN users u ON df.user_id = u.id
      WHERE u.is_blocked = false
        AND u.is_active = true
        AND df.last_ip_address IS NOT NULL
        AND df.last_ip_address NOT IN ('127.0.0.1', 'unknown')
        AND u.email NOT IN ('rodsondeneus9@gmail.com', 'support@buyfasttopup.com')
        AND COALESCE(u.is_owner, false) = false
        AND df.user_id IS NOT NULL
        AND df.created_at > NOW() - INTERVAL '24 hours'
      GROUP BY df.last_ip_address
      HAVING COUNT(DISTINCT df.user_id) >= 2
         AND EXTRACT(EPOCH FROM (MAX(df.created_at) - MIN(df.created_at))) <= 300
    `);

    if (ipGroups.rows.length === 0) return;

    let totalBlocked = 0;

    for (const row of ipGroups.rows as any[]) {
      const ip: string = row.ip;

      // Skip Google infrastructure IPs (35.191.x.x, 34.x.x.x, 130.211.x.x) — these are proxies
      if (
        ip.startsWith('35.191.') ||
        ip.startsWith('34.') ||
        ip.startsWith('130.211.') ||
        ip.startsWith('35.235.')
      ) {
        continue;
      }

      const userIds: string[] = Array.isArray(row.user_ids)
        ? row.user_ids
        : JSON.parse(row.user_ids);

      const reason = `Multiple accounts registered from the same IP address (${ip}) within 5 minutes.`;
      const count = await blockUsers(userIds, reason);
      totalBlocked += count;

      if (count > 0) {
        console.log(`🚫 [AutoBlock] Same-IP rapid registration (${ip}) — ${count} accounts blocked`);
      }
    }

    if (totalBlocked > 0) {
      console.log(`🚫 [AutoBlock] Same-IP scan: ${totalBlocked} account(s) blocked`);
    }
  } catch (err) {
    console.error('❌ [AutoBlock] Same-IP scan error:', err);
  }
}

/**
 * Step 5 — Detect accounts that share the SAME full name (first + last).
 * Per owner policy, multiple accounts using the same legal identity are treated
 * as duplicate/fraudulent and ALL non-exempt accounts in the group are blocked.
 *
 * Safety guards to limit false positives:
 *  - Requires BOTH first_name AND last_name to be non-empty (skips placeholder
 *    accounts that only have an email-derived first name).
 *  - Skips owner, exempt support emails, admins and super-admins.
 */
async function detectAndBlockSameNameAccounts(): Promise<void> {
  try {
    const nameGroups = await db.execute(sql`
      SELECT
        LOWER(TRIM(first_name)) AS fn,
        LOWER(TRIM(last_name)) AS ln,
        array_agg(DISTINCT id) AS user_ids,
        COUNT(DISTINCT id) AS cnt
      FROM users
      WHERE is_blocked = false
        AND is_active = true
        AND email NOT IN ('rodsondeneus9@gmail.com', 'support@buyfasttopup.com')
        AND COALESCE(is_owner, false) = false
        AND COALESCE(is_admin, false) = false
        AND COALESCE(is_super_admin, false) = false
        AND first_name IS NOT NULL AND TRIM(first_name) != ''
        AND last_name IS NOT NULL AND TRIM(last_name) != ''
      GROUP BY LOWER(TRIM(first_name)), LOWER(TRIM(last_name))
      HAVING COUNT(DISTINCT id) >= 2
    `);

    if (nameGroups.rows.length === 0) return;

    let totalBlocked = 0;

    for (const row of nameGroups.rows as any[]) {
      const userIds: string[] = Array.isArray(row.user_ids)
        ? row.user_ids
        : JSON.parse(row.user_ids);

      const count = await blockUsers(userIds, SAME_NAME_BLOCK_REASON);
      totalBlocked += count;

      if (count > 0) {
        console.log(`🚫 [AutoBlock] Same name "${row.fn} ${row.ln}" — ${count} account(s) blocked`);
      }
    }

    if (totalBlocked > 0) {
      console.log(`🚫 [AutoBlock] Same-name scan: ${totalBlocked} account(s) blocked`);
    }
  } catch (err) {
    console.error('❌ [AutoBlock] Same-name scan error:', err);
  }
}

/**
 * Run all detection steps in sequence.
 */
async function runAllDetections(): Promise<void> {
  console.log('🔍 [AutoBlock] Running same-device / same-name multi-account scan...');
  await detectAndBlockSharedSessionAccounts();
  await detectAndBlockForcedLogoutPairs();
  await detectAndBlockRapidRegistrations();
  await detectAndBlockSameIpRegistrations();
  await detectAndBlockSameNameAccounts();
  console.log('✅ [AutoBlock] Multi-account scan complete');
}

export function startMultiAccountWarningScheduler(): void {
  // Run every 10 minutes (faster than the old hourly + 24h delay)
  cron.schedule('*/10 * * * *', async () => {
    await runAllDetections();
  });

  // Run on startup after 20s delay so DB is ready
  setTimeout(async () => {
    console.log('🔍 [AutoBlock] Startup scan...');
    await runAllDetections();
  }, 20000);

  console.log('✅ [AutoBlock] Immediate multi-account blocker started (runs every 10 minutes)');
}
