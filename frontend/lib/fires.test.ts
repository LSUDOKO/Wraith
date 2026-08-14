import test from "node:test";
import assert from "node:assert";
import { simulate, type SimInput } from "./fires.ts";

// This readout is the last thing a user sees before money is escrowed. Every
// number here is one they will act on, so each case below names the real
// mistake it prevents.

const NOW = 1_700_000_000;

function base(): SimInput {
  return {
    mode: "price",
    price: 2,
    direction: "below",
    thresholdE18: 2_000_000_000_000_000_000n, // $2.00
    escrow: 100,
    minOut: 150,
    action: "swap",
    expirySec: NOW + 86_400,
    nowSec: NOW,
  };
}

test("reports distance to a stop that is still below the price", () => {
  const out = simulate({ ...base(), price: 2.5 });
  assert.strictEqual(out.crossed, false);
  // (2.5 - 2) / 2.5 = 20%
  assert.strictEqual(out.distancePct?.toFixed(1), "20.0");
});

test("reports distance to a take-profit that is still above the price", () => {
  const out = simulate({ ...base(), direction: "above", price: 1.6 });
  assert.strictEqual(out.crossed, false);
  // (2 - 1.6) / 1.6 = 25%
  assert.strictEqual(out.distancePct?.toFixed(1), "25.0");
});

// A stop set the wrong side of the market fires on the very next tick. Users do
// this by accident constantly, and the escrow is already committed by then.
//
// `crossed` is the whole signal on purpose: the "already crossed" wording lives
// in FiresAt's own rendering of the leg line (glyph plus text), not duplicated
// into `warnings` here, so the same fact is never reported twice.
test("flags a below-stop that the price has already crossed", () => {
  const out = simulate({ ...base(), price: 1.8 });
  assert.strictEqual(out.crossed, true);
  assert.strictEqual(out.nearestLeg, "stop");
});

test("flags an above-target that the price has already crossed", () => {
  const out = simulate({ ...base(), direction: "above", price: 2.4 });
  assert.strictEqual(out.crossed, true);
});

test("treats a price exactly at the threshold as crossed", () => {
  // The enclave's comparison is inclusive, so the readout must agree with it.
  assert.strictEqual(simulate({ ...base(), price: 2 }).crossed, true);
});

// With a bracket, whichever leg is nearer is the one that will actually fire.
test("measures distance to the nearer bracket leg", () => {
  const out = simulate({
    ...base(),
    price: 4,
    takeProfitE18: 5_000_000_000_000_000_000n, // $5 take-profit, $2 stop
  });
  // 25% up to $5 beats 50% down to $2.
  assert.strictEqual(out.distancePct?.toFixed(1), "25.0");
  assert.strictEqual(out.nearestLeg, "take-profit");
});

test("a bracket is crossed when either leg is", () => {
  const out = simulate({ ...base(), price: 6, takeProfitE18: 5_000_000_000_000_000_000n });
  assert.strictEqual(out.crossed, true);
});

test("estimates the swap output from the live price", () => {
  const out = simulate({ ...base(), price: 2, escrow: 100 });
  assert.strictEqual(out.estimatedOut, 200);
});

// A floor above what the trade would actually return means the swap reverts on
// slippage protection — the order fires and then fails, which is the worst of
// both outcomes.
test("warns when the minimum output exceeds the estimate", () => {
  const out = simulate({ ...base(), price: 2, escrow: 100, minOut: 500 });
  assert.ok(out.warnings.some((w) => /minimum/i.test(w)));
});

test("does not warn when the minimum output is under the estimate", () => {
  const out = simulate({ ...base(), price: 2, escrow: 100, minOut: 150 });
  assert.ok(!out.warnings.some((w) => /minimum/i.test(w)));
});

test("warns about an expiry in the past", () => {
  const out = simulate({ ...base(), expirySec: NOW - 1 });
  assert.ok(out.warnings.some((w) => /expir/i.test(w)));
});

// A redemption with no destination cannot settle; the enclave rejects the terms
// and the order simply never fires.
test("warns when a redeem order names no XRPL destination", () => {
  const out = simulate({ ...base(), action: "redeem", xrplAddress: "" });
  assert.ok(out.warnings.some((w) => /XRPL/i.test(w)));
});

test("does not warn once a redeem order has a destination", () => {
  const out = simulate({ ...base(), action: "redeem", xrplAddress: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe" });
  assert.ok(!out.warnings.some((w) => /XRPL/i.test(w)));
});

// A redeem is lot-granular, so the swap estimate would be a lie.
test("does not estimate an output for a redeem", () => {
  assert.strictEqual(simulate({ ...base(), action: "redeem" }).estimatedOut, undefined);
});

test("computes a trailing stop from the peak and trail", () => {
  const out = simulate({ ...base(), mode: "trailing", price: 2, peak: 2.5, trailPct: 10 });
  assert.strictEqual(out.trailStop, 2.25);
});

test("says a trailing order has no peak until its first tick", () => {
  const out = simulate({ ...base(), mode: "trailing", price: 2, peak: 0, trailPct: 10 });
  assert.strictEqual(out.trailStop, undefined);
});

// A stealth order has no single trigger price, so reporting a distance would be
// describing a condition it does not have.
test("a stealth order reports no threshold distance", () => {
  const out = simulate({ ...base(), mode: "stealth", chunks: 6, hours: 4 });
  assert.strictEqual(out.distancePct, undefined);
  assert.strictEqual(out.crossed, false);
});

test("survives a feed that has not answered yet", () => {
  const out = simulate({ ...base(), price: undefined });
  assert.strictEqual(out.distancePct, undefined);
  assert.strictEqual(out.estimatedOut, undefined);
});
