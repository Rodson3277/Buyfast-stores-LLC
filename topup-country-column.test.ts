import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

test("country choices are full-width consecutive rows at every viewport", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true, args: ["--no-sandbox"] });
  try {
    for (const width of [320, 390, 768, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 874 } });
      await page.setContent(`<style>${readFileSync("client/src/index.css", "utf8")}</style>
        <div class="topup-country-options" style="width:280px">
          <button data-testid="country-option-AF"><div>Afghanistan</div></button>
          <button data-testid="country-option-AL"><div>Albania</div></button>
          <button data-testid="country-option-AS"><div>American Samoa</div></button>
        </div>`);
      const rows = await page.locator('button').evaluateAll(nodes => nodes.map(el => {
        const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, bottom: r.bottom };
      }));
      for (let i = 0; i < rows.length; i++) {
        assert.equal(rows[i].width, 280);
        assert.equal(rows[i].x, rows[0].x);
        if (i) assert.ok(rows[i].y >= rows[i - 1].bottom);
      }
      await page.close();
    }
  } finally { await browser.close(); }
});
