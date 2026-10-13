import { db } from './server/db';
import { users, walletTransactions, paypalOrderTracking } from './shared/schema';
import { eq } from 'drizzle-orm';

const USER_ID = 'restored_admin_rodson';
const CREDIT_AMOUNT = 5.00;
const ORDER_ID = '7CG1271221867525T';

async function main() {
  const result = await db.select().from(users).where(eq(users.id, USER_ID)).limit(1);
  const user = result[0];
  if (!user) { console.error('❌ User not found'); process.exit(1); }
  
  const currentOther = parseFloat(user.otherCredits || '0');
  const currentBalance = parseFloat(user.balance || '0');
  const newOther = currentOther + CREDIT_AMOUNT;
  const newBalance = currentBalance + CREDIT_AMOUNT;
  
  console.log(`Current balance: $${currentBalance}`);
  
  await db.update(users).set({
    otherCredits: newOther.toFixed(2),
    balance: newBalance.toFixed(2)
  }).where(eq(users.id, USER_ID));
  
  await db.insert(walletTransactions).values({
    userId: USER_ID,
    type: 'paypal_deposit',
    amount: CREDIT_AMOUNT.toFixed(2),
    creditType: 'other',
    balanceBefore: currentBalance.toFixed(6),
    balanceAfter: newBalance.toFixed(6),
    description: `Admin credit: $${CREDIT_AMOUNT} for Google Pay order ${ORDER_ID} - PayPal captured $6.21 but wallet credit failed silently`,
    status: 'completed'
  });
  
  await db.update(paypalOrderTracking).set({
    status: 'completed',
    baseAmount: CREDIT_AMOUNT.toString(),
    processedAt: new Date()
  }).where(eq(paypalOrderTracking.paypalOrderId, ORDER_ID));
  
  console.log(`✅ SUCCESS: Wallet credited $${CREDIT_AMOUNT} → new balance: $${newBalance}`);
  process.exit(0);
}

main().catch(e => { console.error('❌', e.message || e); process.exit(1); });
