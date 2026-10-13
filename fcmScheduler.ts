import * as cron from 'node-cron';
import { storage } from '../storage';
import fcmService from '../services/fcmService';
import fcmTokenRenewal from '../services/fcmTokenRenewal';

// ─── Auto-generated promo code configuration ──────────────────────────────────
const AUTO_PROMO_CONFIG: Record<string, { discountPct: number; maxUses: number; durationHours: number; isGuestOnly: boolean }> = {
  'topup':        { discountPct: 10, maxUses: 200, durationHours: 24, isGuestOnly: false },
  'add-funds':    { discountPct: 8,  maxUses: 150, durationHours: 24, isGuestOnly: false },
  'bill-payment': { discountPct: 12, maxUses: 100, durationHours: 24, isGuestOnly: false },
  'gift-card':    { discountPct: 15, maxUses: 100, durationHours: 24, isGuestOnly: false },
  'natcash':      { discountPct: 10, maxUses: 150, durationHours: 24, isGuestOnly: false },
  'moncash':      { discountPct: 10, maxUses: 150, durationHours: 24, isGuestOnly: false },
  'guest-topup':  { discountPct: 8,  maxUses: 100, durationHours: 24, isGuestOnly: true  },
  'cash-pick':    { discountPct: 10, maxUses: 100, durationHours: 24, isGuestOnly: false },
  'betting-tips': { discountPct: 12, maxUses: 100, durationHours: 24, isGuestOnly: false },
};

// ─── Discount multipliers by day of week (0=Sun, 1=Mon … 6=Sat) ──────────────
// Sunday has the highest bonus; weekdays are the base rate
const DAY_DISCOUNT_MULTIPLIERS: Record<number, number> = {
  0: 1.50,  // Dimanch  — +50% (highest: 10% base → 15%)
  1: 1.00,  // Lendi    — base
  2: 1.00,  // Madi     — base
  3: 1.10,  // Mèkredi  — +10%
  4: 1.10,  // Jedi     — +10%
  5: 1.20,  // Vandredi — +20%
  6: 1.30,  // Samdi    — +30%
};

const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// Owner/admin user ID (createdBy for auto-generated codes)
const SYSTEM_ADMIN_ID = 'restored_admin_rodson';

/**
 * Auto-generate a promo code for a given service.
 * Reuses today's code if one already exists — avoids duplicates.
 */
export async function autoGeneratePromoCode(serviceType: string): Promise<{ code: string; discountValue: string } | null> {
  try {
    const cfg = AUTO_PROMO_CONFIG[serviceType];
    if (!cfg) return null;

    // Haiti time details
    const haitiNow  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Port-au-Prince' }));
    const mm        = String(haitiNow.getMonth() + 1).padStart(2, '0');
    const dd        = String(haitiNow.getDate()).padStart(2, '0');
    const dayOfWeek = haitiNow.getDay(); // 0=Sun … 6=Sat
    const dayCode   = DAY_CODES[dayOfWeek];

    // Adjusted discount based on day of week (Sunday highest, weekdays base)
    const multiplier      = DAY_DISCOUNT_MULTIPLIERS[dayOfWeek] ?? 1.0;
    const adjustedDiscount = Math.round(cfg.discountPct * multiplier);

    // Code includes day abbreviation so each day is visually unique: BF-TOPUP-0301-SUN
    const serviceTag = serviceType.toUpperCase().replace('-', '').slice(0, 8);
    const codeStr   = `BF-${serviceTag}-${mm}${dd}-${dayCode}`;

    // Check if it already exists and is still active — reuse with current adjusted discount
    const existing = await storage.getDiscountCodeByCode(codeStr);
    if (existing && existing.isActive && new Date(existing.expiresAt) > new Date()) {
      console.log(`♻️ Reusing auto-generated code: ${codeStr} (${adjustedDiscount}%)`);
      return { code: codeStr, discountValue: `${adjustedDiscount}%` };
    }

    // Expiry = now + durationHours (Haiti time)
    const expiresAt = new Date(haitiNow.getTime() + cfg.durationHours * 60 * 60 * 1000);

    await storage.createDiscountCode({
      code:           codeStr,
      influencerName: 'BuyFast Auto',
      discountType:   'percentage',
      discountValue:  String(adjustedDiscount),
      minAmount:      '0.00',
      maxUses:        cfg.maxUses,
      currentUses:    0,
      isActive:       true,
      isGuestOnly:    cfg.isGuestOnly,
      applicableTo:   serviceType,
      expiresAt,
      description:    `Auto-generated promo — ${serviceType} — ${mm}/${dd} (${dayCode}, ${adjustedDiscount}%)`,
      createdBy:      SYSTEM_ADMIN_ID,
    });

    console.log(`✅ Auto-generated promo code: ${codeStr} (${adjustedDiscount}% off [${dayCode} ×${multiplier}], expires in ${cfg.durationHours}h)`);
    return { code: codeStr, discountValue: `${adjustedDiscount}%` };
  } catch (err: any) {
    console.error(`❌ Failed to auto-generate promo code for ${serviceType}:`, err.message || err);
    return null;
  }
}

// Cron job for sending reminder notifications (9 AM, 3 PM, 9 PM Haiti time)
// Schedule: 0 9,15,21 * * * America/Port-au-Prince
let fcmCronJob: ReturnType<typeof cron.schedule> | null = null;

// Cron job for renewing FCM tokens (6 AM, 6 PM Haiti time)
// Schedule: 0 6,18 * * * America/Port-au-Prince
let tokenRenewalCronJob: ReturnType<typeof cron.schedule> | null = null;

// Cron job for cleanup every 24 hours
let tokenCleanupCronJob: ReturnType<typeof cron.schedule> | null = null;

// Hourly engagement notification cron job (every hour, 24/7)
let hourlyNotificationCronJob: ReturnType<typeof cron.schedule> | null = null;

// 20-minute engagement notification cron job
let twentyMinCronJob: ReturnType<typeof cron.schedule> | null = null;

// Daily promo notification cron job (7x per day, one per service)
let dailyPromoCronJob: ReturnType<typeof cron.schedule> | null = null;

// Referral notification cron job (2x per day — 10 AM and 6 PM Haiti time)
let referralNotificationCronJob: ReturnType<typeof cron.schedule> | null = null;

// 7 Daily promo slots: hour (Haiti time) → service type
export const DAILY_PROMO_SCHEDULE: Array<{ hour: number; service: string; emoji: string }> = [
  { hour: 7,  service: 'topup',        emoji: '📱' },
  { hour: 9,  service: 'add-funds',    emoji: '💰' },
  { hour: 11, service: 'bill-payment', emoji: '🧾' },
  { hour: 13, service: 'gift-card',    emoji: '🎁' },
  { hour: 15, service: 'natcash',      emoji: '📤' },
  { hour: 17, service: 'moncash',      emoji: '📱' },
  { hour: 19, service: 'guest-topup',  emoji: '👤' },
];

// Multilingual promo notification templates per service
const PROMO_NOTIFICATION_TEMPLATES: Record<string, {
  titleHt: string; bodyHt: string;
  titleEn: string; bodyEn: string;
  titleFr: string; bodyFr: string;
  titleEs: string; bodyEs: string;
  route: string;
}> = {
  'topup': {
    titleHt: '📱 Promo Recharge Telefòn!',
    bodyHt:  'Sèvi ak kòd [{CODE}] pou {VAL}% rabè sou prochèn recharge ou! Limit tan.',
    titleEn: '📱 Mobile Top-up Promo!',
    bodyEn:  'Use code [{CODE}] for {VAL}% off your next top-up! Limited time.',
    titleFr: '📱 Promo Recharge Mobile!',
    bodyFr:  'Utilisez le code [{CODE}] pour {VAL}% de réduction sur votre prochaine recharge!',
    titleEs: '📱 ¡Promo Recarga Móvil!',
    bodyEs:  '¡Usa el código [{CODE}] para {VAL}% de descuento en tu próxima recarga!',
    route: '/topup',
  },
  'add-funds': {
    titleHt: '💰 Promo Depo Pòtfèy!',
    bodyHt:  'Sèvi ak [{CODE}] pou {VAL}% sou prochèn depo nan pòtfèy BuyFast ou!',
    titleEn: '💰 Wallet Top-up Promo!',
    bodyEn:  'Use [{CODE}] for {VAL}% off your next BuyFast wallet deposit!',
    titleFr: '💰 Promo Dépôt Portefeuille!',
    bodyFr:  'Utilisez [{CODE}] pour {VAL}% sur votre prochain dépôt BuyFast!',
    titleEs: '💰 ¡Promo Depósito Billetera!',
    bodyEs:  '¡Usa [{CODE}] para {VAL}% de descuento en tu próximo depósito BuyFast!',
    route: '/add-funds',
  },
  'bill-payment': {
    titleHt: '🧾 Promo Peye Fakti!',
    bodyHt:  'Kòd [{CODE}] ba ou {VAL}% rabè sou pèman fakti ou jodi a!',
    titleEn: '🧾 Bill Payment Promo!',
    bodyEn:  'Code [{CODE}] gives you {VAL}% off your bill payment today!',
    titleFr: '🧾 Promo Paiement de Facture!',
    bodyFr:  'Le code [{CODE}] vous donne {VAL}% de réduction sur votre facture!',
    titleEs: '🧾 ¡Promo Pago de Factura!',
    bodyEs:  '¡El código [{CODE}] te da {VAL}% de descuento en tu pago de factura!',
    route: '/bill-payment',
  },
  'gift-card': {
    titleHt: '🎁 Promo Kat Kado!',
    bodyHt:  'Achte Gift Card ak kòd [{CODE}] pou {VAL}% rabè! Amazon, iTunes, +.',
    titleEn: '🎁 Gift Card Promo!',
    bodyEn:  'Buy a Gift Card with [{CODE}] for {VAL}% off! Amazon, iTunes & more.',
    titleFr: '🎁 Promo Carte Cadeau!',
    bodyFr:  "Achetez une carte cadeau avec [{CODE}] pour {VAL}% de réduction!",
    titleEs: '🎁 ¡Promo Tarjeta de Regalo!',
    bodyEs:  '¡Compra una Gift Card con [{CODE}] y obtén {VAL}% de descuento!',
    route: '/gift-cards',
  },
  'natcash': {
    titleHt: '📤 Promo Transfè NatCash!',
    bodyHt:  'Sèvi ak [{CODE}] pou {VAL}% rabè sou prochèn transfè NatCash ou!',
    titleEn: '📤 NatCash Transfer Promo!',
    bodyEn:  'Use [{CODE}] for {VAL}% off your next NatCash transfer!',
    titleFr: '📤 Promo Transfert NatCash!',
    bodyFr:  'Utilisez [{CODE}] pour {VAL}% de réduction sur votre transfert NatCash!',
    titleEs: '📤 ¡Promo Transferencia NatCash!',
    bodyEs:  '¡Usa [{CODE}] para {VAL}% de descuento en tu transferencia NatCash!',
    route: '/natcash-transfer',
  },
  'moncash': {
    titleHt: '📱 Promo Transfè MonCash!',
    bodyHt:  'Kòd [{CODE}] ba ou {VAL}% rabè sou prochèn transfè MonCash ou!',
    titleEn: '📱 MonCash Transfer Promo!',
    bodyEn:  'Code [{CODE}] gets you {VAL}% off your next MonCash transfer!',
    titleFr: '📱 Promo Transfert MonCash!',
    bodyFr:  'Le code [{CODE}] vous offre {VAL}% de réduction sur votre transfert MonCash!',
    titleEs: '📱 ¡Promo Transferencia MonCash!',
    bodyEs:  '¡El código [{CODE}] te da {VAL}% de descuento en tu transferencia MonCash!',
    route: '/moncash-transfer',
  },
  'guest-topup': {
    titleHt: '👤 Promo Envite Spesyal!',
    bodyHt:  'Pa gen kont? Itilize [{CODE}] pou {VAL}% rabè sou recharge envite ou!',
    titleEn: '👤 Guest Special Promo!',
    bodyEn:  'No account? Use [{CODE}] for {VAL}% off your guest top-up!',
    titleFr: '👤 Promo Invité Spéciale!',
    bodyFr:  'Pas de compte? Utilisez [{CODE}] pour {VAL}% sur votre recharge invité!',
    titleEs: '👤 ¡Promo Especial Invitado!',
    bodyEs:  '¡Sin cuenta? Usa [{CODE}] para {VAL}% de descuento en tu recarga de invitado!',
    route: '/guest-topup',
  },
};

// Test notification interval (30 seconds) - for FCM verification
let testNotificationInterval: ReturnType<typeof setInterval> | null = null;
let testNotificationCount = 0;

