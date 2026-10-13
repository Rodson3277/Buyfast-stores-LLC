import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

test("Add Funds payment methods share the card choice width on mobile and desktop", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true, args: ["--no-sandbox"] });
  try {
    for (const width of [320, 390, 768, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 874 } });
      await page.setContent(`<style>${readFileSync("client/src/pages/add-funds-crypto.css", "utf8")}
        ${readFileSync("client/src/index.css", "utf8")}</style>
        <main style="width:calc(100% - 32px);margin:auto">
          <div id="card" style="width:100%;box-sizing:border-box">Card</div>
          <button class="add-funds-crypto-action" data-testid="button-crypto-payment">Crypto</button>
          <button data-testid="button-pix">Pix</button>
          <button disabled data-testid="button-moncash-disabled">MonCash</button>
          <div data-testid="link-bank-funding">Bank</div>
        </main>`);
      const bounds = await page.locator("#card").boundingBox();
      for (const id of ["button-crypto-payment", "button-pix", "button-moncash-disabled", "link-bank-funding"]) {
        const actual = await page.locator(`[data-testid="${id}"]`).boundingBox();
        assert.ok(Math.abs(actual!.width - bounds!.width) < 1, `${id} width at ${width}px`);
        assert.ok(Math.abs(actual!.x - bounds!.x) < 1, `${id} alignment at ${width}px`);
      }
      await page.close();
    }
  } finally { await browser.close(); }
});
