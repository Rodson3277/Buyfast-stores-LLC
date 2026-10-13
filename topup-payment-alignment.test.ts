import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

test("topup methods have equal widths and centered contents", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    args: ["--no-sandbox"],
  });
  try {
    for (const width of [320, 390, 768, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 874 } });
      await page.setContent(`<style>${readFileSync("client/src/index.css", "utf8")}</style>
        <div class="topup-payment-methods" style="width:${width - 64}px">
          <div class="topup-payment-option" data-selected="true"><label id="wallet">Balans Bous <span>$185.51</span></label></div>
          <div class="topup-payment-option"><label id="payment-method-stripe">Kat Kredi/Debi</label></div>
          <button data-testid="button-topup-pix"><svg></svg><span>Pix · BRL</span></button>
          <div class="topup-payment-option"><label id="moncash">MonCash</label></div>
          <div class="topup-payment-option"><label id="payment-method-paypal">PayPal</label></div>
          <div><button data-testid="button-send-topup"><span class="send-topup-label">Voye Rechaj</span></button></div>
        </div>`);
      const rows = await page.locator(".topup-payment-option, [data-testid='button-topup-pix']").evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect();
        const first = node.firstElementChild!.getBoundingClientRect();
        const last = node.lastElementChild!.getBoundingClientRect();
        return { x: box.x, width: box.width, center: box.x + box.width / 2,
          contentCenter: (first.x + last.right) / 2 };
      }));
      for (const row of rows) {
        assert.equal(row.width, width - 64);
        assert.equal(row.x, rows[0].x);
        assert.ok(Math.abs(row.center - row.contentCenter) < 1);
      }
      const colors = await page.locator(".topup-payment-option, [data-testid='button-topup-pix']")
        .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
      assert.equal(new Set(colors).size, 5, "Each method keeps its own color, even when selected");
      const button = await page.locator('[data-testid="button-send-topup"]').boundingBox();
      const container = await page.locator(".topup-payment-methods").boundingBox();
      assert.ok(button && container);
      assert.ok(Math.abs(button.x + button.width / 2 - container.x - container.width / 2) < 1);
      for (const method of ["wallet", "card", "pix", "paypal"]) {
        await page.locator(".topup-payment-methods").evaluate((node, selected) => {
          node.setAttribute("data-focused-method", selected);
        }, method);
        const visible = await page.locator(".topup-payment-option:visible, [data-testid='button-topup-pix']:visible").count();
        assert.equal(visible, 1, `Only ${method} is visible after selection`);
      }
      await page.locator(".topup-payment-methods").evaluate(node => node.removeAttribute("data-focused-method"));
      assert.equal(await page.locator(".topup-payment-option:visible, [data-testid='button-topup-pix']:visible").count(), 5);
      await page.close();
    }
  } finally { await browser.close(); }
});
