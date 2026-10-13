import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

test("Dashboard Top-Up glow has no overlay or halo outside its label", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true, args: ["--no-sandbox"] });
  try {
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 874 } });
      await page.setContent(`<style>${readFileSync("client/src/index.css", "utf8")}</style>
        <section><div data-testid="dashboard-balance-card" style="position:relative">
          <p>Balance</p><button style="box-shadow:0 3px 10px green">Add Funds</button></div>
          <button class="topup-row-btn"><span class="topup-btn-icon">Icon</span>
            <span class="topup-btn-label">Mobile Top-Up</span><span class="topup-btn-chevron">Next</span></button></section>`);
      const button = page.locator(".topup-row-btn");
      for (const hover of [false, true]) {
        if (hover) await button.hover();
        const result = await button.evaluate(el => {
          const s = getComputedStyle(el);
          return { position: s.position, overflow: s.overflow, shadow: s.boxShadow,
            transform: s.transform, animation: s.animationName,
            before: getComputedStyle(el, "::before").content, after: getComputedStyle(el, "::after").content };
        });
        assert.deepEqual(result, { position: "relative", overflow: "hidden", shadow: "none",
          transform: "none", animation: "none", before: "none", after: "none" });
      }
      for (const selector of ['[data-testid="dashboard-balance-card"]', '[data-testid="dashboard-balance-card"] > button'])
        assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).boxShadow), "none");
      for (const selector of [".topup-btn-icon", ".topup-btn-chevron"])
        assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).animationName), "none");
      assert.equal(await page.locator(".topup-btn-label").evaluate(el => getComputedStyle(el).animationName), "topup-label-shine");
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(await page.locator(".topup-btn-label").evaluate(el => getComputedStyle(el).animationName), "none");
      await page.close();
    }
  } finally { await browser.close(); }
});

test("Send Top-Up effect affects only its text, not adjacent controls or button geometry", async () => {
  const css = readFileSync("client/src/index.css", "utf8");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.setContent(`<style>${css}</style>
      <button class="buyfast-pay-button" data-testid="button-send-topup"><span class="send-topup-label">Send Top-Up</span></button>
      <button id="other">Other payment</button>`);
    const other = page.locator("#other");
    const style = (el: Element) => { const s = getComputedStyle(el);
      return { transform: s.transform, shadow: s.boxShadow, text: s.textShadow }; };
    const before = await other.evaluate(style);
    await other.hover();
    assert.deepEqual(await other.evaluate(style), before);
    const button = page.locator('[data-testid="button-send-topup"]');
    await button.hover();
    assert.equal((await button.evaluate(style)).transform, "none");
    assert.equal((await button.evaluate(style)).shadow, "none");
    assert.notEqual((await button.locator("span").evaluate(style)).text, "none");
    assert.deepEqual(await other.evaluate(style), before);
    await button.evaluate(el => (el as HTMLButtonElement).disabled = true);
    assert.equal((await button.locator("span").evaluate(style)).text, "none");
  } finally { await browser.close(); }
});
