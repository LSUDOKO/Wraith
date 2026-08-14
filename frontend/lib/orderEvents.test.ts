import test from "node:test";
import assert from "node:assert";
import { scanWindows, describeEvent, type WraithLog } from "./orderEvents.ts";

// Coston2's RPC rejects any getLogs spanning more than 30 blocks. A window that
// is one block too wide fails outright and renders as "no events", which is
// indistinguishable from a genuinely quiet order.
test("scanWindows never spans more than the RPC limit", () => {
  for (const w of scanWindows(10_000n, 40)) {
    assert.ok(w.to - w.from <= 30n, `window ${w.from}-${w.to} is too wide`);
  }
});

test("scanWindows walks backwards from the head", () => {
  const windows = scanWindows(10_000n, 3);
  assert.strictEqual(windows[0].to, 10_000n);
  assert.ok(windows[1].to < windows[0].to);
});

test("scanWindows never asks for a negative block", () => {
  for (const w of scanWindows(10n, 40)) {
    assert.ok(w.from >= 0n, `window starts at ${w.from}`);
  }
});

test("scanWindows covers the requested depth", () => {
  const windows = scanWindows(10_000n, 10);
  assert.strictEqual(windows.length, 10);
});

function log(eventName: string, args: Record<string, unknown>): WraithLog {
  return {
    eventName,
    args,
    blockNumber: 42n,
    transactionHash: "0xabc",
    logIndex: 0,
  } as unknown as WraithLog;
}

test("describes creation with the escrowed amount", () => {
  const line = describeEvent(log("OrderCreated", { orderId: 1n, amountIn: 100n * 10n ** 18n }));
  assert.match(line!.text, /[Ss]ealed/);
  assert.match(line!.text, /100/);
});

test("describes a tick as an enclave evaluation", () => {
  const line = describeEvent(log("OrderTicked", { orderId: 1n, instructionId: "0x1234567890abcdef" }));
  assert.match(line!.text, /enclave/i);
});

// The peak is derived from public FTSO prices, so naming it leaks nothing. The
// trail distance below it is the secret, and no event carries that.
test("describes a tracked peak with its price", () => {
  const line = describeEvent(log("PeakTracked", { orderId: 1n, peakE18: 25n * 10n ** 17n }));
  assert.match(line!.text, /2\.5/);
  assert.match(line!.text, /peak/i);
});

test("describes a swap settlement", () => {
  const line = describeEvent(log("OrderExecuted", { orderId: 1n, action: 0, amountIn: 10n ** 18n, result: 2n * 10n ** 18n }));
  assert.match(line!.text, /swap/i);
  assert.strictEqual(line!.kind, "executed");
});

test("describes a redeem settlement", () => {
  const line = describeEvent(log("OrderExecuted", { orderId: 1n, action: 1, amountIn: 10n ** 18n, result: 1n }));
  assert.match(line!.text, /redeem/i);
});

// ACTION_TRACK settles nothing, so calling it a fill would be wrong.
test("describes a track result as recording, not settling", () => {
  const line = describeEvent(log("OrderExecuted", { orderId: 1n, action: 2, amountIn: 0n, result: 0n }));
  assert.doesNotMatch(line!.text, /fired|settled/i);
});

test("describes a cancellation with the refund", () => {
  const line = describeEvent(log("OrderCancelled", { orderId: 1n, refunded: 50n * 10n ** 18n }));
  assert.match(line!.text, /refund/i);
  assert.match(line!.text, /50/);
});

test("describes a relayed order as sponsored", () => {
  const line = describeEvent(
    log("OrderRelayed", { orderId: 1n, relayer: "0x00000000000000000000000000000000000000aa", fee: 10n ** 18n }),
  );
  assert.match(line!.text, /sponsor|relay/i);
});

// An event this build does not know about must be dropped, not rendered as
// "undefined" in the middle of someone's order history.
test("ignores an event it does not recognize", () => {
  assert.strictEqual(describeEvent(log("RouterSet", { router: "0x0" })), null);
});
