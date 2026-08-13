import test from "node:test";
import assert from "node:assert";
import { scrub } from "./scrub.ts";

test("scrub strips 0x-prefixed hex strings", () => {
  const original = "The contract address is 0x3d893C53D9e8056135C26C8c638B76C8b60Df726 and the tx is 0xdeadbeef12345";
  const expected = "The contract address is [SCRUBBED_HEX] and the tx is [SCRUBBED_HEX]";
  assert.strictEqual(scrub(original), expected);
});

test("scrub strips XRPL classic addresses starting with r", () => {
  const original = "XRPL address r9cZA1zs9m8Czzpq9A5Cgi8TzzepG8YYYY";
  const expected = "XRPL address [SCRUBBED_ADDRESS]";
  assert.strictEqual(scrub(original), expected);
});

test("scrub strips naked hex-like strings of length >= 8", () => {
  const original = "The hash deadbeef is stripped, but short hex de or cafe is not if it is too short, unless it is part of a longer hex sequence.";
  const expected = "The hash [SCRUBBED_HEX] is stripped, but short hex de or cafe is not if it is too short, unless it is part of a longer hex sequence.";
  assert.strictEqual(scrub(original), expected);
});

test("scrub recursively processes nested objects and arrays", () => {
  const payload = {
    user: "0x1234567890123456789012345678901234567890",
    order: {
      id: 42,
      txHash: "0xabcdef0123456789",
      notes: "Destination is r9cZA1zs9m8Czzpq9A5Cgi8TzzepG8YYYY",
    },
    list: ["0x2345", "0xdeadbeefcafe", { embedded: "0x99999" }],
  };

  const expected = {
    user: "[SCRUBBED_HEX]",
    order: {
      id: 42,
      txHash: "[SCRUBBED_HEX]",
      notes: "Destination is [SCRUBBED_ADDRESS]",
    },
    list: ["[SCRUBBED_HEX]", "[SCRUBBED_HEX]", { embedded: "[SCRUBBED_HEX]" }],
  };

  assert.deepStrictEqual(scrub(payload), expected);
});

test("scrub is a no-op for non-string primitives", () => {
  assert.strictEqual(scrub(123), 123);
  assert.strictEqual(scrub(true), true);
  assert.strictEqual(scrub(null), null);
  assert.strictEqual(scrub(undefined), undefined);
});
