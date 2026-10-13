import test from "node:test";
import assert from "node:assert/strict";
import { popularCryptoFirst } from "../client/src/lib/cryptoDisplayOrder";

test("popular coins appear first without changing available coins or exact networks", () => {
  const coins = [
    { code: "other", ticker: "OTHER" },
    { code: "eth", ticker: "ETH" },
    { code: "usdttrc20", ticker: "usdt" },
    { code: "btc", ticker: "BTC" },
    { code: "usdterc20", ticker: "USDT" },
    { code: "usdc", ticker: "USDC" },
  ];
  const before = JSON.stringify(coins);
  const sorted = popularCryptoFirst(coins);
  assert.deepEqual(sorted.map(c => c.code), ["usdttrc20", "usdterc20", "btc", "eth", "usdc", "other"]);
  assert.equal(JSON.stringify(coins), before);
  assert.ok(sorted.every(c => coins.includes(c)));
  assert.deepEqual(popularCryptoFirst([]), []);
});
