import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

test("switch, card and Pix actions and multiline labels stay centered", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    args: ["--no-sandbox"],
  });
  try {
    for (const width of [320, 390, 768, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 874 } });
      await page.setContent(`<style>${readFileSync("client/src/index.css", "utf8")}</style>
        <div style="width:${width - 80}px">
          <div class="topup-payment-methods">
            <button data-testid="button-stripe-pay" class="buyfast-pay-button"><svg width="20" height="20"></svg><span>Voye Rechaj</span></button>
            <div data-testid="stripe-pix-payment"><button><span>Konfime pou wè kòd Pix la epi kontinye ak peman an</span></button></div>
          </div>
          <button data-testid="button-switch-payment-method">Chanje metòd peman</button>
        </div>`);
      for (const button of await page.locator("button").all()) {
        const layout = await button.evaluate(el => {
          const b = el.getBoundingClientRect(), p = el.parentElement!.getBoundingClientRect();
          return {center: b.x + b.width / 2, parentCenter: p.x + p.width / 2,
            fits: b.width <= p.width, text: getComputedStyle(el).textAlign,
            justify: getComputedStyle(el).justifyContent};
        });
        assert.ok(Math.abs(layout.center - layout.parentCenter) < 1);
        assert.ok(layout.fits);
        assert.equal(layout.text, "center");
        assert.equal(layout.justify, "center");
      }
      await page.close();
    }
  } finally { await browser.close(); }
});
