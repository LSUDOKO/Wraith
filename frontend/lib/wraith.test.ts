import test from "node:test";
import assert from "node:assert";
import { e18ToPrice, formatCipher, priceToE18, sourceAddressHash } from "./wraith.ts";

const E18 = 10n ** 18n;

// priceToE18 turns what a trader types into the threshold the enclave compares
// against. If the scale is wrong the order fires at the wrong price, so every
// input shape a person can plausibly type gets a case.
test("priceToE18 scales a whole number", () => {
  assert.strictEqual(priceToE18("2"), 2n * E18);
});

test("priceToE18 scales a decimal", () => {
  assert.strictEqual(priceToE18("2.5"), 2n * E18 + 5n * 10n ** 17n);
});

test("priceToE18 pads a short fraction rather than left-aligning it", () => {
  // "0.05" must be 5e16, not 5e17 — a 10x error in the trigger price.
  assert.strictEqual(priceToE18("0.05"), 5n * 10n ** 16n);
});

test("priceToE18 handles a leading-dot price", () => {
  assert.strictEqual(priceToE18(".5"), 5n * 10n ** 17n);
});

test("priceToE18 handles a trailing dot", () => {
  assert.strictEqual(priceToE18("2."), 2n * E18);
});

test("priceToE18 ignores surrounding whitespace", () => {
  assert.strictEqual(priceToE18("  2.5  "), 2n * E18 + 5n * 10n ** 17n);
});

test("priceToE18 truncates beyond 18 decimals instead of overflowing scale", () => {
  // 19 decimal places: the 19th must be dropped, not shift everything.
  assert.strictEqual(priceToE18("1.0000000000000000009"), E18);
});

test("priceToE18 keeps full 18-decimal precision", () => {
  assert.strictEqual(priceToE18("1.000000000000000001"), E18 + 1n);
});

// formatCipher renders the sealed condition. It must never imply the bytes are
// shorter than they are, or a demo viewer could think the whole order is shown.
test("formatCipher groups bytes in pairs", () => {
  assert.strictEqual(formatCipher("0xdeadbeef", 4), "de ad be ef");
});

test("formatCipher reports how many bytes it withheld", () => {
  const result = formatCipher("0xdeadbeefcafe", 2);
  assert.strictEqual(result, "de ad … +4 bytes");
});

test("formatCipher handles an empty ciphertext without inventing bytes", () => {
  assert.strictEqual(formatCipher("0x", 4), "");
});

// The vector Flare publishes for XRPL. Matching a documented value proves the
// hash is the one FDC computes, not merely one both halves of this repo agree
// on — the enclave would happily match two identically wrong hashes.
test("sourceAddressHash matches the FDC standard address hash for XRPL", () => {
  assert.strictEqual(
    sourceAddressHash("rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv"),
    "0xa491aed10a1920ca31a85ff29e4bc410705d37d4dc9e690d4d500bcedfd8078f",
  );
});

test("sourceAddressHash ignores whitespace around a pasted address", () => {
  assert.strictEqual(
    sourceAddressHash("  rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv\n"),
    sourceAddressHash("rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv"),
  );
});

// The chart works in plain numbers and the contract works in 1e18 integers, so
// a click on the chart has to survive a round trip through both. A drift here
// moves someone's stop without telling them.
test("e18ToPrice inverts priceToE18", () => {
  for (const input of ["2", "2.5", "0.00600315", "1234.5678", "0"]) {
    assert.strictEqual(e18ToPrice(priceToE18(input)), Number(input));
  }
});

test("e18ToPrice returns zero for an undefined threshold", () => {
  assert.strictEqual(e18ToPrice(undefined), 0);
});

test("e18ToPrice keeps sub-cent precision", () => {
  // FLR trades near six-thousandths of a dollar; rounding to cents would put
  // every threshold at zero.
  assert.ok(e18ToPrice(priceToE18("0.006003")) > 0.006);
});
