import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const expected = {
  en: ["Mobile Top-Up / Airtime Recharge", "Digital Utilities / Bill Payments"],
  ht: ["Rechaj Mobil / Rechaj Kredi Telefòn", "Sèvis Piblik Dijital / Peman Fakti"],
  fr: ["Recharge Mobile / Crédit Téléphonique", "Services Publics Numériques / Paiement de Factures"],
  es: ["Recarga Móvil / Recarga de Saldo", "Servicios Públicos Digitales / Pago de Facturas"],
};

test("public core labels and promotional summaries align in all supported languages", () => {
  for (const [locale, labels] of Object.entries(expected)) {
    const copy = JSON.parse(readFileSync(`client/src/locales/${locale}.json`, "utf8"));
    assert.deepEqual([copy.services.mobileTopUp, copy.services.billPayment], labels);
    assert.doesNotMatch(
      `${copy.welcome.description} ${copy.operators.globalCoverage}`,
      /money transfer|send money|remittance|transf[eè]r|moncash|natcash/i,
    );
    // Hidden transaction terminology must not be falsified as utility payments.
    assert.notEqual(copy.services.moneyTransfer, copy.services.billPayment);
  }
});

test("navigation and service marketing use shared localized core labels", () => {
  for (const file of ["pages/welcome.tsx", "pages/services.tsx", "pages/dashboard.tsx", "components/Footer.tsx", "components/SupportedOperators.tsx"]) {
    const source = readFileSync(`client/src/${file}`, "utf8");
    assert.match(source, /t\(["']services\.mobileTopUp["']/);
    assert.match(source, /t\(["']services\.billPayment["']/);
  }
  assert.match(readFileSync("client/src/components/MainLayout.tsx", "utf8"), /label: t\("services\.mobileTopUp"\)/);
  const welcome = readFileSync("client/src/pages/welcome.tsx", "utf8");
  assert.doesNotMatch(welcome, /How do I send money via MonCash|MonCash and NatCash transfers typically|Beyond mobile top-ups, send money/);
  assert.doesNotMatch(welcome, /seoContent\.moncash|<h[123][^>]*>[^<]*(?:MonCash|NatCash|Cash Pick)/);
  const testimonials = readFileSync("client/src/components/HomepageTestimonials.tsx", "utf8");
  assert.doesNotMatch(testimonials, /testimonials\.reviews\.review[256]\./);
});