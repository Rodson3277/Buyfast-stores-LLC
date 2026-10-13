/**
 * 🛡️ FRAUD PREVENTION: Recipient Lock System
 * Prevents concurrent top-ups to the same phone number
 */

import { normalizePhone } from '../utils/normalize-phone';

interface RecipientLock {
  transactionId: string;
  startedAt: number;
  ttlMs: number;
  orderID?: string;
}

// In-memory store for active recipient locks
const recipientLocks = new Map<string, RecipientLock>();

// Lock TTL: 5 minutes (300,000ms)
const DEFAULT_LOCK_TTL = 5 * 60 * 1000;

/**
 * Clean up expired locks automatically
 */
function cleanupExpiredLocks(): void {
  const now = Date.now();
  const expiredPhones: string[] = [];
  
  recipientLocks.forEach((lock, phone) => {
    if (now - lock.startedAt > lock.ttlMs) {
      console.log(`🧹 FRAUD PREVENTION: Auto-releasing expired lock for ${phone} (transaction: ${lock.transactionId})`);
      expiredPhones.push(phone);
    }
  });
  
  expiredPhones.forEach(phone => recipientLocks.delete(phone));
}

/**
 * Attempt to acquire a lock for a recipient phone number
 */
export function acquireRecipientLock(
  recipientPhone: string, 
  transactionId: string, 
  orderID?: string,
  ttlMs: number = DEFAULT_LOCK_TTL
): { success: boolean; conflictingTransaction?: string; reason?: string } {
  
  // Clean up expired locks first
  cleanupExpiredLocks();
  
  // 🛡️ CRITICAL: Use consistent phone normalization
  const normalizedPhone = normalizePhone(recipientPhone);
  
  // Check if lock already exists
  const existingLock = recipientLocks.get(normalizedPhone);
  
  if (existingLock) {
    console.log(`🚫 FRAUD PREVENTION: Lock acquisition failed - phone ${normalizedPhone} already locked by transaction ${existingLock.transactionId}`);
    return {
      success: false,
      conflictingTransaction: existingLock.transactionId,
      reason: 'CONCURRENT_DUPLICATE_RECIPIENT'
    };
  }
  
  // Acquire the lock
  const lock: RecipientLock = {
    transactionId,
    startedAt: Date.now(),
    ttlMs,
    orderID
  };
  
  recipientLocks.set(normalizedPhone, lock);
  
  console.log(`🔒 FRAUD PREVENTION: Lock acquired for ${normalizedPhone} by transaction ${transactionId} (TTL: ${ttlMs}ms)`);
  
  return { success: true };
}

/**
 * Release a lock for a recipient phone number
 */
export function releaseRecipientLock(recipientPhone: string, transactionId: string): boolean {
  const normalizedPhone = normalizePhone(recipientPhone);
  const existingLock = recipientLocks.get(normalizedPhone);
  
  if (!existingLock) {
    console.log(`⚠️ FRAUD PREVENTION: No lock found to release for ${normalizedPhone}`);
    return false;
  }
  
  if (existingLock.transactionId !== transactionId) {
    console.log(`⚠️ FRAUD PREVENTION: Lock release failed - transaction mismatch for ${normalizedPhone} (expected: ${existingLock.transactionId}, got: ${transactionId})`);
    return false;
  }
  
  recipientLocks.delete(normalizedPhone);
  console.log(`🔓 FRAUD PREVENTION: Lock released for ${normalizedPhone} by transaction ${transactionId}`);
  
  return true;
}

/**
 * Check if a recipient phone number is currently locked
 */
export function isRecipientLocked(recipientPhone: string): { locked: boolean; lockInfo?: RecipientLock } {
  cleanupExpiredLocks();
  
  const normalizedPhone = normalizePhone(recipientPhone);
  const lock = recipientLocks.get(normalizedPhone);
  
  if (lock) {
    return { locked: true, lockInfo: lock };
  }
  
  return { locked: false };
}

/**
 * Get all active locks (for debugging/monitoring)
 */
export function getActiveLocks(): Map<string, RecipientLock> {
  cleanupExpiredLocks();
  return new Map(recipientLocks);
}

/**
 * Force cleanup of all locks (for testing/emergency)
 */
export function clearAllLocks(): void {
  const count = recipientLocks.size;
  recipientLocks.clear();
  console.log(`🧹 FRAUD PREVENTION: Force cleared ${count} recipient locks`);
}

// Auto-cleanup every 2 minutes
setInterval(cleanupExpiredLocks, 2 * 60 * 1000);

console.log('🛡️ FRAUD PREVENTION: Recipient lock system initialized');