// ─────────────────────────────────────────────────────────────────────────────
// 24 HOURLY ENGAGEMENT NOTIFICATIONS — 4 Languages (HT / EN / FR / ES)
// Index 0 = midnight (00h) … Index 23 = 11 PM (23h)  — Haiti time
// ─────────────────────────────────────────────────────────────────────────────
export const HOURLY_NOTIFICATIONS: Array<{
  titleHt: string; bodyHt: string;
  titleEn: string; bodyEn: string;
  titleFr: string; bodyFr: string;
  titleEs: string; bodyEs: string;
}> = [
  // 00h — Midnight
  {
    titleHt: '🌙 Minnwi — BuyFast toujou la!',
    bodyHt:  'Ou ka recharge telefòn fanmi ou nenpòt lè, menm minwi. Eseye kounye a!',
    titleEn: '🌙 Midnight — BuyFast Never Sleeps!',
    bodyEn:  'Top up family phones anytime, even at midnight. Try now!',
    titleFr: '🌙 Minuit — BuyFast est toujours là!',
    bodyFr:  'Rechargez les téléphones de votre famille à tout moment, même à minuit!',
    titleEs: '🌙 Medianoche — ¡BuyFast nunca duerme!',
    bodyEs:  '¡Recarga teléfonos familiares en cualquier momento, incluso a medianoche!',
  },
  // 01h
  {
    titleHt: '💤 Dòmi pa prese...',
    bodyHt:  'Anvan ou dòmi, asire fanmi ou gen recharge! BuyFast vit ak fasil.',
    titleEn: '💤 Not sleepy yet?',
    bodyEn:  'Before you sleep, make sure your family has credit! BuyFast is fast and easy.',
    titleFr: '💤 Pas encore sommeil?',
    bodyFr:  'Avant de dormir, assurez-vous que votre famille a du crédit! BuyFast c\'est rapide.',
    titleEs: '💤 ¿Aún no duermes?',
    bodyEs:  'Antes de dormir, ¡asegúrate de que tu familia tenga saldo! BuyFast es rápido y fácil.',
  },
  // 02h
  {
    titleHt: '🌟 Tout moun k ap dòmi, ou?',
    bodyHt:  'Profite trankil la — voye lajan NatCash oswa MonCash san atann!',
    titleEn: '🌟 Everyone\'s asleep, are you?',
    bodyEn:  'Take the quiet moment — send NatCash or MonCash transfers now!',
    titleFr: '🌟 Tout le monde dort, et vous?',
    bodyFr:  'Profitez du calme — envoyez de l\'argent via NatCash ou MonCash maintenant!',
    titleEs: '🌟 ¿Todos duermen, y tú?',
    bodyEs:  'Aprovecha el momento tranquilo — ¡envía dinero por NatCash o MonCash ahora!',
  },
  // 03h
  {
    titleHt: '🛡️ Pòtfèy ou an sekirite',
    bodyHt:  'Lajan ou nan BuyFast pòtfèy toujou pwoteje. Verifye balans ou!',
    titleEn: '🛡️ Your wallet is secure',
    bodyEn:  'Your BuyFast wallet balance is always protected. Check it now!',
    titleFr: '🛡️ Votre portefeuille est sécurisé',
    bodyFr:  'Votre solde BuyFast est toujours protégé. Vérifiez maintenant!',
    titleEs: '🛡️ Tu billetera está segura',
    bodyEs:  'Tu saldo BuyFast siempre está protegido. ¡Verifícalo ahora!',
  },
  // 04h
  {
    titleHt: '🌅 Jou ap kòmanse bientò...',
    bodyHt:  'Prepare jounen ou — chaje pòtfèy BuyFast ou dèzòm!',
    titleEn: '🌅 A new day is almost here!',
    bodyEn:  'Get ready — top up your BuyFast wallet right now!',
    titleFr: '🌅 Un nouveau jour arrive bientôt!',
    bodyFr:  'Préparez-vous — rechargez votre portefeuille BuyFast maintenant!',
    titleEs: '🌅 ¡Un nuevo día está por comenzar!',
    bodyEs:  'Prepárate — ¡recarga tu billetera BuyFast ahora!',
  },
  // 05h
  {
    titleHt: '☀️ Bonjou! Jou frèch la rive.',
    bodyHt:  'Kòmanse jounen ou avèk yon recharge pou fanmi ou ann Ayiti!',
    titleEn: '☀️ Good morning! Fresh new day!',
    bodyEn:  'Start your day with a top-up for your family in Haiti!',
    titleFr: '☀️ Bonjour! Un nouveau jour est là!',
    bodyFr:  'Commencez votre journée avec une recharge pour votre famille!',
    titleEs: '☀️ ¡Buenos días! ¡Nuevo día fresco!',
    bodyEs:  '¡Comienza tu día con una recarga para tu familia!',
  },
  // 06h
  {
    titleHt: '🍳 Maten frèch!',
    bodyHt:  'Pa bliye — recharge telefòn ak BuyFast pi vit pase fè kafe!',
    titleEn: '🍳 Fresh morning!',
    bodyEn:  'Remember — topping up with BuyFast is faster than making coffee!',
    titleFr: '🍳 Matin frais!',
    bodyFr:  'N\'oubliez pas — recharger avec BuyFast est plus rapide que faire du café!',
    titleEs: '🍳 ¡Mañana fresca!',
    bodyEs:  'Recuerda — ¡recargar con BuyFast es más rápido que hacer café!',
  },
  // 07h
  {
    titleHt: '🚀 Jounen ou kòmanse!',
    bodyHt:  'Voye lajan NatCash / MonCash avan ou pati nan travay. Rapid & Sekirize!',
    titleEn: '🚀 Your day is starting!',
    bodyEn:  'Send NatCash / MonCash before heading to work. Fast & Secure!',
    titleFr: '🚀 Votre journée commence!',
    bodyFr:  'Envoyez de l\'argent NatCash / MonCash avant d\'aller travailler. Rapide & Sécurisé!',
    titleEs: '🚀 ¡Tu día comienza!',
    bodyEs:  'Envía dinero NatCash / MonCash antes de ir al trabajo. ¡Rápido y Seguro!',
  },
  // 08h
  {
    titleHt: '💼 Travay ap kòmanse...',
    bodyHt:  'Mèsi dèske ou fè konfyans BuyFast! Recharge, Gift Cards, Bills — tout an 1 klik.',
    titleEn: '💼 Work is starting...',
    bodyEn:  'Thanks for trusting BuyFast! Top-ups, Gift Cards, Bills — all in 1 click.',
    titleFr: '💼 Le travail commence...',
    bodyFr:  'Merci de faire confiance à BuyFast! Recharges, Cartes Cadeaux, Factures — tout en 1 clic.',
    titleEs: '💼 El trabajo comienza...',
    bodyEs:  '¡Gracias por confiar en BuyFast! Recargas, Tarjetas, Facturas — todo en 1 clic.',
  },
  // 09h
  {
    titleHt: '🎁 Gen yon kado pou kèk moun?',
    bodyHt:  'Achte Gift Card Amazon, iTunes, Google Play pou zanmi ou jodi a!',
    titleEn: '🎁 Have a gift for someone?',
    bodyEn:  'Buy Amazon, iTunes, Google Play Gift Cards for your friends today!',
    titleFr: '🎁 Un cadeau pour quelqu\'un?',
    bodyFr:  'Achetez des cartes cadeaux Amazon, iTunes, Google Play pour vos amis aujourd\'hui!',
    titleEs: '🎁 ¿Tienes un regalo para alguien?',
    bodyEs:  '¡Compra Gift Cards de Amazon, iTunes, Google Play para tus amigos hoy!',
  },
  // 10h
  {
    titleHt: '💡 Tip dijital jounen an',
    bodyHt:  'Ou ka peye fakti EDE, NATCOM, Digicel dirèkteman nan BuyFast. Eseye!',
    titleEn: '💡 Digital tip of the day',
    bodyEn:  'You can pay EDE, NATCOM, Digicel bills directly on BuyFast. Try it!',
    titleFr: '💡 Astuce numérique du jour',
    bodyFr:  'Vous pouvez payer vos factures EDE, NATCOM, Digicel directement sur BuyFast. Essayez!',
    titleEs: '💡 Consejo digital del día',
    bodyEs:  '¡Puedes pagar facturas de EDE, NATCOM, Digicel directamente en BuyFast. Pruébalo!',
  },
  // 11h
  {
    titleHt: '🤑 Promo k ap tann ou!',
    bodyHt:  'Gade dènye promo BuyFast yo — ekonomize lajan sou chak tranzaksyon!',
    titleEn: '🤑 Promos waiting for you!',
    bodyEn:  'Check the latest BuyFast promotions — save money on every transaction!',
    titleFr: '🤑 Des promos vous attendent!',
    bodyFr:  'Consultez les dernières promotions BuyFast — économisez sur chaque transaction!',
    titleEs: '🤑 ¡Hay promos esperándote!',
    bodyEs:  '¡Consulta las últimas promociones de BuyFast — ahorra en cada transacción!',
  },
  // 12h — Noon
  {
    titleHt: '🍽️ Manje midi — Panse ak fanmi!',
    bodyHt:  'Fanmi ou ann Ayiti bezwen recharge? Voye yo youn nan 30 segonn!',
    titleEn: '🍽️ Lunchtime — Think of family!',
    bodyEn:  'Does your family in Haiti need a top-up? Send one in 30 seconds!',
    titleFr: '🍽️ Déjeuner — Pensez à votre famille!',
    bodyFr:  'Votre famille en Haïti a besoin d\'une recharge? Envoyez-en une en 30 secondes!',
    titleEs: '🍽️ Almuerzo — ¡Piensa en tu familia!',
    bodyEs:  '¿Tu familia en Haití necesita recarga? ¡Envíala en 30 segundos!',
  },
  // 13h
  {
    titleHt: '📲 Telefòn fanmi ou vid?',
    bodyHt:  'Recharge Digicel, Natcom oswa lòt operatè nenpòt kote nan mond lan!',
    titleEn: '📲 Family phone is empty?',
    bodyEn:  'Recharge Digicel, Natcom or any operator anywhere in the world!',
    titleFr: '📲 Le téléphone de votre famille est vide?',
    bodyFr:  'Rechargez Digicel, Natcom ou tout opérateur n\'importe où dans le monde!',
    titleEs: '📲 ¿El teléfono de tu familia está vacío?',
    bodyEs:  '¡Recarga Digicel, Natcom u otro operador en cualquier parte del mundo!',
  },
  // 14h
  {
    titleHt: '💰 Lajan ou travay pou ou!',
    bodyHt:  'Depozit nan pòtfèy BuyFast ou epi ekonomize sou frè tranzaksyon yo!',
    titleEn: '💰 Make your money work!',
    bodyEn:  'Deposit into your BuyFast wallet and save on transaction fees!',
    titleFr: '💰 Faites travailler votre argent!',
    bodyFr:  'Déposez dans votre portefeuille BuyFast et économisez sur les frais!',
    titleEs: '💰 ¡Haz que tu dinero trabaje!',
    bodyEs:  '¡Deposita en tu billetera BuyFast y ahorra en comisiones!',
  },
  // 15h
  {
    titleHt: '⚡ Flash Sale posib kounye a!',
    bodyHt:  'Tcheke paj pwomosyon an — ka gen rabè espesyal jodi a!',
    titleEn: '⚡ Flash Sale happening now?',
    bodyEn:  'Check the promotions page — there could be special discounts today!',
    titleFr: '⚡ Flash Sale maintenant?',
    bodyFr:  'Consultez la page promotions — il pourrait y avoir des réductions spéciales aujourd\'hui!',
    titleEs: '⚡ ¿Flash Sale ahora?',
    bodyEs:  '¡Revisa la página de promociones — puede haber descuentos especiales hoy!',
  },
  // 16h
  {
    titleHt: '🌍 Fanmi dabò!',
    bodyHt:  'Voye recharge pou fanmi nan Ayiti, Karayib, oswa nenpòt kote nan mond!',
    titleEn: '🌍 Family comes first!',
    bodyEn:  'Send top-ups for family in Haiti, the Caribbean, or anywhere in the world!',
    titleFr: '🌍 La famille d\'abord!',
    bodyFr:  'Envoyez des recharges pour votre famille en Haïti, dans les Caraïbes ou partout!',
    titleEs: '🌍 ¡La familia primero!',
    bodyEs:  '¡Envía recargas a tu familia en Haití, el Caribe o cualquier parte del mundo!',
  },
  // 17h
  {
    titleHt: '🏠 Swa travay fini...',
    bodyHt:  'Kounye a bon moman pou peye fakti kay ou — electricite, dlo, telefòn!',
    titleEn: '🏠 Work day is over...',
    bodyEn:  'Now\'s the perfect time to pay your household bills — electricity, water, phone!',
    titleFr: '🏠 La journée de travail est terminée...',
    bodyFr:  'C\'est le bon moment pour payer vos factures — électricité, eau, téléphone!',
    titleEs: '🏠 El día de trabajo terminó...',
    bodyEs:  '¡Ahora es el momento perfecto para pagar tus facturas — electricidad, agua, teléfono!',
  },
  // 18h
  {
    titleHt: '🌆 Aswè rive!',
    bodyHt:  'Pa kite jounen an fini san ou pa pran swen bezwen fanmi ou. BuyFast la!',
    titleEn: '🌆 Evening is here!',
    bodyEn:  "Don't let the day end without taking care of your family's needs. BuyFast is here!",
    titleFr: '🌆 Le soir est arrivé!',
    bodyFr:  'Ne laissez pas la journée se terminer sans prendre soin de votre famille. BuyFast est là!',
    titleEs: '🌆 ¡Llegó la tarde!',
    bodyEs:  '¡No dejes que el día termine sin cuidar las necesidades de tu familia. BuyFast está aquí!',
  },
  // 19h
  {
    titleHt: '🎮 Relaksasyon aswè!',
    bodyHt:  'Achte Gift Card pou jwèt oswa streaming — Netflix, Steam, PlayStation!',
    titleEn: '🎮 Evening relaxation!',
    bodyEn:  'Buy Gift Cards for games or streaming — Netflix, Steam, PlayStation!',
    titleFr: '🎮 Détente du soir!',
    bodyFr:  'Achetez des cartes cadeaux pour les jeux ou le streaming — Netflix, Steam, PlayStation!',
    titleEs: '🎮 ¡Relajación nocturna!',
    bodyEs:  '¡Compra Gift Cards para juegos o streaming — Netflix, Steam, PlayStation!',
  },
  // 20h
  {
    titleHt: '📊 Tcheke balans ou!',
    bodyHt:  'Ki balans ou genyen nan pòtfèy BuyFast ou? Touche — kounye a!',
    titleEn: '📊 Check your balance!',
    bodyEn:  "What's your BuyFast wallet balance? Tap to find out — right now!",
    titleFr: '📊 Vérifiez votre solde!',
    bodyFr:  'Quel est votre solde BuyFast? Appuyez pour le savoir — maintenant!',
    titleEs: '📊 ¡Revisa tu saldo!',
    bodyEs:  '¿Cuál es tu saldo de BuyFast? ¡Toca para saber — ahora mismo!',
  },
  // 21h
  {
    titleHt: '🌟 Dènye chans jounen an!',
    bodyHt:  'Dènye promo jounen an — recharge telefòn pou ekonomize anpil!',
    titleEn: '🌟 Last chance of the day!',
    bodyEn:  'Last promo of the day — top up to save big!',
    titleFr: '🌟 Dernière chance du jour!',
    bodyFr:  'Dernière promo du jour — rechargez pour économiser beaucoup!',
    titleEs: '🌟 ¡Última oportunidad del día!',
    bodyEs:  '¡Última promo del día — recarga y ahorra mucho!',
  },
  // 22h
  {
    titleHt: '🔒 Sekirite dabò!',
    bodyHt:  'Kont BuyFast ou pwoteje 24/7. Dòmi ak kè poze — lajan ou an sekirite!',
    titleEn: '🔒 Security first!',
    bodyEn:  'Your BuyFast account is protected 24/7. Sleep peacefully — your money is safe!',
    titleFr: '🔒 La sécurité d\'abord!',
    bodyFr:  'Votre compte BuyFast est protégé 24h/24. Dormez tranquille — votre argent est sécurisé!',
    titleEs: '🔒 ¡Seguridad primero!',
    bodyEs:  '¡Tu cuenta BuyFast está protegida 24/7. Duerme tranquilo — tu dinero está seguro!',
  },
  // 23h
  {
    titleHt: '🌙 Anvan dòmi...',
    bodyHt:  'Ou te bliye yon recharge? Voye youn kounye a — pran 30 segonn sèlman!',
    titleEn: '🌙 Before you sleep...',
    bodyEn:  'Did you forget a top-up? Send one now — takes only 30 seconds!',
    titleFr: '🌙 Avant de dormir...',
    bodyFr:  "Avez-vous oublié une recharge? Envoyez-en une maintenant — seulement 30 secondes!",
    titleEs: '🌙 Antes de dormir...',
    bodyEs:  '¿Olvidaste una recarga? ¡Envía una ahora — solo toma 30 segundos!',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 36-MESAJ PISCINE — Chak 20 minit (3×/zèdtan) — 4 Lang
// Itilize (hour*3 + minuteSlot) % pool.length pou chwazi mesaj la
// ─────────────────────────────────────────────────────────────────────────────
export const TWENTY_MIN_NOTIFICATION_POOL: Array<{
  titleHt: string; bodyHt: string;
  titleEn: string; bodyEn: string;
  titleFr: string; bodyFr: string;
  titleEs: string; bodyEs: string;
}> = [
  // 0
  {
    titleHt: '📱 Recharge Digicel Rapid!',
    bodyHt:  'Voye kredi Digicel nan Ayiti an mwens pase 1 minit. Eseye BuyFast kounye a!',
    titleEn: '📱 Fast Digicel Top-Up!',
    bodyEn:  'Send Digicel credit to Haiti in less than 1 minute. Try BuyFast now!',
    titleFr: '📱 Recharge Digicel Rapide!',
    bodyFr:  'Envoyez du crédit Digicel en Haïti en moins d\'1 minute. Essayez BuyFast!',
    titleEs: '📱 ¡Recarga Digicel Rápida!',
    bodyEs:  '¡Envía crédito Digicel a Haití en menos de 1 minuto. Prueba BuyFast!',
  },
  // 1
  {
    titleHt: '💳 Pòtfèy BuyFast ou vid?',
    bodyHt:  'Chaje pòtfèy ou avèk PayPal oswa Stripe — rapid, sekirize, fasil!',
    titleEn: '💳 BuyFast wallet empty?',
    bodyEn:  'Fund your wallet via PayPal or Stripe — fast, secure, easy!',
    titleFr: '💳 Portefeuille BuyFast vide?',
    bodyFr:  'Alimentez votre portefeuille via PayPal ou Stripe — rapide et sécurisé!',
    titleEs: '💳 ¿Billetera BuyFast vacía?',
    bodyEs:  '¡Recarga tu billetera con PayPal o Stripe — rápido, seguro y fácil!',
  },
  // 2
  {
    titleHt: '🎁 Amazon Gift Card disponib!',
    bodyHt:  'Achte Gift Card Amazon $10 rive $500 — livrezon imedya pa imèl!',
    titleEn: '🎁 Amazon Gift Cards available!',
    bodyEn:  'Buy Amazon Gift Cards $10 to $500 — instant delivery by email!',
    titleFr: '🎁 Cartes Cadeau Amazon disponibles!',
    bodyFr:  'Achetez des cartes cadeaux Amazon de $10 à $500 — livraison instantanée!',
    titleEs: '🎁 ¡Gift Cards de Amazon disponibles!',
    bodyEs:  '¡Compra Gift Cards de Amazon $10 a $500 — entrega instantánea por email!',
  },
  // 3
  {
    titleHt: '📤 Voye lajan ak NatCash!',
    bodyHt:  'Transfert NatCash vit ak sekirize — fanmi ou resevwa lajan nan 10-15 minit!',
    titleEn: '📤 Send money with NatCash!',
    bodyEn:  'Fast & secure NatCash transfers — your family gets money in 10-15 min!',
    titleFr: '📤 Envoyez de l\'argent via NatCash!',
    bodyFr:  'Transferts NatCash rapides — votre famille reçoit l\'argent en 10-15 min!',
    titleEs: '📤 ¡Envía dinero con NatCash!',
    bodyEs:  '¡Transferencias NatCash rápidas — tu familia recibe el dinero en 10-15 min!',
  },
  // 4
  {
    titleHt: '🏆 Touche pwen fidèlite!',
    bodyHt:  'Chak tranzaksyon ba ou pwen bonis. Akimile yo pou jwenn kado espesyal!',
    titleEn: '🏆 Earn loyalty points!',
    bodyEn:  'Every transaction earns you bonus points. Collect them for special rewards!',
    titleFr: '🏆 Gagnez des points fidélité!',
    bodyFr:  'Chaque transaction vous rapporte des points bonus. Cumulez-les pour des récompenses!',
    titleEs: '🏆 ¡Gana puntos de fidelidad!',
    bodyEs:  '¡Cada transacción te da puntos bonus. Acumúlalos para premios especiales!',
  },
  // 5
  {
    titleHt: '🧾 Peye fakti EDE fasil!',
    bodyHt:  'Peye fakti elektrisite EDE dirèkteman nan app la. Pa gen fil datant!',
    titleEn: '🧾 Pay EDE bills easily!',
    bodyEn:  'Pay EDE electricity bills directly in the app. No waiting in line!',
    titleFr: '🧾 Payez vos factures EDE facilement!',
    bodyFr:  'Payez vos factures d\'électricité EDE directement dans l\'app. Pas de file d\'attente!',
    titleEs: '🧾 ¡Paga tus facturas EDE fácilmente!',
    bodyEs:  '¡Paga facturas de electricidad EDE directo en la app. Sin filas de espera!',
  },
  // 6
  {
    titleHt: '⭐ Pataje kòd referans ou!',
    bodyHt:  'Chak zanmi ou envite ba ou yon bonis espesyal. Klike pou wè kòd ou!',
    titleEn: '⭐ Share your referral code!',
    bodyEn:  'Every friend you invite gives you a special bonus. Tap to see your code!',
    titleFr: '⭐ Partagez votre code parrainage!',
    bodyFr:  'Chaque ami invité vous rapporte un bonus spécial. Appuyez pour voir votre code!',
    titleEs: '⭐ ¡Comparte tu código de referido!',
    bodyEs:  '¡Cada amigo que invitas te da un bono especial. Toca para ver tu código!',
  },
  // 7
  {
    titleHt: '🎮 Netflix, Steam, PlayStation!',
    bodyHt:  'Achte Gift Card pou jwèt ak streaming nan BuyFast — prè imedyatman!',
    titleEn: '🎮 Netflix, Steam, PlayStation!',
    bodyEn:  'Buy Gift Cards for gaming & streaming on BuyFast — ready instantly!',
    titleFr: '🎮 Netflix, Steam, PlayStation!',
    bodyFr:  'Achetez des cartes cadeaux pour jeux et streaming sur BuyFast — prêtes instantanément!',
    titleEs: '🎮 ¡Netflix, Steam, PlayStation!',
    bodyEs:  '¡Compra Gift Cards para juegos y streaming en BuyFast — listas al instante!',
  },
  // 8
  {
    titleHt: '🌍 Recharge nenpòt kote mond lan!',
    bodyHt:  'BuyFast kouvri 150+ peyi — Ayiti, Dominikani, Jamaïque, Karayib ak plis!',
    titleEn: '🌍 Top-up anywhere in the world!',
    bodyEn:  'BuyFast covers 150+ countries — Haiti, DR, Jamaica, Caribbean & more!',
    titleFr: '🌍 Rechargez partout dans le monde!',
    bodyFr:  'BuyFast couvre 150+ pays — Haïti, RD, Jamaïque, Caraïbes et plus!',
    titleEs: '🌍 ¡Recarga en cualquier parte del mundo!',
    bodyEs:  '¡BuyFast cubre 150+ países — Haití, RD, Jamaica, Caribe y más!',
  },
  // 9
  {
    titleHt: '💰 Ekonomize sou chak tranzaksyon!',
    bodyHt:  'Depozit nan pòtfèy BuyFast ou epi jwenn pi bon pri — mwens frè!',
    titleEn: '💰 Save on every transaction!',
    bodyEn:  'Deposit into your BuyFast wallet and get better rates — lower fees!',
    titleFr: '💰 Économisez sur chaque transaction!',
    bodyFr:  'Déposez dans votre portefeuille BuyFast pour de meilleurs tarifs — moins de frais!',
    titleEs: '💰 ¡Ahorra en cada transacción!',
    bodyEs:  '¡Deposita en tu billetera BuyFast y obtén mejores tarifas — menos comisiones!',
  },
  // 10
  {
    titleHt: '🔔 Ou gen yon kòd promo!',
    bodyHt:  'Tcheke seksyon pwomosyon yo — gen yon kòd rabè k ap tann ou jodi a!',
    titleEn: '🔔 You have a promo code!',
    bodyEn:  'Check the promotions section — there\'s a discount code waiting for you today!',
    titleFr: '🔔 Vous avez un code promo!',
    bodyFr:  'Consultez la section promotions — un code de réduction vous attend aujourd\'hui!',
    titleEs: '🔔 ¡Tienes un código promo!',
    bodyEs:  '¡Revisa la sección de promociones — hay un código de descuento esperándote hoy!',
  },
  // 11
  {
    titleHt: '📱 Natcom gen bèl pakèt!',
    bodyHt:  'Recharge Natcom pou fanmi ou — entènèt, apèl, SMS tout ladan l!',
    titleEn: '📱 Natcom great packages!',
    bodyEn:  'Top up Natcom for your family — internet, calls, SMS all included!',
    titleFr: '📱 Natcom a de belles offres!',
    bodyFr:  'Rechargez Natcom pour votre famille — internet, appels, SMS tout inclus!',
    titleEs: '📱 ¡Natcom tiene grandes paquetes!',
    bodyEs:  '¡Recarga Natcom para tu familia — internet, llamadas, SMS todo incluido!',
  },
  // 12
  {
    titleHt: '🏪 BuyFast Pick — Retray Cash!',
    bodyHt:  'Voye lajan pou yon moun retire cash nan yon ajan BuyFast pre lakay yo!',
    titleEn: '🏪 BuyFast Pick — Cash Pickup!',
    bodyEn:  'Send money for someone to pick up cash at a BuyFast agent near them!',
    titleFr: '🏪 BuyFast Pick — Retrait Cash!',
    bodyFr:  'Envoyez de l\'argent à retirer en espèces chez un agent BuyFast près de chez eux!',
    titleEs: '🏪 ¡BuyFast Pick — Retiro de Efectivo!',
    bodyEs:  '¡Envía dinero para retirar efectivo en un agente BuyFast cerca de ellos!',
  },
  // 13
  {
    titleHt: '🔒 Kont ou pwoteje 100%',
    bodyHt:  'BuyFast itilize chiffrement militè pou pwoteje tout tranzaksyon ou yo. Ou an sekirite!',
    titleEn: '🔒 Your account is 100% protected',
    bodyEn:  'BuyFast uses military-grade encryption to protect all your transactions. You\'re safe!',
    titleFr: '🔒 Votre compte est protégé à 100%',
    bodyFr:  'BuyFast utilise un chiffrement militaire pour protéger toutes vos transactions. Vous êtes en sécurité!',
    titleEs: '🔒 ¡Tu cuenta está 100% protegida!',
    bodyEs:  '¡BuyFast usa encriptación militar para proteger todas tus transacciones. ¡Estás seguro!',
  },
  // 14
  {
    titleHt: '📲 MonCash pou fanmi ann Ayiti!',
    bodyHt:  'Voye lajan MonCash depi nenpòt kote mond lan — fanmi ou resevwa li dirèkteman!',
    titleEn: '📲 MonCash for family in Haiti!',
    bodyEn:  'Send MonCash from anywhere in the world — your family receives it directly!',
    titleFr: '📲 MonCash pour la famille en Haïti!',
    bodyFr:  'Envoyez de l\'argent MonCash depuis partout — votre famille le reçoit directement!',
    titleEs: '📲 ¡MonCash para familia en Haití!',
    bodyEs:  '¡Envía dinero MonCash desde cualquier parte — tu familia lo recibe directamente!',
  },
  // 15
  {
    titleHt: '🎯 Tranzaksyon an 30 segonn!',
    bodyHt:  'Recharge telefòn, peye fakti, voye lajan — tout sa nan mwens pase 30 segonn!',
    titleEn: '🎯 Transactions in 30 seconds!',
    bodyEn:  'Top up phones, pay bills, send money — all in less than 30 seconds!',
    titleFr: '🎯 Transactions en 30 secondes!',
    bodyFr:  'Rechargez, payez des factures, envoyez de l\'argent — tout en moins de 30 secondes!',
    titleEs: '🎯 ¡Transacciones en 30 segundos!',
    bodyEs:  '¡Recarga, paga facturas, envía dinero — todo en menos de 30 segundos!',
  },
  // 16
  {
    titleHt: '💡 Ou konnen? Ekonomize ak pòtfèy!',
    bodyHt:  'Itilizatè ki itilize pòtfèy BuyFast ekonomize jiska 15% sou frè tranzaksyon yo!',
    titleEn: '💡 Did you know? Save with wallet!',
    bodyEn:  'BuyFast wallet users save up to 15% on transaction fees. Fund yours today!',
    titleFr: '💡 Le saviez-vous? Économisez avec le portefeuille!',
    bodyFr:  'Les utilisateurs du portefeuille BuyFast économisent jusqu\'à 15% sur les frais!',
    titleEs: '💡 ¿Sabías? ¡Ahorra con la billetera!',
    bodyEs:  '¡Los usuarios de la billetera BuyFast ahorran hasta 15% en comisiones. Recarga la tuya!',
  },
  // 17
  {
    titleHt: '🌟 iTunes Gift Card disponib!',
    bodyHt:  'Achte iTunes / Apple Gift Card pou yon moun ou renmen — pa imèl imedyatman!',
    titleEn: '🌟 iTunes Gift Cards available!',
    bodyEn:  'Buy iTunes / Apple Gift Cards for someone you love — by email instantly!',
    titleFr: '🌟 Cartes iTunes disponibles!',
    bodyFr:  'Achetez des cartes iTunes / Apple pour quelqu\'un que vous aimez — instantanément!',
    titleEs: '🌟 ¡iTunes Gift Cards disponibles!',
    bodyEs:  '¡Compra Gift Cards de iTunes/Apple para alguien que amas — por email al instante!',
  },
  // 18
  {
    titleHt: '🤝 Kominote BuyFast ap grandi!',
    bodyHt:  'Rejwan plis pase 10,000 itilizatè ki voye lajan ak recharge chak jou. Ou nan bon kote!',
    titleEn: '🤝 BuyFast community is growing!',
    bodyEn:  'Join 10,000+ users who send money & top up daily. You\'re in the right place!',
    titleFr: '🤝 La communauté BuyFast grandit!',
    bodyFr:  'Rejoignez 10 000+ utilisateurs qui envoient de l\'argent et rechargent chaque jour!',
    titleEs: '🤝 ¡La comunidad BuyFast está creciendo!',
    bodyEs:  '¡Únete a 10,000+ usuarios que envían dinero y recargan a diario. ¡Estás en el lugar correcto!',
  },
  // 19
  {
    titleHt: '⚡ Flash Promo — Kounye a!',
    bodyHt:  'Kòd rabè limit tan disponib jodi a! Ale nan seksyon Pwomosyon yo pou jwenn li!',
    titleEn: '⚡ Flash Promo — Right Now!',
    bodyEn:  'Limited time discount code available today! Go to Promotions to grab it!',
    titleFr: '⚡ Promo Flash — Maintenant!',
    bodyFr:  'Code de réduction à durée limitée disponible aujourd\'hui! Allez aux Promotions!',
    titleEs: '⚡ ¡Promo Flash — Ahora!',
    bodyEs:  '¡Código de descuento por tiempo limitado disponible hoy! Ve a Promociones para obtenerlo!',
  },
  // 20
  {
    titleHt: '📊 Balans ou kounye a?',
    bodyHt:  'Yon klik pou wè balans pòtfèy BuyFast ou. Toujou konnen sa ou genyen!',
    titleEn: '📊 What\'s your balance right now?',
    bodyEn:  'One tap to see your BuyFast wallet balance. Always know what you have!',
    titleFr: '📊 Quel est votre solde maintenant?',
    bodyFr:  'Un seul clic pour voir votre solde BuyFast. Sachez toujours ce que vous avez!',
    titleEs: '📊 ¿Cuál es tu saldo ahora mismo?',
    bodyEs:  '¡Un toque para ver tu saldo BuyFast. ¡Siempre sabe lo que tienes!',
  },
  // 21
  {
    titleHt: '🎓 Google Play pou etidyan yo!',
    bodyHt:  'Achte Google Play Gift Card — app edikasyon, jwèt, mizik ak plis!',
    titleEn: '🎓 Google Play for students!',
    bodyEn:  'Buy Google Play Gift Cards — education apps, games, music & more!',
    titleFr: '🎓 Google Play pour les étudiants!',
    bodyFr:  'Achetez des Google Play Gift Cards — apps éducatives, jeux, musique et plus!',
    titleEs: '🎓 ¡Google Play para estudiantes!',
    bodyEs:  '¡Compra Google Play Gift Cards — apps educativas, juegos, música y más!',
  },
  // 22
  {
    titleHt: '🏠 Peye fakti dlo ou!',
    bodyHt:  'Peye fakti CAMEP oswa SNEP dirèkteman nan BuyFast — pa gen deplaseman!',
    titleEn: '🏠 Pay your water bill!',
    bodyEn:  'Pay CAMEP or SNEP water bills directly on BuyFast — no need to travel!',
    titleFr: '🏠 Payez votre facture d\'eau!',
    bodyFr:  'Payez vos factures CAMEP ou SNEP directement sur BuyFast — sans vous déplacer!',
    titleEs: '🏠 ¡Paga tu factura de agua!',
    bodyEs:  '¡Paga facturas de CAMEP o SNEP directamente en BuyFast — sin necesidad de desplazarte!',
  },
  // 23
  {
    titleHt: '✈️ Fanmi ou nan dyaspora?',
    bodyHt:  'BuyFast pèmèt yo recharge ak voye lajan ann Ayiti menm depi lòt bò dlo!',
    titleEn: '✈️ Family in the diaspora?',
    bodyEn:  'BuyFast lets them top up and send money to Haiti even from abroad!',
    titleFr: '✈️ Famille dans la diaspora?',
    bodyFr:  'BuyFast leur permet de recharger et envoyer de l\'argent en Haïti même de l\'étranger!',
    titleEs: '✈️ ¿Familia en la diáspora?',
    bodyEs:  '¡BuyFast les permite recargar y enviar dinero a Haití incluso desde el extranjero!',
  },
  // 24
  {
    titleHt: '🎪 Evènman espesyal vini!',
    bodyHt:  'Gade seksyon Pwomosyon BuyFast — gen bèl kado ak surpriz k ap prepare!',
    titleEn: '🎪 Special events coming!',
    bodyEn:  'Check BuyFast Promotions — great gifts and surprises are being prepared!',
    titleFr: '🎪 Événements spéciaux à venir!',
    bodyFr:  'Consultez les Promotions BuyFast — de beaux cadeaux et surprises se préparent!',
    titleEs: '🎪 ¡Eventos especiales en camino!',
    bodyEs:  '¡Consulta Promociones BuyFast — se están preparando grandes regalos y sorpresas!',
  },
  // 25
  {
    titleHt: '📞 Rele fanmi ou pou mwens che!',
    bodyHt:  'Recharge telefòn fanmi ann Ayiti — entènèt ak apèl pi bon pri nan BuyFast!',
    titleEn: '📞 Call family for less!',
    bodyEn:  'Top up family phones in Haiti — internet & calls at the best price on BuyFast!',
    titleFr: '📞 Appelez votre famille moins cher!',
    bodyFr:  'Rechargez les téléphones de votre famille — internet et appels au meilleur prix!',
    titleEs: '📞 ¡Llama a tu familia por menos!',
    bodyEs:  '¡Recarga teléfonos familiares en Haití — internet y llamadas al mejor precio en BuyFast!',
  },
  // 26
  {
    titleHt: '💬 Bezwen èd? Chat avèk nou!',
    bodyHt:  'Ekip sipò BuyFast disponib 24/7. Klike sou bouton chat la pou pale avèk nou!',
    titleEn: '💬 Need help? Chat with us!',
    bodyEn:  'BuyFast support team is available 24/7. Tap the chat button to talk to us!',
    titleFr: '💬 Besoin d\'aide? Chattez avec nous!',
    bodyFr:  'L\'équipe de support BuyFast est disponible 24h/24. Cliquez sur le chat pour nous parler!',
    titleEs: '💬 ¿Necesitas ayuda? ¡Chatea con nosotros!',
    bodyEs:  '¡El equipo de soporte BuyFast está disponible 24/7. Toca el botón de chat para hablar!',
  },
  // 27
  {
    titleHt: '🎁 Cadeau pou yon moun ou renmen?',
    bodyHt:  'Gift Card Amazon, iTunes, Roblox, Minecraft — voye pa imèl an segonn!',
    titleEn: '🎁 A gift for someone special?',
    bodyEn:  'Amazon, iTunes, Roblox, Minecraft Gift Cards — send by email in seconds!',
    titleFr: '🎁 Un cadeau pour quelqu\'un de spécial?',
    bodyFr:  'Amazon, iTunes, Roblox, Minecraft — envoyez par email en quelques secondes!',
    titleEs: '🎁 ¿Un regalo para alguien especial?',
    bodyEs:  '¡Amazon, iTunes, Roblox, Minecraft Gift Cards — envía por email en segundos!',
  },
  // 28
  {
    titleHt: '🌈 Chak tranzaksyon konte!',
    bodyHt:  'Ak BuyFast, ou pa sèlman recharge — ou konstwi koneksyon ak fanmi w. Eseye!',
    titleEn: '🌈 Every transaction counts!',
    bodyEn:  'With BuyFast, you\'re not just topping up — you\'re building family connections!',
    titleFr: '🌈 Chaque transaction compte!',
    bodyFr:  'Avec BuyFast, vous ne rechargez pas seulement — vous renforcez les liens familiaux!',
    titleEs: '🌈 ¡Cada transacción cuenta!',
    bodyEs:  '¡Con BuyFast, no solo recargas — estás construyendo conexiones familiares!',
  },
  // 29
  {
    titleHt: '🚀 BuyFast — Pi vit pase tout!',
    bodyHt:  'Konfime tranzaksyon ou nan segonn, pa menm minit. Vitès pa gen konpetitè!',
    titleEn: '🚀 BuyFast — Faster than all!',
    bodyEn:  'Confirm your transaction in seconds, not minutes. Speed has no competition!',
    titleFr: '🚀 BuyFast — Plus rapide que tout!',
    bodyFr:  'Confirmez votre transaction en secondes, pas en minutes. La vitesse sans concurrence!',
    titleEs: '🚀 ¡BuyFast — Más rápido que todos!',
    bodyEs:  '¡Confirma tu transacción en segundos, no minutos. ¡La velocidad sin competencia!',
  },
  // 30
  {
    titleHt: '💎 Kliyan VIP BuyFast — Rejwan!',
    bodyHt:  'Fè plis tranzaksyon pou jwenn statit VIP — aksè priyoritè ak rabè eksklizif!',
    titleEn: '💎 BuyFast VIP Customer — Join!',
    bodyEn:  'Make more transactions to earn VIP status — priority access & exclusive discounts!',
    titleFr: '💎 Client VIP BuyFast — Rejoignez!',
    bodyFr:  'Effectuez plus de transactions pour obtenir le statut VIP — accès prioritaire et remises exclusives!',
    titleEs: '💎 ¡Cliente VIP BuyFast — Únete!',
    bodyEs:  '¡Haz más transacciones para obtener estatus VIP — acceso prioritario y descuentos exclusivos!',
  },
  // 31
  {
    titleHt: '🔥 Ofri chaud jounen an!',
    bodyHt:  'Pa manke pi bon ofri jounen an — tcheke paj pwomosyon BuyFast ou!',
    titleEn: '🔥 Hot deal of the day!',
    bodyEn:  'Don\'t miss the best deal of the day — check your BuyFast promotions page!',
    titleFr: '🔥 Offre chaude du jour!',
    bodyFr:  'Ne ratez pas la meilleure offre du jour — consultez votre page de promotions BuyFast!',
    titleEs: '🔥 ¡Oferta caliente del día!',
    bodyEs:  '¡No te pierdas la mejor oferta del día — revisa tu página de promociones BuyFast!',
  },
  // 32
  {
    titleHt: '🌺 Dimanch, jou pou fanmi!',
    bodyHt:  'Profite jounen fanmi a — voye yon ti recharge kòm yon siy damo w!',
    titleEn: '🌺 Sunday, family day!',
    bodyEn:  'Enjoy family time — send a little top-up as a sign of your love!',
    titleFr: '🌺 Dimanche, jour de famille!',
    bodyFr:  'Profitez du temps en famille — envoyez une petite recharge comme signe d\'amour!',
    titleEs: '🌺 ¡Domingo, día de familia!',
    bodyEs:  '¡Disfruta el tiempo familiar — envía una pequeña recarga como señal de amor!',
  },
  // 33
  {
    titleHt: '📈 Plis tranzaksyon = plis bonis!',
    bodyHt:  'Sistèm fidèlite BuyFast ba ou rekonpans sou chak achè. Kòmanse kounye a!',
    titleEn: '📈 More transactions = more bonuses!',
    bodyEn:  'BuyFast loyalty system rewards you on every purchase. Start now!',
    titleFr: '📈 Plus de transactions = plus de bonus!',
    bodyFr:  'Le système de fidélité BuyFast vous récompense sur chaque achat. Commencez maintenant!',
    titleEs: '📈 ¡Más transacciones = más bonos!',
    bodyEs:  '¡El sistema de fidelidad BuyFast te premia en cada compra. ¡Empieza ahora!',
  },
  // 34
  {
    titleHt: '🛡️ 2FA - Pwoteje kont ou!',
    bodyHt:  'Aktive otantifikasyon 2 faktè pou yon sekirite maksimòm sou kont BuyFast ou!',
    titleEn: '🛡️ 2FA - Protect your account!',
    bodyEn:  'Enable two-factor authentication for maximum security on your BuyFast account!',
    titleFr: '🛡️ 2FA - Protégez votre compte!',
    bodyFr:  'Activez l\'authentification à 2 facteurs pour une sécurité maximale sur BuyFast!',
    titleEs: '🛡️ ¡2FA - Protege tu cuenta!',
    bodyEs:  '¡Activa la autenticación de 2 factores para máxima seguridad en tu cuenta BuyFast!',
  },
  // 35
  {
    titleHt: '🌙 Yon dènye ti bagay...',
    bodyHt:  'Recharge vit avan demen — fanmi ou ap kontan wè mesaj la maten an!',
    titleEn: '🌙 One last thing...',
    bodyEn:  'Quick top-up before tomorrow — your family will love waking up to it!',
    titleFr: '🌙 Une dernière chose...',
    bodyFr:  'Une recharge rapide avant demain — votre famille adorera se réveiller avec ça!',
    titleEs: '🌙 Una última cosa...',
    bodyEs:  '¡Recarga rápida antes de mañana — tu familia amará despertarse con eso!',
  },
];

/**
 * Send engagement notification every 20 minutes
 * Picks message based on (hour * 3 + minuteSlot) % pool.length
 */
export async function sendTwentyMinuteNotification(): Promise<{ success: number; failed: number }> {
  try {
    const haitiNow  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Port-au-Prince' }));
    const hour      = haitiNow.getHours();
    const minute    = haitiNow.getMinutes();
    const minuteSlot = minute < 20 ? 0 : minute < 40 ? 1 : 2;
    const poolIndex  = (hour * 3 + minuteSlot) % TWENTY_MIN_NOTIFICATION_POOL.length;
    const msg        = TWENTY_MIN_NOTIFICATION_POOL[poolIndex];

    console.log(`⏱️ 20-min notification — Haiti ${hour}:${String(minute).padStart(2,'0')} — slot ${poolIndex} — "${msg.titleEn}"`);

    const deviceTokens = await storage.getAllActiveDeviceTokens();
    if (deviceTokens.length === 0) {
      console.log('📭 20-min notification: no active tokens');
      return { success: 0, failed: 0 };
    }

    const allUsers = await storage.getAllUsers();
    const userMap  = new Map(allUsers.map((u: any) => [u.id, u]));

    const byLang: Map<string, string[]> = new Map();
    for (const dt of deviceTokens) {
      const lang     = (userMap.get(dt.userId) as any)?.language || 'en';
      const supported = ['ht', 'en', 'fr', 'es'].includes(lang) ? lang : 'en';
      if (!byLang.has(supported)) byLang.set(supported, []);
      byLang.get(supported)!.push(dt.token);
    }

    const { sendBulkPushNotifications } = await import('../services/fcmService');

    let totalSuccess = 0;
    let totalFailed  = 0;

    for (const [lang, tokens] of Array.from(byLang.entries())) {
      let title: string, body: string;
      if (lang === 'ht')      { title = msg.titleHt; body = msg.bodyHt; }
      else if (lang === 'fr') { title = msg.titleFr; body = msg.bodyFr; }
      else if (lang === 'es') { title = msg.titleEs; body = msg.bodyEs; }
      else                    { title = msg.titleEn; body = msg.bodyEn; }

      console.log(`🌍 [${lang.toUpperCase()}] Sending ${tokens.length} 20-min notifications`);
      const result = await sendBulkPushNotifications(tokens, { title, body, clickAction: '/' });
      totalSuccess += result.success;
      totalFailed  += result.failed;
    }

    console.log(`✅ 20-min notification done — ${totalSuccess} sent, ${totalFailed} failed`);
    return { success: totalSuccess, failed: totalFailed };

  } catch (err: any) {
    console.error('❌ 20-min notification error (non-critical):', err.message || err);
    return { success: 0, failed: 0 };
  }
}

/**
 * Start the 20-minute engagement notification scheduler
 * Fires at :00, :20, :40 of every hour — Haiti time
 */
export function startTwentyMinuteScheduler(): void {
  if (twentyMinCronJob) {
    console.log('⚠️ 20-min scheduler already running');
    return;
  }

  console.log('⏱️ Starting 20-minute engagement notification scheduler');

  twentyMinCronJob = cron.schedule('*/20 * * * *', async () => {
    try {
      await sendTwentyMinuteNotification();
    } catch (err: any) {
      console.error('❌ 20-min cron error (non-critical):', err.message || err);
    }
  }, { timezone: 'America/Port-au-Prince' });

  console.log('✅ 20-minute scheduler started — fires at :00, :20, :40 every hour Haiti time');
}

/**
 * Stop the 20-minute scheduler
 */
export function stopTwentyMinuteScheduler(): void {
  if (twentyMinCronJob) {
    twentyMinCronJob.stop();
    twentyMinCronJob.destroy();
    twentyMinCronJob = null;
    console.log('🛑 20-minute scheduler stopped');
  }
}

/**
 * Start the FCM notification cron job
 */
export function startFCMScheduler(): void {
  if (fcmCronJob) {
    console.log('⚠️ FCM scheduler already running');
    return;
  }

  console.log('🕐 Starting FCM notification scheduler - 9 AM, 3 PM, 9 PM Haiti time');

  // Schedule: 9 AM, 3 PM, 9 PM Haiti time (America/Port-au-Prince)
  // Avoids sending at midnight or 1 AM which would wake users up
  fcmCronJob = cron.schedule('0 9,15,21 * * *', async () => {
    const haitiTime = new Date().toLocaleString('en-US', { timeZone: 'America/Port-au-Prince' });
    console.log(`🔔 FCM Cron Job: Starting reminder notifications (Haiti: ${haitiTime})...`);
    
    try {
      // Initialize templates if needed
      await fcmService.initializeNotificationTemplates();

      // Send reminder notifications to all users
      const result = await fcmService.sendReminderNotifications();

      console.log('✅ FCM Cron Job completed:', {
        success: result.success,
        failed: result.failed,
        time: new Date().toISOString()
      });

      // Log any errors
      if (result.errors.length > 0) {
        console.log('⚠️ FCM Cron Job errors:', result.errors);
      }

    } catch (error: any) {
      console.error('❌ FCM Cron Job failed (non-critical):', error.message || error);
      // Don't let cron errors crash the app
    }
  }, { timezone: 'America/Port-au-Prince' });

  console.log('✅ FCM notification scheduler started - 9 AM / 3 PM / 9 PM Haiti time');
}

/**
 * Start the FCM token renewal cron job
 * Runs every 12 hours to keep tokens fresh
 */
export function startTokenRenewalScheduler(): void {
  if (tokenRenewalCronJob) {
    console.log('⚠️ Token renewal scheduler already running');
    return;
  }

  console.log('🔄 Starting FCM token renewal scheduler - 6 AM and 6 PM Haiti time');

  // Schedule: 6 AM and 6 PM Haiti time (America/Port-au-Prince)
  tokenRenewalCronJob = cron.schedule('0 6,18 * * *', async () => {
    console.log('🔄 Token Renewal Cron Job: Starting token refresh...');
    
    try {
      // Renew expired tokens
      const renewalResult = await fcmTokenRenewal.renewExpiredTokens();
      console.log('✅ Token renewal completed:', renewalResult);

      // Send keepalive pings
      await fcmTokenRenewal.sendKeepalivePings();

    } catch (error: any) {
      console.error('❌ Token renewal cron job failed (non-critical):', error.message || error);
      // Don't let cron errors crash the app
    }
  }, { timezone: 'America/Port-au-Prince' });

  console.log('✅ FCM token renewal scheduler started - 6 AM / 6 PM Haiti time');
}

/**
 * Start the token cleanup cron job
 * Runs daily to remove old inactive tokens
 */
export function startTokenCleanupScheduler(): void {
  if (tokenCleanupCronJob) {
    console.log('⚠️ Token cleanup scheduler already running');
    return;
  }

  console.log('🧹 Starting token cleanup scheduler - daily at 3 AM Haiti time');

  // Schedule: Daily at 3 AM Haiti time (America/Port-au-Prince)
  tokenCleanupCronJob = cron.schedule('0 3 * * *', async () => {
    console.log('🧹 Token Cleanup Cron Job: Starting cleanup...');
    
    try {
      const deletedCount = await fcmTokenRenewal.cleanupOldTokens();
      console.log(`✅ Token cleanup completed: ${deletedCount} tokens removed`);

    } catch (error: any) {
      console.error('❌ Token cleanup cron job failed (non-critical):', error.message || error);
      // Don't let cron errors crash the app
    }
  }, { timezone: 'America/Port-au-Prince' });

  console.log('✅ Token cleanup scheduler started - daily at 3 AM Haiti time');
}

/**
 * Send the hourly engagement notification based on current Haiti time
 * Picks the right message (0-23) from HOURLY_NOTIFICATIONS and sends it
 * to all active users in their preferred language.
 */
export async function sendHourlyEngagementNotification(): Promise<{ success: number; failed: number }> {
  try {
    const haitiNow = new Date().toLocaleString('en-US', { timeZone: 'America/Port-au-Prince' });
    const hour = new Date(haitiNow).getHours(); // 0-23
    const msg = HOURLY_NOTIFICATIONS[hour];

    console.log(`🕐 Hourly notification — Haiti hour ${hour}:00 — sending "${msg.titleEn}"`);

    const deviceTokens = await storage.getAllActiveDeviceTokens();
    if (deviceTokens.length === 0) {
      console.log('📭 Hourly notification: no active tokens found');
      return { success: 0, failed: 0 };
    }

    const allUsers = await storage.getAllUsers();
    const userMap = new Map(allUsers.map((u: any) => [u.id, u]));

    const byLang: Map<string, string[]> = new Map();
    for (const dt of deviceTokens) {
      const lang = (userMap.get(dt.userId) as any)?.language || 'en';
      const supported = ['ht', 'en', 'fr', 'es'].includes(lang) ? lang : 'en';
      if (!byLang.has(supported)) byLang.set(supported, []);
      byLang.get(supported)!.push(dt.token);
    }

    const { sendBulkPushNotifications } = await import('../services/fcmService');

    let totalSuccess = 0;
    let totalFailed = 0;

    for (const [lang, tokens] of Array.from(byLang.entries())) {
      let title: string, body: string;
      if (lang === 'ht')      { title = msg.titleHt; body = msg.bodyHt; }
      else if (lang === 'fr') { title = msg.titleFr; body = msg.bodyFr; }
      else if (lang === 'es') { title = msg.titleEs; body = msg.bodyEs; }
      else                    { title = msg.titleEn; body = msg.bodyEn; }

      console.log(`🌍 [${lang.toUpperCase()}] Sending ${tokens.length} hourly notifications`);
      const result = await sendBulkPushNotifications(tokens, { title, body, clickAction: '/' });
      totalSuccess += result.success;
      totalFailed  += result.failed;
    }

    console.log(`✅ Hourly notification done — ${totalSuccess} sent, ${totalFailed} failed`);
    return { success: totalSuccess, failed: totalFailed };

  } catch (err: any) {
    console.error('❌ Hourly notification error (non-critical):', err.message || err);
    return { success: 0, failed: 0 };
  }
}

/**
 * Start the hourly engagement notification scheduler
 * Fires at the top of every hour (00:00, 01:00, … 23:00) — Haiti time
 */
export function startHourlyNotificationScheduler(): void {
  if (hourlyNotificationCronJob) {
    console.log('⚠️ Hourly notification scheduler already running');
    return;
  }

  console.log('⏰ Starting hourly engagement notification scheduler (every hour, Haiti time)');

  hourlyNotificationCronJob = cron.schedule('0 * * * *', async () => {
    try {
      await sendHourlyEngagementNotification();
    } catch (err: any) {
      console.error('❌ Hourly cron error (non-critical):', err.message || err);
    }
  }, { timezone: 'America/Port-au-Prince' });

  console.log('✅ Hourly engagement scheduler started — fires every hour 00h→23h Haiti time');
}

/**
 * Send a targeted promo push notification for a specific service.
 * Looks up the best active discount code for that service and broadcasts it.
 */
export async function sendDailyPromoNotification(serviceType: string): Promise<{ success: number; failed: number }> {
  try {
    const tmpl = PROMO_NOTIFICATION_TEMPLATES[serviceType];
    if (!tmpl) {
      console.warn(`⚠️ No promo template for service: ${serviceType}`);
      return { success: 0, failed: 0 };
    }

    console.log(`🎟️ Daily promo push — service: ${serviceType}`);

    // 1️⃣ Auto-generate a promo code if none exists for today
    const autoCode = await autoGeneratePromoCode(serviceType);

    // 2️⃣ Find the best active code (auto-generated takes priority, then admin-created)
    const allCodes = await storage.getAllDiscountCodes();
    const now = new Date();
    const bestCode = allCodes
      .filter(c =>
        c.isActive &&
        new Date(c.expiresAt) > now &&
        (c.currentUses || 0) < (c.maxUses || 9999) &&
        (c.applicableTo === serviceType || c.applicableTo === 'all')
      )
      .sort((a, b) => {
        // Prefer auto-generated code of the day first
        if (autoCode && a.code === autoCode.code) return -1;
        if (autoCode && b.code === autoCode.code) return 1;
        return parseFloat(b.discountValue) - parseFloat(a.discountValue);
      })[0];

    const codeText = bestCode ? bestCode.code : (autoCode?.code || 'BUYFAST');
    const valText  = bestCode
      ? (bestCode.discountType === 'percentage' ? `${bestCode.discountValue}%` : `$${bestCode.discountValue}`)
      : (autoCode?.discountValue || '10%');

    const replace = (s: string) =>
      s.replace(/\[{CODE}]/g, codeText).replace(/\{VAL}/g, valText);

    // Get all active device tokens grouped by user language
    const deviceTokens = await storage.getAllActiveDeviceTokens();
    if (deviceTokens.length === 0) {
      console.log(`📭 No active tokens for promo: ${serviceType}`);
      return { success: 0, failed: 0 };
    }

    const allUsers = await storage.getAllUsers();
    const userMap = new Map(allUsers.map((u: any) => [u.id, u]));

    const byLang: Map<string, string[]> = new Map();
    for (const dt of deviceTokens) {
      const lang = (userMap.get(dt.userId) as any)?.language || 'en';
      const supported = ['ht', 'en', 'fr', 'es'].includes(lang) ? lang : 'en';
      if (!byLang.has(supported)) byLang.set(supported, []);
      byLang.get(supported)!.push(dt.token);
    }

    const { sendBulkPushNotifications } = await import('../services/fcmService');

    let totalSuccess = 0;
    let totalFailed  = 0;

    for (const [lang, tokens] of Array.from(byLang.entries())) {
      let title: string, body: string;
      if (lang === 'ht')      { title = replace(tmpl.titleHt); body = replace(tmpl.bodyHt); }
      else if (lang === 'fr') { title = replace(tmpl.titleFr); body = replace(tmpl.bodyFr); }
      else if (lang === 'es') { title = replace(tmpl.titleEs); body = replace(tmpl.bodyEs); }
      else                    { title = replace(tmpl.titleEn); body = replace(tmpl.bodyEn); }

      console.log(`🌍 [${lang.toUpperCase()}] Sending ${tokens.length} promo notifications for ${serviceType}`);
      const promoExpiresAt = bestCode?.expiresAt ? new Date(bestCode.expiresAt).toISOString() : '';
      const result = await sendBulkPushNotifications(tokens, {
        title,
        body,
        clickAction: tmpl.route,
        data: {
          type: 'promotion',
          promoCode: codeText,
          expiresAt: promoExpiresAt,
          service: serviceType,
        },
      });
      totalSuccess += result.success;
      totalFailed  += result.failed;
    }

    console.log(`✅ Daily promo [${serviceType}] — ${totalSuccess} sent, ${totalFailed} failed`);
    return { success: totalSuccess, failed: totalFailed };

  } catch (err: any) {
    console.error(`❌ Daily promo notification error [${serviceType}]:`, err.message || err);
    return { success: 0, failed: 0 };
  }
}

/**
 * Start the daily promo scheduler — fires 7 times per day at specific hours (Haiti time)
 * Hour → Service:  7=topup, 9=add-funds, 11=bill-payment, 13=gift-card, 15=natcash, 17=moncash, 19=guest-topup
 */
export function startDailyPromoScheduler(): void {
  if (dailyPromoCronJob) {
    console.log('⚠️ Daily promo scheduler already running');
    return;
  }

  const promoHours = DAILY_PROMO_SCHEDULE.map(s => s.hour).join(',');
  console.log(`🎟️ Starting daily promo scheduler — hours ${promoHours} Haiti time`);

  dailyPromoCronJob = cron.schedule(`0 ${promoHours} * * *`, async () => {
    try {
      const haitiNow  = new Date().toLocaleString('en-US', { timeZone: 'America/Port-au-Prince' });
      const hour      = new Date(haitiNow).getHours();
      const slot      = DAILY_PROMO_SCHEDULE.find(s => s.hour === hour);
      if (!slot) return;

      console.log(`🎟️ Daily promo cron fired — hour ${hour} → service ${slot.service}`);
      await sendDailyPromoNotification(slot.service);
    } catch (err: any) {
      console.error('❌ Daily promo cron error (non-critical):', err.message || err);
    }
  }, { timezone: 'America/Port-au-Prince' });

  console.log(`✅ Daily promo scheduler started — 7 promos/day (7h/9h/11h/13h/15h/17h/19h Haiti)`);
}

/**
 * Send personalized referral push notifications to all active users.
 * Each user receives a message containing their unique referral code.
 * Clicking the notification opens the /invite page.
 * Multilingual: HT / EN / FR / ES
 */
export async function sendReferralNotifications(): Promise<{ success: number; failed: number }> {
  try {
    console.log('⭐ Referral notification job — fetching users and tokens...');

    const allUsers = await storage.getAllUsers();
    const deviceTokens = await storage.getAllActiveDeviceTokens();

    if (deviceTokens.length === 0) {
      console.log('📭 Referral notification: no active tokens found');
      return { success: 0, failed: 0 };
    }

    const userMap = new Map(allUsers.map((u: any) => [u.id, u]));

    const { sendPushNotification } = await import('../services/fcmService');

    let totalSuccess = 0;
    let totalFailed = 0;

    for (const dt of deviceTokens) {
      const user = userMap.get(dt.userId) as any;
      if (!user) continue;

      const referralCode: string = user.referralCode || '';
      if (!referralCode) continue;

      const lang = ['ht', 'en', 'fr', 'es'].includes(user.language || '') ? user.language : 'en';
      const referralLink = `https://buyfasttopup.com/invite?ref=${referralCode}`;

      let title: string;
      let body: string;

      if (lang === 'ht') {
        title = '⭐ Pataje kòd referans ou — Touche bonis!';
        body = `Kòd pa ou: ${referralCode}. Envite zanmi ou epi touche bonis fidèlite ansanm! Klike pou kopye lyen an.`;
      } else if (lang === 'fr') {
        title = '⭐ Partagez votre code parrainage — Gagnez des bonus!';
        body = `Votre code: ${referralCode}. Invitez vos amis et gagnez des bonus ensemble! Cliquez pour copier le lien.`;
      } else if (lang === 'es') {
        title = '⭐ Comparte tu código de referido — ¡Gana bonos!';
        body = `Tu código: ${referralCode}. ¡Invita amigos y gana bonos juntos! Haz clic para copiar el enlace.`;
      } else {
        title = '⭐ Share Your Referral Code — Earn Bonuses!';
        body = `Your code: ${referralCode}. Invite friends and earn loyalty bonuses together! Tap to copy your link.`;
      }

      const sent = await sendPushNotification(dt.token, {
        title,
        body,
        clickAction: '/invite',
        data: {
          route: '/invite',
          referralCode,
          referralLink,
          type: 'referral',
        },
      });

      if (sent) totalSuccess++;
      else totalFailed++;
    }

    console.log(`✅ Referral notifications done — ${totalSuccess} sent, ${totalFailed} failed`);
    return { success: totalSuccess, failed: totalFailed };

  } catch (err: any) {
    console.error('❌ sendReferralNotifications error (non-critical):', err.message || err);
    return { success: 0, failed: 0 };
  }
}

/**
 * Start the referral notification scheduler.
 * Fires at 10 AM and 6 PM Haiti time every day.
 */
export function startReferralNotificationScheduler(): void {
  if (referralNotificationCronJob) {
    console.log('⚠️ Referral notification scheduler already running');
    return;
  }

  console.log('⭐ Starting referral notification scheduler — 10 AM & 6 PM Haiti time');

  referralNotificationCronJob = cron.schedule('0 10,18 * * *', async () => {
    try {
      const haitiTime = new Date().toLocaleString('en-US', { timeZone: 'America/Port-au-Prince' });
      console.log(`⭐ Referral cron fired — Haiti time: ${haitiTime}`);
      await sendReferralNotifications();
    } catch (err: any) {
      console.error('❌ Referral cron error (non-critical):', err.message || err);
    }
  }, { timezone: 'America/Port-au-Prince' });

  console.log('✅ Referral notification scheduler started — fires at 10h00 & 18h00 Haiti time');
}

export function startAllFCMSchedulers(): void {
  startFCMScheduler();
  startTokenRenewalScheduler();
  startTokenCleanupScheduler();
  startHourlyNotificationScheduler();
  startTwentyMinuteScheduler();
  startDailyPromoScheduler();
  startReferralNotificationScheduler();
  startPersonalizedDailyScheduler();
  startHolidayScheduler();
  console.log('✅ All FCM schedulers started (including 20-min, personalized, holiday & referral)');
}

/**
 * Stop the FCM notification cron job
 */
export function stopFCMScheduler(): void {
  if (fcmCronJob) {
    fcmCronJob.stop();
    fcmCronJob.destroy();
    fcmCronJob = null;
    console.log('🛑 FCM notification scheduler stopped');
  }
}

/**
 * Stop the token renewal scheduler
 */
export function stopTokenRenewalScheduler(): void {
  if (tokenRenewalCronJob) {
    tokenRenewalCronJob.stop();
    tokenRenewalCronJob.destroy();
    tokenRenewalCronJob = null;
    console.log('🛑 Token renewal scheduler stopped');
  }
}

/**
 * Stop the token cleanup scheduler
 */
export function stopTokenCleanupScheduler(): void {
  if (tokenCleanupCronJob) {
    tokenCleanupCronJob.stop();
    tokenCleanupCronJob.destroy();
    tokenCleanupCronJob = null;
    console.log('🛑 Token cleanup scheduler stopped');
  }
}

/**
 * Stop all FCM schedulers
 */
export function stopAllFCMSchedulers(): void {
  stopFCMScheduler();
  stopTokenRenewalScheduler();
  stopTokenCleanupScheduler();
  stopTestNotificationScheduler();
  console.log('✅ All FCM schedulers stopped');
}

/**
 * Send immediate test notification (manual trigger)
 */
export async function triggerManualNotification(): Promise<any> {
  console.log('🧪 Manual FCM notification triggered');
  
  try {
    // Initialize templates if needed
    await fcmService.initializeNotificationTemplates();

    // Send reminder notifications
    const result = await fcmService.sendReminderNotifications();

    console.log('✅ Manual FCM notification completed:', {
      success: result.success,
      failed: result.failed,
      time: new Date().toISOString()
    });

    return result;

  } catch (error: any) {
    console.error('❌ Manual FCM notification failed:', error);
    return {
      success: 0,
      failed: 0,
      errors: [error.message]
    };
  }
}

/**
 * Get FCM scheduler status
 */
export function getFCMSchedulerStatus(): { running: boolean; nextRun?: string } {
  if (!fcmCronJob) {
    return { running: false };
  }

  return {
    running: true
    // nextRun: fcmCronJob.nextDate()?.toISOString() // ❌ nextDate() not available in this version
  };
}

/**
 * Send welcome notification to new user
 */
export async function sendWelcomeNotification(userId: string): Promise<boolean> {
  try {
    console.log(`👋 Sending welcome notification to user: ${userId}`);

    const result = await fcmService.sendUserNotification(userId, {
      title: 'Welcome to BuyFast TopUp!',
      body: 'Start saving on international mobile recharges today. Your wallet is ready!',
      clickAction: '/dashboard'
    });

    console.log(`✅ Welcome notification sent to user ${userId}:`, result);
    return result;

  } catch (error: any) {
    console.error('❌ Welcome notification failed:', error);
    return false;
  }
}

/**
 * Send transaction notification
 */
// ─── Multilingual notification messages ────────────────────────────────────

type Lang = 'en' | 'fr' | 'ht' | 'es';

function getUserLang(raw?: string | null): Lang {
  const l = (raw || 'en').toLowerCase();
  return (['en','fr','ht','es'].includes(l) ? l : 'en') as Lang;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', HTG: 'G', EUR: '€', GBP: '£', JPY: '¥',
  CAD: 'C$', AUD: 'A$', BRL: 'R$', MXN: 'MX$', DOP: 'RD$', INR: '₹',
};

const HTG_FIXED_RATE = 132;

/**
 * Convert a USD amount string into the user's preferred currency display.
 * Returns e.g. "$1.89" for USD, "G 249.48" for HTG, "€1.73" for EUR.
 */
async function formatAmountForUser(userId: string, usdAmountStr: string): Promise<string> {
  try {
    const user = await storage.getUser(userId);
    const currency = user?.preferredCurrency;
    if (!currency || currency === 'USD') {
      return `$${parseFloat(usdAmountStr).toFixed(2)}`;
    }
    const sym = CURRENCY_SYMBOLS[currency] || `${currency} `;
    const usd = parseFloat(usdAmountStr);
    if (currency === 'HTG') {
      return `${sym}${(usd * HTG_FIXED_RATE).toFixed(2)}`;
    }
    const rate = await storage.getExchangeRate(currency);
    if (rate?.rateToUSD) {
      return `${sym}${(usd * parseFloat(rate.rateToUSD)).toFixed(2)}`;
    }
    return `$${usd.toFixed(2)}`;
  } catch {
    return `$${parseFloat(usdAmountStr).toFixed(2)}`;
  }
}

/** Localized topup messages */
const TOPUP_MSGS: Record<string, Record<Lang, { title: string; body: (a: string, r?: string) => string }>> = {
  success: {
    en: { title: 'Transaction Successful! 🎉', body: (a,r) => `Your ${a} top-up${r ? ` to ${r}` : ''} was completed successfully.` },
    fr: { title: 'Transaction Réussie ! 🎉',   body: (a,r) => `Votre recharge de ${a}${r ? ` vers ${r}` : ''} a été effectuée avec succès.` },
    ht: { title: 'Tranzaksyon Reyisi! 🎉',     body: (a,r) => `Recharge ${a}${r ? ` pou ${r}` : ''} ou fini avèk siksè.` },
    es: { title: '¡Transacción Exitosa! 🎉',   body: (a,r) => `Su recarga de ${a}${r ? ` a ${r}` : ''} se completó exitosamente.` },
  },
  failed: {
    en: { title: 'Transaction Failed ❌',       body: (a,r) => `Your ${a} top-up${r ? ` to ${r}` : ''} could not be processed. Please try again.` },
    fr: { title: 'Transaction Échouée ❌',      body: (a,r) => `Votre recharge de ${a}${r ? ` vers ${r}` : ''} n'a pas pu être traitée. Veuillez réessayer.` },
    ht: { title: 'Tranzaksyon Echwe ❌',        body: (a,r) => `Recharge ${a}${r ? ` pou ${r}` : ''} pa te kapab trete. Tanpri eseye ankò.` },
    es: { title: 'Transacción Fallida ❌',      body: (a,r) => `Su recarga de ${a}${r ? ` a ${r}` : ''} no pudo procesarse. Por favor intente de nuevo.` },
  },
  pending: {
    en: { title: 'Transaction Pending ⏳',      body: (a,r) => `Your ${a} top-up${r ? ` to ${r}` : ''} is being processed. We'll notify you when complete.` },
    fr: { title: 'Transaction en Cours ⏳',     body: (a,r) => `Votre recharge de ${a}${r ? ` vers ${r}` : ''} est en cours. Nous vous notifierons dès qu'elle sera complète.` },
    ht: { title: 'Tranzaksyon ap Trete ⏳',     body: (a,r) => `Recharge ${a}${r ? ` pou ${r}` : ''} ap trete. N ap avèti ou lè li fini.` },
    es: { title: 'Transacción Pendiente ⏳',    body: (a,r) => `Su recarga de ${a}${r ? ` a ${r}` : ''} está siendo procesada. Le notificaremos cuando esté completa.` },
  },
};

/** Localized payment messages for other transaction types */
const PAYMENT_MSGS: Record<string, Record<Lang, { title: string; body: (a: string, r?: string) => string }>> = {
  bill: {
    en: { title: 'Bill Payment Successful! 🧾', body: (a,r) => `Your ${a} bill payment${r ? ` for ${r}` : ''} was processed successfully.` },
    fr: { title: 'Paiement de Facture Réussi ! 🧾', body: (a,r) => `Votre paiement de facture de ${a}${r ? ` pour ${r}` : ''} a été traité avec succès.` },
    ht: { title: 'Pèman Fakti Reyisi! 🧾',     body: (a,r) => `Pèman fakti ${a}${r ? ` pou ${r}` : ''} ou fini avèk siksè.` },
    es: { title: '¡Pago de Factura Exitoso! 🧾', body: (a,r) => `Su pago de factura de ${a}${r ? ` para ${r}` : ''} se procesó exitosamente.` },
  },
  giftcard: {
    en: { title: 'Gift Card Purchased! 🎁',     body: (a) => `Your ${a} gift card is ready. Check your email for the code.` },
    fr: { title: 'Carte Cadeau Achetée ! 🎁',   body: (a) => `Votre carte cadeau de ${a} est prête. Vérifiez votre email pour le code.` },
    ht: { title: 'Kat Kado Achte! 🎁',          body: (a) => `Kat kado ${a} ou prêt. Verifye imèl ou pou jwenn kòd la.` },
    es: { title: '¡Tarjeta de Regalo Comprada! 🎁', body: (a) => `Su tarjeta de regalo de ${a} está lista. Revise su correo para el código.` },
  },
  natcash: {
    en: { title: 'NatCash Transfer Submitted! 📤', body: (a,r) => `Your ${a} transfer${r ? ` to ${r}` : ''} is being processed. Ready in 10-15 min.` },
    fr: { title: 'Transfert NatCash Soumis ! 📤',  body: (a,r) => `Votre transfert de ${a}${r ? ` vers ${r}` : ''} est en cours. Prêt dans 10-15 min.` },
    ht: { title: 'Transfert NatCash Voye! 📤',     body: (a,r) => `Transfert ${a}${r ? ` pou ${r}` : ''} ap trete. Prêt nan 10-15 minit.` },
    es: { title: '¡Transferencia NatCash Enviada! 📤', body: (a,r) => `Su transferencia de ${a}${r ? ` a ${r}` : ''} está siendo procesada. Lista en 10-15 min.` },
  },
  moncash: {
    en: { title: 'MonCash Transfer Submitted! 📤', body: (a,r) => `Your ${a} transfer${r ? ` to ${r}` : ''} is being processed. Ready in 10-15 min.` },
    fr: { title: 'Transfert MonCash Soumis ! 📤',  body: (a,r) => `Votre transfert de ${a}${r ? ` vers ${r}` : ''} est en cours. Prêt dans 10-15 min.` },
    ht: { title: 'Transfert MonCash Voye! 📤',     body: (a,r) => `Transfert ${a}${r ? ` pou ${r}` : ''} ap trete. Prêt nan 10-15 minit.` },
    es: { title: '¡Transferencia MonCash Enviada! 📤', body: (a,r) => `Su transferencia de ${a}${r ? ` a ${r}` : ''} está siendo procesada. Lista en 10-15 min.` },
  },
  wallet: {
    en: { title: 'Wallet Funded! 💰',             body: (a) => `${a} has been added to your BuyFast wallet successfully.` },
    fr: { title: 'Portefeuille Approvisionné ! 💰', body: (a) => `${a} ont été ajoutés à votre portefeuille BuyFast.` },
    ht: { title: 'Pòtfèy Chaje! 💰',              body: (a) => `${a} ajoute nan pòtfèy BuyFast ou avèk siksè.` },
    es: { title: '¡Billetera Recargada! 💰',        body: (a) => `${a} han sido agregados a su billetera BuyFast exitosamente.` },
  },
  pick: {
    en: { title: 'BuyFast Pick Request! 🏪',      body: (a,r) => `Your ${a} cash pick${r ? ` to ${r}` : ''} has been submitted.` },
    fr: { title: 'Demande BuyFast Pick ! 🏪',      body: (a,r) => `Votre demande de retrait de ${a}${r ? ` pour ${r}` : ''} a été soumise.` },
    ht: { title: 'Demann BuyFast Pick! 🏪',        body: (a,r) => `Demann retray ${a}${r ? ` pou ${r}` : ''} ou soumèt.` },
    es: { title: '¡Solicitud BuyFast Pick! 🏪',    body: (a,r) => `Su solicitud de retiro de ${a}${r ? ` a ${r}` : ''} ha sido enviada.` },
  },
  usdt: {
    en: { title: 'USDT Deposit Confirmed! ₿✅',   body: (a) => `Your crypto deposit of ${a} via USDT TRC20 has been confirmed. Your wallet is now funded!` },
    fr: { title: 'Dépôt USDT Confirmé ! ₿✅',     body: (a) => `Votre dépôt crypto de ${a} via USDT TRC20 a été confirmé. Votre portefeuille est maintenant approvisionné !` },
    ht: { title: 'Depo USDT Konfime! ₿✅',         body: (a) => `Depo krypto ${a} ou via USDT TRC20 konfime. Pòtfèy BuyFast ou chaje kounye a!` },
    es: { title: '¡Depósito USDT Confirmado! ₿✅', body: (a) => `Su depósito cripto de ${a} vía USDT TRC20 ha sido confirmado. ¡Su billetera está recargada!` },
  },
  pix: {
    en: { title: 'PIX Deposit Confirmed! 🇧🇷✅',   body: (a) => `Your PIX deposit of ${a} has been confirmed. Your BuyFast wallet is now funded!` },
    fr: { title: 'Dépôt PIX Confirmé ! 🇧🇷✅',     body: (a) => `Votre dépôt PIX de ${a} a été confirmé. Votre portefeuille BuyFast est approvisionné !` },
    ht: { title: 'Depo PIX Konfime! 🇧🇷✅',         body: (a) => `Depo PIX ${a} ou konfime. Pòtfèy BuyFast ou chaje kounye a!` },
    es: { title: '¡Depósito PIX Confirmado! 🇧🇷✅', body: (a) => `Su depósito PIX de ${a} ha sido confirmado. ¡Su billetera BuyFast está recargada!` },
  },
};

// ─── Notification senders ──────────────────────────────────────────────────

export async function sendTransactionNotification(
  userId: string,
  type: 'success' | 'failed' | 'pending' | 'successful',
  amount: string,
  recipient?: string
): Promise<boolean> {
  try {
    const user = await storage.getUser(userId);
    const lang = getUserLang(user?.language);
    const normalizedType = type === 'successful' ? 'success' : type;
    const msgs = TOPUP_MSGS[normalizedType] || TOPUP_MSGS.success;
    const { title, body: bodyFn } = msgs[lang];
    const formattedAmount = await formatAmountForUser(userId, amount);
    const body = bodyFn(formattedAmount, recipient);
    const clickAction = '/history';

    console.log(`📱 Sending ${type} topup notification (${lang}) to user: ${userId}`);
    const result = await fcmService.sendUserNotification(userId, { title, body, clickAction });
    console.log(`✅ Transaction notification sent to user ${userId}:`, result);

    try {
      await storage.createNotification({
        titleEn: msgs.en.title,
        titleFr: msgs.fr.title,
        titleHt: msgs.ht.title,
        titleEs: msgs.es.title,
        messageEn: msgs.en.body(formattedAmount, recipient),
        messageFr: msgs.fr.body(formattedAmount, recipient),
        messageHt: msgs.ht.body(formattedAmount, recipient),
        messageEs: msgs.es.body(formattedAmount, recipient),
        type: normalizedType === 'success' ? 'success' : normalizedType === 'failed' ? 'warning' : 'general',
        targetType: 'specific',
        targetUserId: userId,
        priority: normalizedType === 'failed' ? 'high' : 'medium',
        createdBy: SYSTEM_ADMIN_ID,
      });
    } catch (dbErr: any) {
      console.warn('⚠️ Failed to save transaction notification to DB (non-critical):', dbErr.message);
    }

    return result;
  } catch (error: any) {
    console.error('❌ Transaction notification failed:', error);
    return false;
  }
}

/**
 * Send multilingual push notification for any payment type
 * (bill, gift card, natcash, moncash, wallet, pick)
 */
export async function sendPaymentSuccessNotification(
  userId: string,
  type: 'bill' | 'giftcard' | 'natcash' | 'moncash' | 'wallet' | 'topup' | 'pick' | 'usdt' | 'pix',
  amount: string,
  recipient?: string
): Promise<boolean> {
  try {
    const user = await storage.getUser(userId);
    const lang = getUserLang(user?.language);

    const msgSet = PAYMENT_MSGS[type] || PAYMENT_MSGS.bill;
    const { title, body: bodyFn } = msgSet[lang];
    const formattedAmount = await formatAmountForUser(userId, amount);
    const body = bodyFn(formattedAmount, recipient);
    const clickAction = '/history';

    console.log(`📱 Sending ${type} payment notification (${lang}) to user: ${userId}`);
    const result = await fcmService.sendUserNotification(userId, { title, body, clickAction });
    console.log(`✅ ${type} notification sent to user ${userId}:`, result);

    try {
      await storage.createNotification({
        titleEn: msgSet.en.title,
        titleFr: msgSet.fr.title,
        titleHt: msgSet.ht.title,
        titleEs: msgSet.es.title,
        messageEn: msgSet.en.body(formattedAmount, recipient),
        messageFr: msgSet.fr.body(formattedAmount, recipient),
        messageHt: msgSet.ht.body(formattedAmount, recipient),
        messageEs: msgSet.es.body(formattedAmount, recipient),
        type: 'success',
        targetType: 'specific',
        targetUserId: userId,
        priority: 'medium',
        createdBy: SYSTEM_ADMIN_ID,
      });
    } catch (dbErr: any) {
      console.warn('⚠️ Failed to save payment notification to DB (non-critical):', dbErr.message);
    }

    return result;
  } catch (error: any) {
    console.error('❌ Payment success notification failed:', error);
    return false;
  }
}

const PAYMENT_FAIL_MSGS: Record<string, Record<Lang, { title: string; body: (a: string, r?: string) => string }>> = {
  bill: {
    en: { title: 'Bill Payment Failed ❌', body: (a,r) => `Your ${a} bill payment${r ? ` for ${r}` : ''} could not be completed. Your payment has been refunded.` },
    fr: { title: 'Paiement de Facture Échoué ❌', body: (a,r) => `Votre paiement de facture de ${a}${r ? ` pour ${r}` : ''} n'a pas pu être traité. Votre paiement a été remboursé.` },
    ht: { title: 'Pèman Fakti Echwe ❌', body: (a,r) => `Pèman fakti ${a}${r ? ` pou ${r}` : ''} ou pa kapab fini. Lajan ou ranbouse.` },
    es: { title: 'Pago de Factura Fallido ❌', body: (a,r) => `Su pago de factura de ${a}${r ? ` para ${r}` : ''} no pudo completarse. Su pago ha sido reembolsado.` },
  },
  giftcard: {
    en: { title: 'Gift Card Purchase Failed ❌', body: (a) => `Your ${a} gift card purchase could not be completed. Your payment has been refunded.` },
    fr: { title: 'Achat de Carte Cadeau Échoué ❌', body: (a) => `Votre achat de carte cadeau de ${a} n'a pas pu être effectué. Votre paiement a été remboursé.` },
    ht: { title: 'Acha Kat Kado Echwe ❌', body: (a) => `Acha kat kado ${a} ou pa kapab fini. Lajan ou ranbouse.` },
    es: { title: 'Compra de Tarjeta de Regalo Fallida ❌', body: (a) => `Su compra de tarjeta de regalo de ${a} no pudo completarse. Su pago ha sido reembolsado.` },
  },
  natcash: {
    en: { title: 'NatCash Transfer Failed ❌', body: (a,r) => `Your ${a} NatCash transfer${r ? ` to ${r}` : ''} could not be submitted. Please try again.` },
    fr: { title: 'Transfert NatCash Échoué ❌', body: (a,r) => `Votre transfert NatCash de ${a}${r ? ` vers ${r}` : ''} n'a pas pu être soumis. Réessayez.` },
    ht: { title: 'Transfert NatCash Echwe ❌', body: (a,r) => `Transfert NatCash ${a}${r ? ` pou ${r}` : ''} ou pa kapab soumèt. Eseye ankò.` },
    es: { title: 'Transferencia NatCash Fallida ❌', body: (a,r) => `Su transferencia NatCash de ${a}${r ? ` a ${r}` : ''} no pudo enviarse. Intente de nuevo.` },
  },
  moncash: {
    en: { title: 'MonCash Transfer Failed ❌', body: (a,r) => `Your ${a} MonCash transfer${r ? ` to ${r}` : ''} could not be submitted. Please try again.` },
    fr: { title: 'Transfert MonCash Échoué ❌', body: (a,r) => `Votre transfert MonCash de ${a}${r ? ` vers ${r}` : ''} n'a pas pu être soumis. Réessayez.` },
    ht: { title: 'Transfert MonCash Echwe ❌', body: (a,r) => `Transfert MonCash ${a}${r ? ` pou ${r}` : ''} ou pa kapab soumèt. Eseye ankò.` },
    es: { title: 'Transferencia MonCash Fallida ❌', body: (a,r) => `Su transferencia MonCash de ${a}${r ? ` a ${r}` : ''} no pudo enviarse. Intente de nuevo.` },
  },
};

/**
 * Send multilingual push notification for failed payment (bill, giftcard, natcash, moncash)
 */
export async function sendPaymentFailureNotification(
  userId: string,
  type: 'bill' | 'giftcard' | 'natcash' | 'moncash',
  amount: string,
  recipient?: string
): Promise<boolean> {
  try {
    const user = await storage.getUser(userId);
    const lang = getUserLang(user?.language);
    const msgSet = PAYMENT_FAIL_MSGS[type] || PAYMENT_FAIL_MSGS.bill;
    const { title, body: bodyFn } = msgSet[lang];
    const formattedAmount = await formatAmountForUser(userId, amount);
    const body = bodyFn(formattedAmount, recipient);
    const clickAction = '/history';
    console.log(`📱 Sending ${type} failure notification (${lang}) to user: ${userId}`);
    const result = await fcmService.sendUserNotification(userId, { title, body, clickAction });
    console.log(`✅ ${type} failure notification sent to user ${userId}:`, result);

    try {
      await storage.createNotification({
        titleEn: msgSet.en.title,
        titleFr: msgSet.fr.title,
        titleHt: msgSet.ht.title,
        titleEs: msgSet.es.title,
        messageEn: msgSet.en.body(formattedAmount, recipient),
        messageFr: msgSet.fr.body(formattedAmount, recipient),
        messageHt: msgSet.ht.body(formattedAmount, recipient),
        messageEs: msgSet.es.body(formattedAmount, recipient),
        type: 'warning',
        targetType: 'specific',
        targetUserId: userId,
        priority: 'high',
        createdBy: SYSTEM_ADMIN_ID,
      });
    } catch (dbErr: any) {
      console.warn('⚠️ Failed to save failure notification to DB (non-critical):', dbErr.message);
    }

    return result;
  } catch (error: any) {
    console.error('❌ Payment failure notification failed:', error);
    return false;
  }
}

/**
 * Send promotional notification to all users or specific user
 */
export async function sendPromotionalNotification(
  title: string,
  body: string,
  userId?: string,
  clickAction?: string
): Promise<any> {
  try {
    console.log('🎁 Sending promotional notification...');

    if (userId) {
      // Send to specific user
      const result = await fcmService.sendUserNotification(userId, {
        title,
        body,
        clickAction: clickAction || '/promotions'
      });
      console.log(`✅ Promotional notification sent to user ${userId}:`, result);
      return { success: result ? 1 : 0, failed: result ? 0 : 1 };
    } else {
      // Send to all active users
      const deviceTokens = await storage.getAllActiveDeviceTokens();
      
      if (deviceTokens.length === 0) {
        console.log('📭 No active device tokens found');
        return { success: 0, failed: 0, errors: [] };
      }

      const tokens = deviceTokens.map(dt => dt.token);
      const result = await fcmService.sendBulkPushNotifications(tokens, {
        title,
        body,
        clickAction: clickAction || '/promotions'
      });

      console.log(`✅ Promotional notification sent to ${deviceTokens.length} users`);
      return result;
    }

  } catch (error: any) {
    console.error('❌ Promotional notification failed:', error);
    return {
      success: 0,
      failed: 0,
      errors: [error.message]
    };
  }
}

/**
 * Send custom notification to all users or specific user
 */
export async function sendCustomNotification(
  title: string,
  body: string,
  options?: {
    userId?: string;
    clickAction?: string;
    icon?: string;
    data?: Record<string, string>;
  }
): Promise<any> {
  try {
    console.log('📢 Sending custom notification...');

    const payload = {
      title,
      body,
      clickAction: options?.clickAction || '/',
      icon: options?.icon,
      data: options?.data
    };

    if (options?.userId) {
      // Send to specific user
      const result = await fcmService.sendUserNotification(options.userId, payload);
      console.log(`✅ Custom notification sent to user ${options.userId}:`, result);
      return { success: result ? 1 : 0, failed: result ? 0 : 1 };
    } else {
      // Send to all active users
      const deviceTokens = await storage.getAllActiveDeviceTokens();
      
      if (deviceTokens.length === 0) {
        console.log('📭 No active device tokens found');
        return { success: 0, failed: 0, errors: [] };
      }

      const tokens = deviceTokens.map(dt => dt.token);
      const result = await fcmService.sendBulkPushNotifications(tokens, payload);

      console.log(`✅ Custom notification sent to ${deviceTokens.length} users`);
      return result;
    }

  } catch (error: any) {
    console.error('❌ Custom notification failed:', error);
    return {
      success: 0,
      failed: 0,
      errors: [error.message]
    };
  }
}

/**
 * Start 30-second test notification scheduler (admin FCM verification)
 */
export function startTestNotificationScheduler(): void {
  if (testNotificationInterval) {
    console.log('⚠️ Test notification scheduler already running');
    return;
  }

  testNotificationCount = 0;
  console.log('🧪 Starting 30-second test notification scheduler...');

  testNotificationInterval = setInterval(async () => {
    testNotificationCount++;
    const MAX_TEST_RUNS = 20; // Auto-stop after 20 runs (10 minutes)
    const now = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`🧪 TEST NOTIFICATION #${testNotificationCount}/${MAX_TEST_RUNS} at ${now}`);

    try {
      const deviceTokens = await storage.getAllActiveDeviceTokens();
      
      if (deviceTokens.length === 0) {
        console.log('📭 No active tokens yet - open buyfasttopup.replit.app on your phone to register...');
      } else {
        for (const dt of deviceTokens) {
          const success = await fcmService.sendPushNotification(dt.token, {
            title: `🧪 Test #${testNotificationCount} — ${now}`,
            body: 'FCM ap travay! Notifikasyon resevwa ak siksè.',
            icon: '/logo-buyfast-favicon.jpg',
            clickAction: '/dashboard'
          });
          
          if (success) {
            console.log(`✅ Test notification #${testNotificationCount} sent to user ${dt.userId || (dt as any).user_id}`);
          } else {
            console.warn(`⚠️ Test notification #${testNotificationCount} failed for token ${dt.token.substring(0, 20)}...`);
          }
        }
      }
    } catch (err: any) {
      console.error('❌ Test notification error:', err.message);
    }

    // Auto-stop after MAX_TEST_RUNS
    if (testNotificationCount >= MAX_TEST_RUNS) {
      stopTestNotificationScheduler();
      console.log('🏁 Test notification scheduler auto-stopped after 10 minutes');
    }
  }, 30000);

  console.log('✅ Test notification scheduler running — every 30 seconds');
}

/**
 * Stop 30-second test notification scheduler
 */
export function stopTestNotificationScheduler(): void {
  if (testNotificationInterval) {
    clearInterval(testNotificationInterval);
    testNotificationInterval = null;
    console.log(`🛑 Test notification scheduler stopped after ${testNotificationCount} notifications`);
    testNotificationCount = 0;
  }
}

/**
 * Get test scheduler status
 */
export function getTestSchedulerStatus(): { running: boolean; count: number } {
  return { running: !!testNotificationInterval, count: testNotificationCount };
}


// ─── 24 App-Open Engagement Messages ─────────────────────────────────────────
// Sent once per session when user opens the app. Rotates through 24 messages.

const APP_OPEN_MESSAGES: Array<{
  en: { title: string; body: string };
  fr: { title: string; body: string };
  ht: { title: string; body: string };
  es: { title: string; body: string };
}> = [
  {
    en: { title: "👋 Welcome back!", body: "BuyFast is ready. Transfer money, top-up or pay bills in seconds." },
    fr: { title: "👋 Bon retour !", body: "BuyFast est prêt. Transférez, rechargez ou payez vos factures en secondes." },
    ht: { title: "👋 Byenveni tounen !", body: "BuyFast pare pou ou. Transfere, recharge oswa peye fakti yo an kèk segonn." },
    es: { title: "👋 ¡Bienvenido de nuevo!", body: "BuyFast está listo. Transfiere, recarga o paga facturas en segundos." },
  },
  {
    en: { title: "🔒 Your account is protected", body: "End-to-end encryption on every transaction. Your money is safe with us." },
    fr: { title: "🔒 Votre compte est protégé", body: "Chiffrement de bout en bout sur chaque transaction. Votre argent est en sécurité." },
    ht: { title: "🔒 Kont ou an pwoteje", body: "Chifraj konplè sou chak tranzaksyon. Lajan ou an sekirite avèk nou." },
    es: { title: "🔒 Tu cuenta está protegida", body: "Cifrado de extremo a extremo en cada transacción. Tu dinero está seguro." },
  },
  {
    en: { title: "⚡ Top-up in under 10 seconds", body: "Send airtime to any phone in Haiti or the Caribbean instantly." },
    fr: { title: "⚡ Rechargez en moins de 10 secondes", body: "Envoyez du crédit sur n'importe quel téléphone en Haïti ou aux Caraïbes." },
    ht: { title: "⚡ Recharge nan mwens pase 10 segonn", body: "Voye kredi nan nenpòt telefòn an Ayiti oswa nan Karayib la. Imedyatman." },
    es: { title: "⚡ Recarga en menos de 10 segundos", body: "Envía saldo a cualquier teléfono en Haití o el Caribe al instante." },
  },
  {
    en: { title: "🧾 Pay bills without leaving home", body: "Electricity, water, cable — pay everything from the app. Fast & easy." },
    fr: { title: "🧾 Payez vos factures sans sortir", body: "Électricité, eau, câble — payez tout depuis l'appli. Rapide et simple." },
    ht: { title: "🧾 Peye fakti san kite kay ou", body: "Kouran, dlo, kab — peye tout bagay soti nan app la. Vit ak fasil." },
    es: { title: "🧾 Paga facturas sin salir de casa", body: "Electricidad, agua, cable — paga todo desde la app. Rápido y fácil." },
  },
  {
    en: { title: "🎁 Send gift cards today", body: "Surprise your loved ones with Google Play, Amazon, iTunes & more." },
    fr: { title: "🎁 Envoyez des cartes cadeaux", body: "Surprenez vos proches avec Google Play, Amazon, iTunes et plus encore." },
    ht: { title: "🎁 Voye kat kado jodi a", body: "Fè fanmi ak zanmi ou yon sipriz avèk Google Play, Amazon, iTunes ak plis." },
    es: { title: "🎁 Envía tarjetas de regalo hoy", body: "Sorprende a tus seres queridos con Google Play, Amazon, iTunes y más." },
  },
  {
    en: { title: "📲 MonCash & NatCash transfers", body: "Send directly to MonCash or NatCash wallets. Instant. No hassle." },
    fr: { title: "📲 Transferts MonCash & NatCash", body: "Envoyez directement vers MonCash ou NatCash. Instantané. Sans tracas." },
    ht: { title: "📲 Transfere nan MonCash & NatCash", body: "Voye dirèkteman nan MonCash oswa NatCash. Imedyat. San konplikasyon." },
    es: { title: "📲 Transferencias MonCash & NatCash", body: "Envía directamente a billeteras MonCash o NatCash. Al instante. Sin complicaciones." },
  },
  {
    en: { title: "🌙 Available 24/7, every day", body: "Day or night, we're always here. Transfer anytime, from anywhere." },
    fr: { title: "🌙 Disponible 24h/24, 7j/7", body: "Jour et nuit, nous sommes toujours là. Transférez à tout moment, de partout." },
    ht: { title: "🌙 Disponib 24/7, chak jou", body: "Lajounen ak lannwit, nou toujou la. Transfere nenpòt ki lè, nenpòt kote." },
    es: { title: "🌙 Disponible 24/7, todos los días", body: "De día o de noche, siempre estamos aquí. Transfiere cuando quieras, desde donde sea." },
  },
  {
    en: { title: "💼 Your wallet, your control", body: "Check your balance, history and transactions anytime. Full transparency." },
    fr: { title: "💼 Votre portefeuille, votre contrôle", body: "Consultez votre solde, historique et transactions à tout moment. Transparence totale." },
    ht: { title: "💼 Pòtefèy ou, kontwòl ou", body: "Verifye balans ou, istwa ou ak tranzaksyon ou nenpòt ki lè. Transparan nèt." },
    es: { title: "💼 Tu billetera, tu control", body: "Consulta tu saldo, historial y transacciones en cualquier momento. Transparencia total." },
  },
  {
    en: { title: "🇭🇹 Sending money to Haiti made easy", body: "Fast, reliable transfers to Haiti. Family receives funds instantly." },
    fr: { title: "🇭🇹 Envoyer de l'argent en Haïti, c'est simple", body: "Transferts rapides et fiables vers Haïti. La famille reçoit les fonds instantanément." },
    ht: { title: "🇭🇹 Voye lajan Ayiti fasil", body: "Transfere rapid ak fyab pou Ayiti. Fanmi ou resevwa lajan an imedyatman." },
    es: { title: "🇭🇹 Enviar dinero a Haití es fácil", body: "Transferencias rápidas y confiables a Haití. La familia recibe los fondos al instante." },
  },
  {
    en: { title: "🎉 Today's special offer", body: "Check your promo codes — exclusive discounts are waiting for you!" },
    fr: { title: "🎉 L'offre spéciale du jour", body: "Consultez vos codes promo — des réductions exclusives vous attendent !" },
    ht: { title: "🎉 Òf espesyal jodi a", body: "Verifye kòd promo ou yo — rabè eksklizif ap tann ou !" },
    es: { title: "🎉 La oferta especial de hoy", body: "Revisa tus códigos promo — ¡descuentos exclusivos te esperan!" },
  },
  {
    en: { title: "✅ Fast. Secure. Reliable.", body: "Every transfer on BuyFast is processed in real-time with full confirmation." },
    fr: { title: "✅ Rapide. Sécurisé. Fiable.", body: "Chaque transfert sur BuyFast est traité en temps réel avec confirmation complète." },
    ht: { title: "✅ Rapid. Sekirize. Fyab.", body: "Chak transfere sou BuyFast trete an tan reyèl avèk konfimasyon konplè." },
    es: { title: "✅ Rápido. Seguro. Confiable.", body: "Cada transferencia en BuyFast se procesa en tiempo real con confirmación completa." },
  },
  {
    en: { title: "🔐 Military-grade security", body: "Your data and funds are protected by 256-bit encryption at all times." },
    fr: { title: "🔐 Sécurité de niveau militaire", body: "Vos données et fonds sont protégés par un chiffrement 256 bits en permanence." },
    ht: { title: "🔐 Sekirite nivo militè", body: "Done ou ak lajan ou pwoteje pa chifraj 256-bit an tout tan." },
    es: { title: "🔐 Seguridad de nivel militar", body: "Tus datos y fondos están protegidos por cifrado de 256 bits en todo momento." },
  },
  {
    en: { title: "💬 Chat support always available", body: "Got a question? Our team responds in 4 languages — HT, EN, FR, ES." },
    fr: { title: "💬 Support chat toujours disponible", body: "Une question ? Notre équipe répond en 4 langues — HT, EN, FR, ES." },
    ht: { title: "💬 Sipò chat toujou disponib", body: "Ou gen yon kesyon ? Ekip nou an reponn nan 4 lang — HT, EN, FR, ES." },
    es: { title: "💬 Soporte por chat siempre disponible", body: "¿Tienes una pregunta? Nuestro equipo responde en 4 idiomas — HT, EN, FR, ES." },
  },
  {
    en: { title: "📱 Surprise your family today", body: "Top-up a loved one's phone right now — they'll receive it instantly." },
    fr: { title: "📱 Surprenez votre famille aujourd'hui", body: "Rechargez le téléphone d'un proche maintenant — il le recevra instantanément." },
    ht: { title: "📱 Fè fanmi ou yon sipriz jodi a", body: "Recharge telefòn yon moun ou renmen kounye a — yo resevwa li imedyatman." },
    es: { title: "📱 Sorprende a tu familia hoy", body: "Recarga el teléfono de un ser querido ahora mismo — lo recibirá al instante." },
  },
  {
    en: { title: "💯 No hidden fees, ever", body: "What you see is what you pay. BuyFast always shows the full price upfront." },
    fr: { title: "💯 Aucun frais caché, jamais", body: "Ce que vous voyez est ce que vous payez. BuyFast affiche toujours le prix complet." },
    ht: { title: "💯 Pa gen frè kache, janm", body: "Sa ou wè se sa ou peye. BuyFast toujou montre pri konplè a devan." },
    es: { title: "💯 Sin cargos ocultos, nunca", body: "Lo que ves es lo que pagas. BuyFast siempre muestra el precio completo por adelantado." },
  },
  {
    en: { title: "📡 All carriers covered", body: "Digicel, Natcom and more — top-up any number, any carrier in Haiti." },
    fr: { title: "📡 Tous les opérateurs couverts", body: "Digicel, Natcom et plus — rechargez n'importe quel numéro, n'importe quel opérateur." },
    ht: { title: "📡 Tout operatè kouvri", body: "Digicel, Natcom ak plis — recharge nenpòt nimewo, nenpòt operatè an Ayiti." },
    es: { title: "📡 Todas las operadoras cubiertas", body: "Digicel, Natcom y más — recarga cualquier número, cualquier operadora en Haití." },
  },
  {
    en: { title: "🛡️ Your account, always secure", body: "Two-factor checks protect every login. You're in safe hands." },
    fr: { title: "🛡️ Votre compte, toujours sécurisé", body: "Des vérifications en deux étapes protègent chaque connexion. Vous êtes entre de bonnes mains." },
    ht: { title: "🛡️ Kont ou, toujou an sekirite", body: "Verifikasyon doub pwoteje chak koneksyon. Ou an bon men." },
    es: { title: "🛡️ Tu cuenta, siempre segura", body: "Verificaciones de doble factor protegen cada inicio de sesión. Estás en buenas manos." },
  },
  {
    en: { title: "🙌 Thousands trust BuyFast daily", body: "Join a growing community of users who send money with confidence every day." },
    fr: { title: "🙌 Des milliers font confiance à BuyFast", body: "Rejoignez une communauté grandissante qui envoie de l'argent en confiance chaque jour." },
    ht: { title: "🙌 Dè milye moun fè BuyFast konfyans chak jou", body: "Rejwenn yon kominote k ap grandi ki voye lajan avèk konfyans chak jou." },
    es: { title: "🙌 Miles confían en BuyFast a diario", body: "Únete a una comunidad creciente que envía dinero con confianza todos los días." },
  },
  {
    en: { title: "📧 Instant confirmation every time", body: "Email + SMS receipt sent automatically after every successful transaction." },
    fr: { title: "📧 Confirmation instantanée à chaque fois", body: "Reçu par email + SMS envoyé automatiquement après chaque transaction réussie." },
    ht: { title: "📧 Konfimasyon imedya chak fwa", body: "Resi pa imèl + SMS voye otomatikman apre chak tranzaksyon reyisi." },
    es: { title: "📧 Confirmación instantánea cada vez", body: "Recibo por correo + SMS enviado automáticamente después de cada transacción exitosa." },
  },
  {
    en: { title: "🌊 The Caribbean's most trusted app", body: "BuyFast serves Haiti, Dominican Republic, Jamaica & more. Always growing." },
    fr: { title: "🌊 L'application la plus fiable des Caraïbes", body: "BuyFast dessert Haïti, République Dominicaine, Jamaïque et plus. Toujours en croissance." },
    ht: { title: "🌊 App ki pi fyab nan Karayib la", body: "BuyFast sèvi Ayiti, Dominikani, Jamaïk ak plis. Toujou ap grandi." },
    es: { title: "🌊 La app más confiable del Caribe", body: "BuyFast sirve a Haití, Rep. Dominicana, Jamaica y más. Siempre creciendo." },
  },
  {
    en: { title: "🚀 One app for everything", body: "Top-ups, bill payments, gift cards, transfers — all in one place." },
    fr: { title: "🚀 Une appli pour tout", body: "Recharges, factures, cartes cadeaux, transferts — tout en un seul endroit." },
    ht: { title: "🚀 Yon app pou tout bagay", body: "Recharge, fakti, kat kado, transfere — tout nan yon sèl kote." },
    es: { title: "🚀 Una app para todo", body: "Recargas, facturas, tarjetas de regalo, transferencias — todo en un solo lugar." },
  },
  {
    en: { title: "⚖️ Your balance, always up to date", body: "Real-time balance updates after every transaction. Always accurate." },
    fr: { title: "⚖️ Votre solde, toujours à jour", body: "Mises à jour en temps réel après chaque transaction. Toujours précis." },
    ht: { title: "⚖️ Balans ou, toujou aktyalize", body: "Miz ajou an tan reyèl apre chak tranzaksyon. Toujou egzak." },
    es: { title: "⚖️ Tu saldo, siempre actualizado", body: "Actualizaciones en tiempo real después de cada transacción. Siempre preciso." },
  },
  {
    en: { title: "📈 The best rates, every day", body: "We monitor exchange rates daily so you always get the most value." },
    fr: { title: "📈 Les meilleurs taux, chaque jour", body: "Nous surveillons les taux de change quotidiennement pour vous donner le meilleur rapport qualité-prix." },
    ht: { title: "📈 Pi bon to chanje, chak jou", body: "Nou suivi to chanje chak jou pou ou jwenn pi bon valè a toujou." },
    es: { title: "📈 Las mejores tasas, cada día", body: "Monitoreamos las tasas de cambio diariamente para que siempre obtengas el mejor valor." },
  },
  {
    en: { title: "🤝 BuyFast — your financial partner", body: "We're not just an app. We're your trusted partner for every payment." },
    fr: { title: "🤝 BuyFast — votre partenaire financier", body: "Nous ne sommes pas qu'une appli. Nous sommes votre partenaire de confiance pour chaque paiement." },
    ht: { title: "🤝 BuyFast — patnè finansye ou", body: "Nou pa sèlman yon app. Nou se patnè ou fè konfyans pou chak peman." },
    es: { title: "🤝 BuyFast — tu socio financiero", body: "No somos solo una app. Somos tu socio de confianza para cada pago." },
  },
];

// In-memory cooldown: userId → timestamp of last app-open notification (1-hour cooldown)
const appOpenCooldowns = new Map<string, number>();

/**
 * Send one rotating engagement notification when user opens the app.
 * Rotates through 24 messages. Respects a 1-hour per-user cooldown.
 */
export async function sendAppOpenNotification(userId: string, lang: string = 'en'): Promise<boolean> {
  try {
    // Check cooldown (1 hour = 3600000ms)
    const lastSent = appOpenCooldowns.get(userId);
    const now = Date.now();
    if (lastSent && now - lastSent < 3600000) {
      console.log(`⏳ app-open cooldown active for user ${userId} — ${Math.round((3600000 - (now - lastSent)) / 60000)} min remaining`);
      return false;
    }
    console.log(`🔔 sendAppOpenNotification proceeding for user: ${userId}`);

    // Pick message index based on hour-of-day × userId hash → 0..23
    const haitiHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Port-au-Prince' })).getHours();
    const userHash  = userId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const idx       = (haitiHour + userHash) % APP_OPEN_MESSAGES.length;
    const msg       = APP_OPEN_MESSAGES[idx];

    const supported = ['en', 'fr', 'ht', 'es'].includes(lang) ? lang as 'en' | 'fr' | 'ht' | 'es' : 'en';
    const { title, body } = msg[supported];

    const { sendUserNotification } = await import('../services/fcmService');
    const sent = await sendUserNotification(userId, { title, body, clickAction: '/' });

    if (sent) {
      appOpenCooldowns.set(userId, now);
      console.log(`📲 App-open notification [${supported}] → user ${userId}: "${title}"`);
    }

    return sent;
  } catch (err: any) {
    console.error('❌ sendAppOpenNotification error:', err.message || err);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PERSONALIZED DAILY NOTIFICATIONS — Baze sou istwa tranzaksyon itilizatè a
// Peyi + Sèvis => mesaj pèsonalize chak jou 10h30 AM Ayiti
// ─────────────────────────────────────────────────────────────────────────────

type Lang4 = 'ht' | 'en' | 'fr' | 'es';

const COUNTRY_NAMES: Record<string, Record<Lang4, string>> = {
  HT: { ht: 'Ayiti',            en: 'Haiti',              fr: 'Haïti',              es: 'Haití'           },
  DO: { ht: 'Dominikani',       en: 'Dominican Republic', fr: 'République Dom.',    es: 'Rep. Dominicana' },
  US: { ht: 'Etazini',          en: 'United States',      fr: 'États-Unis',         es: 'EE.UU.'          },
  CA: { ht: 'Kanada',           en: 'Canada',             fr: 'Canada',             es: 'Canadá'          },
  FR: { ht: 'Frans',            en: 'France',             fr: 'France',             es: 'Francia'         },
  MX: { ht: 'Meksik',          en: 'Mexico',             fr: 'Mexique',            es: 'México'          },
  JM: { ht: 'Jamayik',          en: 'Jamaica',            fr: 'Jamaïque',           es: 'Jamaica'         },
  TT: { ht: 'Trinite',          en: 'Trinidad',           fr: 'Trinité',            es: 'Trinidad'        },
  NG: { ht: 'Nijerya',          en: 'Nigeria',            fr: 'Nigéria',            es: 'Nigeria'         },
  GH: { ht: 'Gana',             en: 'Ghana',              fr: 'Ghana',              es: 'Ghana'           },
  CU: { ht: 'Kiba',             en: 'Cuba',               fr: 'Cuba',               es: 'Cuba'            },
  BB: { ht: 'Barbad',           en: 'Barbados',           fr: 'Barbade',            es: 'Barbados'        },
  LC: { ht: 'Sent Lisi',        en: 'Saint Lucia',        fr: 'Sainte-Lucie',       es: 'Santa Lucía'     },
  VC: { ht: 'Sent Vansen',      en: 'St. Vincent',        fr: 'St-Vincent',         es: 'San Vicente'     },
  GD: { ht: 'Grenad',           en: 'Grenada',            fr: 'Grenade',            es: 'Granada'         },
  SN: { ht: 'Senegal',          en: 'Senegal',            fr: 'Sénégal',            es: 'Senegal'         },
  CM: { ht: 'Kamewoun',         en: 'Cameroon',           fr: 'Cameroun',           es: 'Camerún'         },
  CI: { ht: 'Côte dIvwa',      en: "Côte d'Ivoire",      fr: "Côte d'Ivoire",      es: 'Costa de Marfil' },
  KE: { ht: 'Kenya',            en: 'Kenya',              fr: 'Kenya',              es: 'Kenia'           },
  GB: { ht: 'Angletè',          en: 'United Kingdom',     fr: 'Royaume-Uni',        es: 'Reino Unido'     },
  ES: { ht: 'Espay',            en: 'Spain',              fr: 'Espagne',            es: 'España'          },
  BR: { ht: 'Brezil',           en: 'Brazil',             fr: 'Brésil',             es: 'Brasil'          },
};

function getCountryName(code: string, lang: Lang4): string {
  return COUNTRY_NAMES[code]?.[lang] || code;
}

type ServiceMsgSet = Record<Lang4, { title: (c: string) => string; body: (c: string) => string }>;

const PERSONALIZED_SERVICE_MSGS: Record<string, ServiceMsgSet> = {
  topup: {
    ht: { title: c => `📱 Recharge ${c} — Kounye a!`,           body: c => `Ou abitye recharge ${c}! Voye yon lòt jodi a — rapid, sekirize, san komisyon kache.` },
    en: { title: c => `📱 ${c} Top-Up — Today's Deal!`,          body: c => `You regularly top up ${c}! Send another one today — fast, secure, no hidden fees.` },
    fr: { title: c => `📱 Recharge ${c} — Offre du Jour!`,       body: c => `Vous rechargez souvent ${c}! Envoyez une recharge aujourd'hui — rapide, sécurisé, sans frais cachés.` },
    es: { title: c => `📱 Recarga ${c} — ¡Oferta de Hoy!`,      body: c => `¡Recargas habitualmente ${c}! Envía otra hoy — rápido, seguro, sin cargos ocultos.` },
  },
  wallet_deposit: {
    ht: { title: c => `💰 Pòtfèy ou pou ${c}!`,                 body: c => `Ou itilize pòtfèy BuyFast pou ${c}. Chaje l jodi a pou jwenn pi bon pri sou recharge ak transfert!` },
    en: { title: c => `💰 Fund your wallet for ${c}!`,            body: c => `You use your BuyFast wallet for ${c}. Top it up today for the best rates on top-ups & transfers!` },
    fr: { title: c => `💰 Rechargez votre portefeuille pour ${c}!`, body: c => `Vous utilisez votre portefeuille BuyFast pour ${c}. Rechargez aujourd'hui pour les meilleurs tarifs!` },
    es: { title: c => `💰 ¡Recarga tu billetera para ${c}!`,     body: c => `¡Usas tu billetera BuyFast para ${c}. Recárgala hoy para las mejores tarifas en recargas y transferencias!` },
  },
  natcash: {
    ht: { title: c => `📤 NatCash ${c} — Voye Jodi a!`,          body: c => `Ou konn voye NatCash pou moun nan ${c}. Pa kite yo tann — voye yon transfert jodi a!` },
    en: { title: c => `📤 NatCash ${c} — Send Today!`,            body: c => `You often send NatCash to ${c}. Don't keep them waiting — send a transfer today!` },
    fr: { title: c => `📤 NatCash ${c} — Envoyez Aujourd'hui!`,  body: c => `Vous envoyez souvent du NatCash vers ${c}. Ne les faites pas attendre — envoyez aujourd'hui!` },
    es: { title: c => `📤 NatCash ${c} — ¡Envía Hoy!`,           body: c => `¡Sueles enviar NatCash a ${c}. No los hagas esperar — envía una transferencia hoy!` },
  },
  moncash: {
    ht: { title: c => `📲 MonCash ${c} — Voye Jodi a!`,           body: c => `Ou voye MonCash pou ${c} souvan. Fanmi ou bezwen lajan? Voye jodi a an 2 klik!` },
    en: { title: c => `📲 MonCash ${c} — Send Today!`,             body: c => `You regularly send MonCash to ${c}. Does your family need money? Send today in 2 taps!` },
    fr: { title: c => `📲 MonCash ${c} — Envoyez Aujourd'hui!`,   body: c => `Vous envoyez régulièrement du MonCash vers ${c}. Votre famille a besoin d'argent? Envoyez en 2 clics!` },
    es: { title: c => `📲 MonCash ${c} — ¡Envía Hoy!`,            body: c => `¡Envías regularmente MonCash a ${c}. ¿Tu familia necesita dinero? ¡Envía hoy en 2 toques!` },
  },
  bill: {
    ht: { title: c => `🧾 Fakti ${c} — Peye Jodi a!`,             body: c => `Pa bliye peye fakti ${c} ou a. BuyFast rann li fasil — yon klik epi ou fini!` },
    en: { title: c => `🧾 ${c} Bills — Pay Today!`,                body: c => `Don't forget to pay your ${c} bills. BuyFast makes it easy — one tap and you're done!` },
    fr: { title: c => `🧾 Factures ${c} — Payez Aujourd'hui!`,    body: c => `N'oubliez pas de payer vos factures ${c}. BuyFast rend ça facile — un clic et c'est fait!` },
    es: { title: c => `🧾 Facturas ${c} — ¡Paga Hoy!`,            body: c => `¡No olvides pagar tus facturas de ${c}. BuyFast lo hace fácil — un toque y listo!` },
  },
  giftcard: {
    ht: { title: c => `🎁 Gift Card pou moun nan ${c}!`,           body: c => `Ou achte Gift Card pou moun nan ${c}. Voye youn kounye a — Amazon, iTunes, Google Play!` },
    en: { title: c => `🎁 Gift Cards for ${c}!`,                   body: c => `You buy Gift Cards for people in ${c}. Send one now — Amazon, iTunes, Google Play!` },
    fr: { title: c => `🎁 Cartes Cadeaux pour ${c}!`,              body: c => `Vous achetez des cartes cadeaux pour des proches en ${c}. Envoyez maintenant — Amazon, iTunes!` },
    es: { title: c => `🎁 ¡Gift Cards para ${c}!`,                 body: c => `¡Compras Gift Cards para personas en ${c}. Envía una ahora — Amazon, iTunes, Google Play!` },
  },
};

const PERSONALIZED_FALLBACK: ServiceMsgSet = {
  ht: { title: c => `🌍 Voye pou ${c} — Jodi a!`,                 body: c => `Ou ka recharge, transfert ak peye fakti pou moun nan ${c} dirèkteman nan BuyFast. Eseye jodi a!` },
  en: { title: c => `🌍 Send to ${c} — Today!`,                   body: c => `You can top up, transfer & pay bills for people in ${c} directly on BuyFast. Try today!` },
  fr: { title: c => `🌍 Envoyez vers ${c} — Aujourd'hui!`,        body: c => `Vous pouvez recharger, transférer et payer des factures pour ${c} directement sur BuyFast!` },
  es: { title: c => `🌍 ¡Envía a ${c} — Hoy!`,                   body: c => `¡Puedes recargar, transferir y pagar facturas para ${c} directamente en BuyFast. ¡Pruébalo!` },
};

let personalizedDailyCronJob: ReturnType<typeof cron.schedule> | null = null;

export async function sendPersonalizedDailyNotifications(): Promise<{ sent: number; skipped: number }> {
  try {
    console.log('🎯 Starting personalized daily notifications...');

    const [userTopData, deviceTokens, allUsers] = await Promise.all([
      storage.getUserTopCountryServices(1000),
      storage.getAllActiveDeviceTokens(),
      storage.getAllUsers(),
    ]);

    if (deviceTokens.length === 0) {
      console.log('📭 Personalized: no active device tokens');
      return { sent: 0, skipped: 0 };
    }

    const userMap   = new Map(allUsers.map((u: any) => [u.id, u]));
    const tokenMap  = new Map<string, string[]>();
    for (const dt of deviceTokens) {
      if (!tokenMap.has(dt.userId)) tokenMap.set(dt.userId, []);
      tokenMap.get(dt.userId)!.push(dt.token);
    }

    // Build top country+service per user (first row = highest count due to ORDER BY)
    const userTopMap = new Map<string, { countryId: string; serviceType: string }>();
    for (const row of userTopData) {
      if (!userTopMap.has(row.userId)) {
        userTopMap.set(row.userId, { countryId: row.countryId, serviceType: row.serviceType });
      }
    }

    const { sendBulkPushNotifications } = await import('../services/fcmService');
    let sent = 0;
    let skipped = 0;

    for (const [userId, tokens] of Array.from(tokenMap.entries())) {
      const top = userTopMap.get(userId);
      if (!top) { skipped++; continue; }

      const user    = userMap.get(userId) as any;
      const rawLang = (user?.language || 'en').toLowerCase();
      const lang: Lang4 = (['ht','en','fr','es'].includes(rawLang) ? rawLang : 'en') as Lang4;
      const countryLabel = getCountryName(top.countryId, lang);
      const msgSet  = PERSONALIZED_SERVICE_MSGS[top.serviceType] || PERSONALIZED_FALLBACK;
      const { title: titleFn, body: bodyFn } = msgSet[lang];
      const title   = titleFn(countryLabel);
      const body    = bodyFn(countryLabel);

      const result = await sendBulkPushNotifications(tokens, { title, body, clickAction: '/' });
      sent += result.success;
      console.log(`✅ Personalized [${lang.toUpperCase()}] → user ${userId} | ${top.serviceType}/${top.countryId}: ${result.success}/${tokens.length}`);
    }

    console.log(`🎯 Personalized done — ${sent} sent, ${skipped} skipped (no history)`);
    return { sent, skipped };

  } catch (err: any) {
    console.error('❌ Personalized daily notification error:', err.message || err);
    return { sent: 0, skipped: 0 };
  }
}

export function startPersonalizedDailyScheduler(): void {
  if (personalizedDailyCronJob) {
    console.log('⚠️ Personalized daily scheduler already running');
    return;
  }

  console.log('🎯 Starting personalized daily scheduler — 10:30 AM Haiti time');

  personalizedDailyCronJob = cron.schedule('30 10 * * *', async () => {
    try {
      await sendPersonalizedDailyNotifications();
    } catch (err: any) {
      console.error('❌ Personalized daily cron error:', err.message || err);
    }
  }, { timezone: 'America/Port-au-Prince' });

  console.log('✅ Personalized daily scheduler started — fires at 10:30 AM Haiti time');
}

export function stopPersonalizedDailyScheduler(): void {
  if (personalizedDailyCronJob) {
    personalizedDailyCronJob.stop();
    personalizedDailyCronJob.destroy();
    personalizedDailyCronJob = null;
    console.log('🛑 Personalized daily scheduler stopped');
  }
}

export default {
  startFCMScheduler,
  stopFCMScheduler,
  startTokenRenewalScheduler,
  stopTokenRenewalScheduler,
  startTokenCleanupScheduler,
  stopTokenCleanupScheduler,
  startAllFCMSchedulers,
  stopAllFCMSchedulers,
  triggerManualNotification,
  getFCMSchedulerStatus,
  sendWelcomeNotification,
  sendTransactionNotification,
  sendPaymentSuccessNotification,
  sendPaymentFailureNotification,
  sendPromotionalNotification,
  sendCustomNotification,
  startTestNotificationScheduler,
  stopTestNotificationScheduler,
  getTestSchedulerStatus,
  sendReferralNotifications,
  startReferralNotificationScheduler,
  startTwentyMinuteScheduler,
  stopTwentyMinuteScheduler,
  sendTwentyMinuteNotification,
  startPersonalizedDailyScheduler,
  stopPersonalizedDailyScheduler,
  sendPersonalizedDailyNotifications
};
// ═══════════════════════════════════════════════════════════════════════════════
// 🎉 HOLIDAY PROMO NOTIFICATION SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

const PROD_URL = 'https://buyfasttopup.com';

// BuyFast promo images (7 images → mapped to holidays)
const PROMO_IMAGES = [
  `${PROD_URL}/promo/promo-sun.png`,  // 0 - fi jòn / Bon Ane + Nwèl
  `${PROD_URL}/promo/promo-mon.png`,  // 1 - fi mayo blou
  `${PROD_URL}/promo/promo-tue.png`,  // 2 - fi blazer blan
  `${PROD_URL}/promo/promo-wed.png`,  // 3 - fi oranj
  `${PROD_URL}/promo/promo-thu.png`,  // 4 - fi jòn fonds
  `${PROD_URL}/promo/promo-fri.png`,  // 5 - koup
  `${PROD_URL}/promo/promo-sat.png`,  // 6 - gason mayo
];

interface HolidayConfig {
  key: string;
  codeTag: string;
  discountPct: number;
  maxUses: number;
  durationHours: number;
  imageIdx: number;
  titles: { ht: string; en: string; fr: string; es: string };
  bodies:  { ht: string; en: string; fr: string; es: string };
  route: string;
}

// ─── Fixed-date holidays ─────────────────────────────────────────────────────
const FIXED_HOLIDAYS: Record<string, HolidayConfig> = {
  '01-01': {
    key: 'newyear', codeTag: 'BONANE', discountPct: 20, maxUses: 500, durationHours: 48, imageIdx: 0, route: '/topup',
    titles: { ht: '🎉 Bon Ane & Fèt Endepandans!', en: '🎉 Happy New Year!', fr: '🎉 Bonne Année!', es: '🎉 ¡Feliz Año Nuevo!' },
    bodies: {
      ht: 'BuyFast ap felisite ou pou ane {YEAR}! Itilize kòd {CODE} pou {PCT}% raba sou prochèn rechaj ou a 🇭🇹',
      en: 'BuyFast wishes you a wonderful {YEAR}! Use code {CODE} for {PCT}% off your next top-up 🎊',
      fr: 'BuyFast vous souhaite une merveilleuse année {YEAR}! Utilisez le code {CODE} pour {PCT}% de réduction 🎊',
      es: '¡BuyFast te desea un maravilloso {YEAR}! Usa el código {CODE} para {PCT}% de descuento 🎊',
    },
  },
  '02-14': {
    key: 'valentine', codeTag: 'VALENTINE', discountPct: 18, maxUses: 300, durationHours: 36, imageIdx: 4, route: '/topup',
    titles: { ht: '💝 Fèt Kè — Valentine!', en: '💝 Happy Valentine\'s Day!', fr: '💝 Bonne Saint-Valentin!', es: '💝 ¡Feliz San Valentín!' },
    bodies: {
      ht: 'Voye lajan bay moun ou renmen yo! Kòd {CODE} → {PCT}% raba jodi a 💕',
      en: 'Send money to your loved ones with {PCT}% off! Use code {CODE} today 💕',
      fr: 'Envoyez de l\'argent à vos proches avec {PCT}% de réduction! Code {CODE} 💕',
      es: '¡Envía dinero a tus seres queridos con {PCT}% de descuento! Código {CODE} 💕',
    },
  },
  '03-08': {
    key: 'womensday', codeTag: 'FANM', discountPct: 15, maxUses: 300, durationHours: 24, imageIdx: 2, route: '/topup',
    titles: { ht: '🌺 Jounen Entènasyonal Fanm!', en: '🌺 International Women\'s Day!', fr: '🌺 Journée Internationale des Femmes!', es: '🌺 ¡Día Internacional de la Mujer!' },
    bodies: {
      ht: 'Salye tout fanm fò yo! BuyFast ba ou kòd {CODE} pou {PCT}% raba jodi a 🌸',
      en: 'Celebrating all strong women! BuyFast gives you code {CODE} for {PCT}% off today 🌸',
      fr: 'Célébrons toutes les femmes fortes! BuyFast vous offre le code {CODE} pour {PCT}% de réduction 🌸',
      es: '¡Celebrando a todas las mujeres fuertes! BuyFast te da el código {CODE} para {PCT}% de descuento 🌸',
    },
  },
  '05-01': {
    key: 'laborday', codeTag: 'TRAVAY', discountPct: 12, maxUses: 200, durationHours: 24, imageIdx: 6, route: '/topup',
    titles: { ht: '👷 Fèt Travay — 1e Me!', en: '👷 Labor Day — May 1st!', fr: '👷 Fête du Travail — 1er Mai!', es: '👷 ¡Día del Trabajo — 1 de Mayo!' },
    bodies: {
      ht: 'Respè pou tout travayè yo! Kòd {CODE} → {PCT}% raba sou BuyFast 💪',
      en: 'Respect to all workers! Code {CODE} → {PCT}% off on BuyFast 💪',
      fr: 'Respect à tous les travailleurs! Code {CODE} → {PCT}% de réduction sur BuyFast 💪',
      es: '¡Respeto a todos los trabajadores! Código {CODE} → {PCT}% de descuento en BuyFast 💪',
    },
  },
  '05-18': {
    key: 'flagday', codeTag: 'DRAPO', discountPct: 20, maxUses: 400, durationHours: 24, imageIdx: 3, route: '/topup',
    titles: { ht: '🇭🇹 Fèt Drapo Ayiti — 18 Me!', en: '🇭🇹 Haiti Flag Day — May 18!', fr: '🇭🇹 Fête du Drapeau Haïtien!', es: '🇭🇹 ¡Día de la Bandera Haitiana!' },
    bodies: {
      ht: 'Viv Ayiti! 🇭🇹 Pwofite {PCT}% raba avèk kòd {CODE} — spesyal pou jou drapo a!',
      en: 'Long live Haiti! 🇭🇹 Enjoy {PCT}% off with code {CODE} — special for Flag Day!',
      fr: 'Vive Haïti! 🇭🇹 Profitez de {PCT}% de réduction avec le code {CODE} pour la Fête du Drapeau!',
      es: '¡Viva Haití! 🇭🇹 Disfruta {PCT}% de descuento con el código {CODE} — ¡especial para el Día de la Bandera!',
    },
  },
  '10-31': {
    key: 'halloween', codeTag: 'HALLOWEEN', discountPct: 15, maxUses: 200, durationHours: 24, imageIdx: 5, route: '/topup',
    titles: { ht: '🎃 Halloween — 31 Oktòb!', en: '🎃 Happy Halloween!', fr: '🎃 Joyeux Halloween!', es: '🎃 ¡Feliz Halloween!' },
    bodies: {
      ht: 'Kado espesyal Halloween! Kòd {CODE} → {PCT}% raba sou BuyFast 👻',
      en: 'Halloween special treat! Code {CODE} → {PCT}% off on BuyFast 👻',
      fr: 'Cadeau spécial Halloween! Code {CODE} → {PCT}% de réduction sur BuyFast 👻',
      es: '¡Truco o trato especial! Código {CODE} → {PCT}% de descuento en BuyFast 👻',
    },
  },
  '11-02': {
    key: 'allsouls', codeTag: 'FETMO', discountPct: 10, maxUses: 150, durationHours: 24, imageIdx: 1, route: '/topup',
    titles: { ht: '🕯️ Fèt Mò — 2 Novanm', en: '🕯️ All Souls Day', fr: '🕯️ La Toussaint', es: '🕯️ Día de los Fieles Difuntos' },
    bodies: {
      ht: 'Nan jou souvni sa a, BuyFast ba ou kòd {CODE} pou {PCT}% raba 🙏',
      en: 'On this day of remembrance, use code {CODE} for {PCT}% off on BuyFast 🙏',
      fr: 'En ce jour de souvenir, utilisez le code {CODE} pour {PCT}% de réduction 🙏',
      es: 'En este día de recuerdo, usa el código {CODE} para {PCT}% de descuento 🙏',
    },
  },
  '12-24': {
    key: 'xmaseve', codeTag: 'NWELVEY', discountPct: 22, maxUses: 400, durationHours: 48, imageIdx: 0, route: '/topup',
    titles: { ht: '🎄 Vey Nwèl — 24 Desanm!', en: '🎄 Christmas Eve!', fr: '🎄 Réveillon de Noël!', es: '🎄 ¡Nochebuena!' },
    bodies: {
      ht: 'Vey Nwèl rive! Rechaje pou fanmi ou avèk kòd {CODE} → {PCT}% raba 🎁',
      en: 'Christmas Eve is here! Top up for family with code {CODE} → {PCT}% off 🎁',
      fr: 'La veille de Noël est arrivée! Rechargez pour votre famille avec le code {CODE} → {PCT}% de réduction 🎁',
      es: '¡Nochebuena está aquí! Recarga para tu familia con el código {CODE} → {PCT}% de descuento 🎁',
    },
  },
  '12-25': {
    key: 'christmas', codeTag: 'NOEL', discountPct: 25, maxUses: 500, durationHours: 48, imageIdx: 0, route: '/topup',
    titles: { ht: '🎅 Jwayo Nwèl — BuyFast!', en: '🎅 Merry Christmas!', fr: '🎅 Joyeux Noël!', es: '🎅 ¡Feliz Navidad!' },
    bodies: {
      ht: 'Jwayo Nwèl! BuyFast gen kado pou ou: kòd {CODE} → {PCT}% raba sou tout rechaj 🎄✨',
      en: 'Merry Christmas! BuyFast has a gift for you: code {CODE} → {PCT}% off all top-ups 🎄✨',
      fr: 'Joyeux Noël! BuyFast a un cadeau pour vous: code {CODE} → {PCT}% de réduction sur toutes les recharges 🎄✨',
      es: '¡Feliz Navidad! BuyFast tiene un regalo para ti: código {CODE} → {PCT}% de descuento en todas las recargas 🎄✨',
    },
  },
  '12-31': {
    key: 'newyeareve', codeTag: 'REVE', discountPct: 20, maxUses: 400, durationHours: 36, imageIdx: 6, route: '/topup',
    titles: { ht: '🥂 Reveyon — 31 Desanm!', en: '🥂 New Year\'s Eve!', fr: '🥂 Réveillon du Nouvel An!', es: '🥂 ¡Nochevieja!' },
    bodies: {
      ht: 'Dènye jou ane a! Rechaje avèk kòd {CODE} pou {PCT}% raba — Bon Ane! 🎆',
      en: 'Last day of the year! Top up with code {CODE} for {PCT}% off — Happy New Year! 🎆',
      fr: 'Dernier jour de l\'année! Rechargez avec le code {CODE} pour {PCT}% de réduction — Bonne Année! 🎆',
      es: '¡Último día del año! Recarga con el código {CODE} para {PCT}% de descuento — ¡Feliz Año Nuevo! 🎆',
    },
  },
};

// ─── Dynamic holidays (Mother's/Father's Day) ────────────────────────────────
function getMothersDayDate(year: number): { month: number; day: number } {
  // 2nd Sunday of May
  let d = new Date(year, 4, 1); // May 1
  const firstSunday = (7 - d.getDay()) % 7;
  const secondSunday = firstSunday + 7;
  return { month: 5, day: secondSunday + 1 };
}

function getFathersDayDate(year: number): { month: number; day: number } {
  // 3rd Sunday of June
  let d = new Date(year, 5, 1); // June 1
  const firstSunday = (7 - d.getDay()) % 7;
  const thirdSunday = firstSunday + 14;
  return { month: 6, day: thirdSunday + 1 };
}

const MOTHERS_DAY_CONFIG: HolidayConfig = {
  key: 'mothersday', codeTag: 'MANMAN', discountPct: 20, maxUses: 400, durationHours: 48, imageIdx: 2, route: '/topup',
  titles: { ht: '💐 Fèt Manman — Bonne Fête!', en: '💐 Happy Mother\'s Day!', fr: '💐 Bonne Fête des Mères!', es: '💐 ¡Feliz Día de la Madre!' },
  bodies: {
    ht: 'Fèt Manman rive! Montre manman ou lanmou ou. Kòd {CODE} → {PCT}% raba 💕👩‍👧',
    en: 'Mother\'s Day is here! Show your mom some love with code {CODE} → {PCT}% off 💕👩‍👧',
    fr: 'La Fête des Mères est arrivée! Montrez votre amour avec le code {CODE} → {PCT}% de réduction 💕👩‍👧',
    es: '¡El Día de la Madre llegó! Muestra tu amor con el código {CODE} → {PCT}% de descuento 💕👩‍👧',
  },
};

const FATHERS_DAY_CONFIG: HolidayConfig = {
  key: 'fathersday', codeTag: 'PAPA', discountPct: 18, maxUses: 350, durationHours: 48, imageIdx: 5, route: '/topup',
  titles: { ht: '👨‍👦 Fèt Papa — Bonne Fête!', en: '👨‍👦 Happy Father\'s Day!', fr: '👨‍👦 Bonne Fête des Pères!', es: '👨‍👦 ¡Feliz Día del Padre!' },
  bodies: {
    ht: 'Fèt Papa rive! Rechaje pou papa ou avèk kòd {CODE} → {PCT}% raba 💪👨',
    en: 'Father\'s Day is here! Top up for dad with code {CODE} → {PCT}% off 💪👨',
    fr: 'La Fête des Pères est arrivée! Rechargez pour papa avec le code {CODE} → {PCT}% de réduction 💪👨',
    es: '¡El Día del Padre llegó! Recarga para papá con el código {CODE} → {PCT}% de descuento 💪👨',
  },
};

// ─── Get today's holiday config (if any) ─────────────────────────────────────
function getTodayHoliday(): HolidayConfig | null {
  const haiti = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Port-au-Prince' }));
  const mm = String(haiti.getMonth() + 1).padStart(2, '0');
  const dd = String(haiti.getDate()).padStart(2, '0');
  const key = `${mm}-${dd}`;
  const year = haiti.getFullYear();

  // Check fixed holidays first
  if (FIXED_HOLIDAYS[key]) return FIXED_HOLIDAYS[key];

  // Check Mother's Day
  const md = getMothersDayDate(year);
  if (haiti.getMonth() + 1 === md.month && haiti.getDate() === md.day) return MOTHERS_DAY_CONFIG;

  // Check Father's Day
  const fd = getFathersDayDate(year);
  if (haiti.getMonth() + 1 === fd.month && haiti.getDate() === fd.day) return FATHERS_DAY_CONFIG;

  return null;
}

// ─── Auto-generate holiday promo code ────────────────────────────────────────
async function autoGenerateHolidayCode(cfg: HolidayConfig): Promise<{ code: string; discountValue: string } | null> {
  try {
    const haiti = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Port-au-Prince' }));
    const mm  = String(haiti.getMonth() + 1).padStart(2, '0');
    const dd  = String(haiti.getDate()).padStart(2, '0');
    const codeStr = `BF-${cfg.codeTag}-${mm}${dd}`;

    const existing = await storage.getDiscountCodeByCode(codeStr);
    if (existing && existing.isActive && new Date(existing.expiresAt) > new Date()) {
      return { code: codeStr, discountValue: `${cfg.discountPct}%` };
    }

    const expiresAt = new Date(haiti.getTime() + cfg.durationHours * 60 * 60 * 1000);
    await storage.createDiscountCode({
      code:           codeStr,
      influencerName: 'BuyFast Holiday',
      discountType:   'percentage',
      discountValue:  String(cfg.discountPct),
      minAmount:      '0.00',
      maxUses:        cfg.maxUses,
      currentUses:    0,
      isActive:       true,
      isGuestOnly:    false,
      applicableTo:   'all',
      expiresAt,
      description:    `Holiday promo — ${cfg.key} — ${mm}/${dd} (${cfg.discountPct}%)`,
      createdBy:      SYSTEM_ADMIN_ID,
    });

    console.log(`🎉 Holiday code created: ${codeStr} (${cfg.discountPct}%, ${cfg.key})`);
    return { code: codeStr, discountValue: `${cfg.discountPct}%` };
  } catch (err: any) {
    console.error(`❌ Failed to create holiday code for ${cfg.key}:`, err.message);
    return null;
  }
}

// ─── Send holiday push notification ──────────────────────────────────────────
async function sendHolidayNotification(cfg: HolidayConfig): Promise<void> {
  try {
    const haiti = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Port-au-Prince' }));
    const year  = String(haiti.getFullYear());

    const promo = await autoGenerateHolidayCode(cfg);
    const code  = promo?.code ?? `BF-${cfg.codeTag}`;

    const replace = (s: string) =>
      s.replace('{CODE}', code).replace('{PCT}', String(cfg.discountPct)).replace('{YEAR}', year);

    const deviceTokens = await storage.getAllActiveDeviceTokens();
    if (!deviceTokens || deviceTokens.length === 0) {
      console.log(`📭 No device tokens — holiday notification [${cfg.key}] skipped`);
      return;
    }

    const allUsers = await storage.getAllUsers();
    const userMap  = new Map(allUsers.map((u: any) => [u.id, u]));
    const byLang: Map<string, string[]> = new Map();
    for (const dt of deviceTokens) {
      const lang = (userMap.get(dt.userId) as any)?.language || 'en';
      const supported = ['ht', 'en', 'fr', 'es'].includes(lang) ? lang : 'en';
      if (!byLang.has(supported)) byLang.set(supported, []);
      byLang.get(supported)!.push(dt.token);
    }

    const imageUrl = PROMO_IMAGES[cfg.imageIdx];
    const { sendBulkPushNotifications } = await import('../services/fcmService');

    let totalSuccess = 0, totalFailed = 0;
    for (const [lang, tokens] of Array.from(byLang.entries())) {
      const title = replace(cfg.titles[lang as keyof typeof cfg.titles] ?? cfg.titles.en);
      const body  = replace(cfg.bodies[lang  as keyof typeof cfg.bodies]  ?? cfg.bodies.en);
      const result = await sendBulkPushNotifications(tokens, {
        title,
        body,
        image: imageUrl,
        clickAction: cfg.route,
      });
      totalSuccess += result.success;
      totalFailed  += result.failed;
      console.log(`🌍 [${lang.toUpperCase()}] Holiday [${cfg.key}]: ${result.success} sent, ${result.failed} failed`);
    }

    console.log(`✅ Holiday notification [${cfg.key}] — ${totalSuccess} sent, ${totalFailed} failed`);
  } catch (err: any) {
    console.error(`❌ Holiday notification error [${cfg.key}]:`, err.message);
  }
}

// ─── Holiday cron job (fires at 8 AM Haiti time every day) ───────────────────
let holidayCronJob: ReturnType<typeof cron.schedule> | null = null;

export function startHolidayScheduler(): void {
  if (holidayCronJob) {
    console.log('⚠️ Holiday scheduler already running');
    return;
  }

  holidayCronJob = cron.schedule('0 8 * * *', async () => {
    try {
      const holiday = getTodayHoliday();
      if (!holiday) {
        console.log('📅 Today has no holiday — holiday scheduler idle');
        return;
      }
      console.log(`🎉 Holiday detected: ${holiday.key} — sending notifications!`);
      await sendHolidayNotification(holiday);
    } catch (err: any) {
      console.error('❌ Holiday cron error:', err.message);
    }
  }, { timezone: 'America/Port-au-Prince' });

  // Check immediately on startup (in case server restarted on a holiday)
  setTimeout(async () => {
    const holiday = getTodayHoliday();
    if (holiday) {
      console.log(`🎉 Startup holiday check: ${holiday.key} detected — sending!`);
      await sendHolidayNotification(holiday);
    }
  }, 5000);

  console.log('✅ Holiday scheduler started — fires at 8h AM Haiti time on holidays');
}

export function stopHolidayScheduler(): void {
  if (holidayCronJob) {
    holidayCronJob.stop();
    holidayCronJob.destroy();
    holidayCronJob = null;
    console.log('🛑 Holiday scheduler stopped');
  }
}

// Export for manual trigger via admin API
export { getTodayHoliday, sendHolidayNotification, autoGenerateHolidayCode };
