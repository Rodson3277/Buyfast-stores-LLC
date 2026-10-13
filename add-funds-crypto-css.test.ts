import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const globalCss = readFileSync("client/src/index.css", "utf8");
const scopedCss = readFileSync("client/src/pages/add-funds-crypto.css", "utf8");
const source = readFileSync("client/src/pages/add-funds.tsx", "utf8");

test("Add Funds crypto stays centered, readable and stable under global/mobile/PWA overrides", async () => {
  assert.match(source, /className="add-funds-crypto-action"/);
  assert.match(source, /disabled=\{cryptoLoading\}/);
  assert.match(source, /aria-busy=\{cryptoLoading\}/);
  assert.doesNotMatch(source, /₿ Crypto Payment/);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true, args: ["--no-sandbox"],
  });
  try {
    for (const width of [320, 360, 768, 1280]) {
      for (const standalone of [false, true]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        // Deliberately load globals LAST: component CSS must win in either order.
        const css = standalone ? globalCss.replaceAll("(display-mode: standalone)", "(min-width: 0px)") : globalCss;
        await page.setContent(`<style>${scopedCss}\n${css}</style>
          <main style="padding:12px"><button type="button" class="add-funds-crypto-action" data-testid="button-crypto-payment">
            <svg class="add-funds-crypto-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20"/></svg>
            <span class="add-funds-crypto-copy">
              <span class="add-funds-crypto-title">Crypto Payment (BTC, USDT, USDC…)</span>
              <span class="add-funds-crypto-description">No bank card needed — Pay with any crypto</span>
            </span>
          </button></main>`);
        const button = page.locator('[data-testid="button-crypto-payment"]');
        const inspect = () => button.evaluate(el => {
          const s = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const parts = [...el.querySelectorAll(".add-funds-crypto-icon, .add-funds-crypto-copy, .add-funds-crypto-title, .add-funds-crypto-description")];
          return {
            background: s.backgroundImage, color: s.color, opacity: s.opacity,
            align: s.alignItems, justify: s.justifyContent, direction: s.flexDirection,
            shadow: s.boxShadow, transform: s.transform, height: rect.height,
            overflow: el.scrollWidth > el.clientWidth,
            parts: parts.map(part => {
              const r = part.getBoundingClientRect(), p = getComputedStyle(part);
              return { center: r.x + r.width / 2, y: r.y, width: r.width, height: r.height,
                color: p.color, fill: p.fill, textFill: p.webkitTextFillColor, textAlign: p.textAlign };
            }),
            center: rect.x + rect.width / 2,
          };
        });
        const initial = await inspect();
        assert.equal(initial.background, "linear-gradient(to right, rgb(249, 115, 22), rgb(234, 179, 8))");
        assert.equal(initial.color, "rgb(36, 18, 0)");
        // WCAG relative luminance: assert actual computed foreground/background.
        const luminance = (rgb: string) => rgb.match(/\d+/g)!.map(Number)
          .map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4)
          .reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
        for (const stop of ["rgb(249, 115, 22)", "rgb(234, 179, 8)"])
          assert.ok((luminance(stop) + .05) / (luminance(initial.color) + .05) >= 4.5);
        assert.equal(initial.align, "center");
        assert.equal(initial.justify, "center");
        assert.equal(initial.direction, "column");
        assert.equal(initial.overflow, false);
        assert.equal(initial.parts[0].width, 28);
        assert.equal(initial.parts[0].height, 28);
        assert.ok(initial.height <= 140, `crypto button must stay compact, got ${initial.height}px`);
        assert.equal(initial.parts[0].fill, "none");
        for (const part of initial.parts) {
          assert.ok(Math.abs(part.center - initial.center) < 1);
          assert.equal(part.color, initial.color);
          assert.equal(part.textFill, initial.color);
        }
        await button.hover();
        const hovered = await inspect();
        assert.equal(hovered.background, "linear-gradient(to right, rgb(234, 88, 12), rgb(202, 138, 4))");
        assert.equal(hovered.shadow, "none");
        assert.equal(hovered.transform, "none");
        await button.focus();
        assert.equal(await button.evaluate(el => getComputedStyle(el).outlineWidth), "3px");
        await button.evaluate(el => {
          el.setAttribute("disabled", "");
          el.setAttribute("aria-busy", "true");
          el.insertAdjacentHTML("beforeend", '<svg class="add-funds-crypto-spinner" aria-hidden="true" viewBox="0 0 24 24"></svg>');
        });
        const loading = await inspect();
        assert.deepEqual(loading.parts, initial.parts, "loading must not move icon or copy");
        assert.equal(loading.height, initial.height);
        assert.equal(loading.opacity, "1");
        assert.equal(loading.background, initial.background);
        assert.equal(await page.locator(".add-funds-crypto-spinner").evaluate(el => getComputedStyle(el).position), "absolute");
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});
