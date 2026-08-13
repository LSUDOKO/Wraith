import test from "node:test";
import assert from "node:assert";
import { describe as describeTerms, type RecalledTerms } from "./recall.ts";

// An order's ciphertext is encrypted to the enclave, not to the user, so this
// local description is the only way someone can see what they set. Describing
// the wrong kind is therefore worse than describing nothing: it tells a trader
// a confident lie about where their money exits.

function base(): RecalledTerms {
  return {
    mode: "price",
    direction: "below",
    threshold: "2.00",
    action: "swap",
    minOutOrLots: "150",
    escrow: "100",
    sealedAt: 0,
  };
}

test("describes a stop-loss", () => {
  const text = describeTerms(base());
  assert.match(text, /falls to \$2\.00/);
  assert.match(text, /swap/);
});

test("describes a take-profit on the other side", () => {
  const text = describeTerms({ ...base(), direction: "above" });
  assert.match(text, /rises to \$2\.00/);
});

test("describes a bracket's second leg", () => {
  const text = describeTerms({ ...base(), takeProfit: "5.00" });
  assert.match(text, /\$5\.00/);
});

test("describes a redeem action as going to XRP", () => {
  assert.match(describeTerms({ ...base(), action: "redeem" }), /XRP/);
});

test("describes a trailing stop by its trail, not by a price", () => {
  const text = describeTerms({ ...base(), mode: "trailing", trailPct: "5" });
  assert.match(text, /5%/);
  assert.match(text, /peak/i);
  assert.doesNotMatch(text, /falls to \$2\.00/);
});

test("describes a stealth order by its schedule", () => {
  const text = describeTerms({ ...base(), mode: "stealth", chunks: "6", hours: "4" });
  assert.match(text, /6/);
  assert.match(text, /4/);
  assert.doesNotMatch(text, /falls to \$2\.00/);
});

test("describes a shield by the agent and the floor", () => {
  const text = describeTerms({
    ...base(),
    mode: "shield",
    agent: "0x55c81526aFF1A9EFcCB1FE64B5E85bF3F6A02b6E",
    collateralFloor: "120",
  });
  assert.match(text, /120%/);
  assert.match(text, /0x55c815/);
  assert.doesNotMatch(text, /falls to \$2\.00/);
});

test("describes a cross-chain trigger by the payment it waits for", () => {
  const text = describeTerms({
    ...base(),
    mode: "crosschain",
    watchAddress: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
    watchAmount: "100",
  });
  assert.match(text, /100/);
  assert.match(text, /rPT1Sjq/);
  assert.doesNotMatch(text, /falls to \$2\.00/);
});

test("describes a consensus order as needing both oracles", () => {
  const text = describeTerms({ ...base(), mode: "consensus", deviationPct: "2" });
  assert.match(text, /falls to \$2\.00/);
  assert.match(text, /both|two/i);
  assert.match(text, /2%/);
});

// An order sealed before the mode was recorded must still read sensibly rather
// than crashing or claiming to be something it is not.
test("treats a recall with no mode as a price order", () => {
  const { mode: _drop, ...legacy } = base();
  assert.match(describeTerms(legacy as RecalledTerms), /falls to \$2\.00/);
});
