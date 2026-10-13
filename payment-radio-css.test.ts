import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { chromium } from "@playwright/test";

const css = readFileSync("client/src/index.css", "utf8");
const radioComponent = readFileSync("client/src/components/ui/radio-group.tsx", "utf8");

test("global action-button reset, sizing and glow selectors exclude Radix radios", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true, args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<button role="radio" class="buyfast-radio btn"></button><button id="action" class="btn">Continue</button>');
    const selectors: string[] = [];
    postcss.parse(css).walkRules(rule => {
      // Guard the actual global reset/geometry/hover rules, including rules
      // nested in mobile and standalone media queries (even when inactive).
      const properties = rule.nodes.filter(node => node.type === "decl").map(node => node.prop);
      if (properties.some(prop => ["all", "min-height", "min-width", "padding", "border-radius", "box-shadow", "transform"].includes(prop))) {
        for (const selector of rule.selectors) {
          if (/^(?:\* )?(?:button|\.btn)(?:[: ,]|$)/.test(selector) && !selector.includes(".buyfast-radio")) {
            selectors.push(selector);
          }
        }
      }
    });
    for (const selector of selectors) {
      const matches = await page.locator('[role="radio"]').evaluate((el, selector) =>
        // Check interactive pseudo-states without needing each media query active.
        el.matches(selector.replace(/:(hover|active|focus-visible|focus)\b/g, "")), selector);
      assert.equal(matches, false, `action-button selector leaked onto a radio: ${selector}`);
    }
    assert.ok(selectors.length > 0, "test must cover remaining global button overrides");
    assert.match(radioComponent, /"buyfast-radio"/);
    assert.match(radioComponent, /RadioGroupPrimitive\.Indicator/);
    assert.match(radioComponent, /aria-hidden="true" className="buyfast-radio-dot"/);
  } finally {
    await browser.close();
  }
});

test("payment rings stay compact, visible and glow-free in desktop, mobile and PWA CSS", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true, args: ["--no-sandbox"],
  });
  try {
    for (const width of [360, 1280]) {
      for (const standalone of [false, true]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        // Offline markup mirrors Radix output; no auth, app server, API or charge.
        // Activate only standalone CSS to exercise its boundary in a regular tab.
        const fixtureCss = standalone ? css.replaceAll("(display-mode: standalone)", "(min-width: 0px)") : css;
        await page.setContent(`<style>${fixtureCss}</style><div class="buyfast-payment-shell">
          <div class="topup-payment-option" data-selected="false" style="border:2px solid #e5e7eb;background:#fff;padding:16px">
            <button type="button" role="radio" aria-checked="false" data-state="unchecked" class="buyfast-radio" id="wallet"></button>
            <label for="wallet">Wallet</label>
          </div>
          <div class="topup-payment-option" data-selected="true" style="border:2px solid #e5e7eb;background:#fff;padding:16px">
            <button type="button" role="radio" aria-checked="true" data-state="checked" class="buyfast-radio" id="stripe">
              <span class="buyfast-radio-indicator"><span aria-hidden="true" class="buyfast-radio-dot"></span></span>
            </button><label for="stripe">Credit / debit card</label>
          </div>
          <button id="action">Continue</button></div>`);
        for (const id of ["wallet", "stripe"]) {
          const radio = page.locator(`#${id}`);
          await radio.hover();
          const style = await radio.evaluate(el => {
            const s = getComputedStyle(el);
            return { width: s.width, height: s.height, padding: s.padding, border: s.borderTopWidth,
              borderStyle: s.borderTopStyle, radius: s.borderRadius, shadow: s.boxShadow, transform: s.transform };
          });
          assert.deepEqual(style, { width: "20px", height: "20px", padding: "0px", border: "2px",
            borderStyle: "solid", radius: "50%", shadow: "none", transform: "none" });
        }
        // Use real keyboard navigation to activate :focus-visible.
        await page.locator("#wallet").focus();
        await page.keyboard.press("Tab");
        const focus = await page.locator("#stripe").evaluate(el => {
          const s = getComputedStyle(el);
          return [s.outlineStyle, s.outlineWidth, s.outlineOffset, s.boxShadow];
        });
        assert.deepEqual(focus, ["solid", "2px", "3px", "none"]);
        const dot = await page.locator(".buyfast-radio-dot").evaluate(el => {
          const s = getComputedStyle(el);
          return [s.width, s.height, s.backgroundColor];
        });
        assert.deepEqual(dot, ["8px", "8px", "rgb(0, 66, 76)"]);
        const cards = await page.locator(".topup-payment-option").evaluateAll(els => els.map(el => {
          const s = getComputedStyle(el);
          return [s.borderTopColor, s.backgroundColor];
        }));
        assert.notDeepEqual(cards[0], cards[1]);
        assert.deepEqual(cards[1], ["rgb(0, 137, 123)", "rgb(238, 250, 247)"]);
        assert.equal(await page.locator("#action").evaluate(el => getComputedStyle(el).minHeight), "48px");
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});
