import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

const publicPages = [
  "about", "app-preview", "best-topup-app", "boss-revolution-alternative",
  "ding-alternative", "faq", "founder", "referral-landing", "reloadly-alternative",
  "send-money-haiti", "worldremit-alternative", "reviews", "not-found",
  "price-calculator", "moncash-coming-soon", "natcash-coming-soon",
  "cash-pick-coming-soon", "natcash-unavailable", "email-verification-help",
  "support", "enhanced-support", "send-airtime-haiti", "how-to-recharge",
  "security", "gift-card-brands", "gift-card-categories",
].map(name => `client/src/pages/${name}.tsx`);
for (const dir of ["client/src/pages/blog", "client/src/pages/countries"]) {
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".tsx")) publicPages.push(`${dir}/${file}`);
  }
}
const forbidden = /money\s*transfers?|send(?:ing)?\s*money|remittances?|moncash|natcash|cash[\s-]*pick[\s-]*up|cash\s*pick\b|voye\s*lajan|transf[eè]r(?:t)?s?\s+(?:d['’]argent|lajan)|enviar\s+dinero/i;
const locales = ["en", "fr", "ht", "es"].map(locale =>
  JSON.parse(readFileSync(`client/src/locales/${locale}.json`, "utf8")));

function visibleStrings(node: ts.Node): string[] {
  const strings: string[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isJsxText(child) || ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) {
      strings.push(child.text);
    }
    if (ts.isCallExpression(child) && child.expression.getText() === "t" &&
        child.arguments[0] && ts.isStringLiteral(child.arguments[0])) {
      const key = child.arguments[0].text;
      for (const locale of locales) {
        const value = key.split(".").reduce((value, part) => value?.[part], locale);
        if (typeof value === "string") strings.push(value);
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return strings;
}

test("secondary public headings and page titles do not promote unavailable financial services", () => {
  for (const file of publicPages) {
    const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const check = (node: ts.Node) => {
      const heading = ts.isJsxElement(node) &&
        /^(h[123]|CardTitle)$/.test(node.openingElement.tagName.getText(ast));
      const pageTitle = ts.isJsxAttribute(node) && /^(title|ogTitle)$/.test(node.name.getText(ast));
      // Titles/questions stored in data arrays are rendered by marketing card/FAQ loops.
      const dataTitle = ts.isPropertyAssignment(node) &&
        /^(title|q|question)$/.test(node.name.getText(ast).replace(/["']/g, ""));
      if (heading || pageTitle || dataTitle) {
        for (const text of visibleStrings(node)) {
          assert.doesNotMatch(text, forbidden, `${file}: ${text}`);
        }
      }
      ts.forEachChild(node, check);
    };
    check(ast);
  }
});

test("obsolete promotional endpoints use an accurate neutral availability page", () => {
  for (const name of ["moncash-coming-soon", "natcash-coming-soon", "cash-pick-coming-soon", "price-calculator"]) {
    assert.match(readFileSync(`client/src/pages/${name}.tsx`, "utf8"), /export \{ default \} from "\.\/natcash-unavailable"/);
  }
  const notice = readFileSync("client/src/pages/natcash-unavailable.tsx", "utf8");
  assert.match(notice, /Existing transaction history remains accessible/);
  assert.match(notice, /not cash transfers/);
  assert.doesNotMatch(readFileSync("client/src/pages/founder.tsx", "utf8"), /"2026_q1"/);
});