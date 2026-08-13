import test from "node:test";
import assert from "node:assert";
import {
  toUtf8HexString,
  calculateRoundId,
  isAttestationFresh,
  buildWeb2JsonRequestBody,
} from "../src/attest.js";

// The verifier rejects a request whose attestation type is not a 32-byte,
// right-padded UTF-8 hex string. Getting the padding wrong fails at the API,
// far from the code that caused it.
test("toUtf8HexString pads to 32 bytes", () => {
  const encoded = toUtf8HexString("Web2Json");
  assert.strictEqual(encoded.length, 66, "want 0x + 64 hex chars");
  assert.ok(encoded.startsWith("0x576562324a736f6e".slice(0, 10)) || encoded.startsWith("0x"));
  assert.strictEqual(encoded, "0x" + Buffer.from("Web2Json", "utf8").toString("hex").padEnd(64, "0"));
});

test("toUtf8HexString encodes the source id the same way", () => {
  assert.strictEqual(
    toUtf8HexString("PublicWeb2"),
    "0x" + Buffer.from("PublicWeb2", "utf8").toString("hex").padEnd(64, "0"),
  );
});

// The round id is derived from the block the request landed in, not returned by
// the hub. An off-by-one here means fetching a proof that does not exist yet.
test("calculateRoundId floors into the voting epoch", () => {
  assert.strictEqual(calculateRoundId(1000n, 1000n, 90n), 0);
  assert.strictEqual(calculateRoundId(1089n, 1000n, 90n), 0);
  assert.strictEqual(calculateRoundId(1090n, 1000n, 90n), 1);
  assert.strictEqual(calculateRoundId(1179n, 1000n, 90n), 1);
});

// An attestation older than the enclave will accept is worse than none: the tick
// costs a fee and then fails inside the TEE where the keeper cannot see why.
test("isAttestationFresh accepts a recent reading", () => {
  assert.strictEqual(isAttestationFresh({ fetchedAt: 1_000 }, 1_000 + 300_000), true);
});

test("isAttestationFresh rejects one past the reuse window", () => {
  assert.strictEqual(isAttestationFresh({ fetchedAt: 1_000 }, 1_000 + 1_200_000), false);
});

test("isAttestationFresh rejects a missing attestation", () => {
  assert.strictEqual(isAttestationFresh(null, 1_000), false);
});

// The enclave compares the attested value against a threshold scaled to 1e18,
// so the jq the keeper sends must produce that scale — and must name the three
// fields the contract decodes, in order.
test("buildWeb2JsonRequestBody carries url, jq and the reading signature", () => {
  const body = buildWeb2JsonRequestBody({
    FDC_API_URL: "https://api.example/price",
    FDC_QUERY_PARAMS: '{"ids":"flare"}',
    FDC_JQ: "{source: \"x\", valueE18: 1, timestamp: 2}",
  });

  assert.strictEqual(body.url, "https://api.example/price");
  assert.strictEqual(body.httpMethod, "GET");
  assert.strictEqual(body.queryParams, '{"ids":"flare"}');
  assert.strictEqual(body.postProcessJq, "{source: \"x\", valueE18: 1, timestamp: 2}");

  const signature = JSON.parse(body.abiSignature);
  assert.deepStrictEqual(
    signature.components.map((c) => c.name),
    ["source", "valueE18", "timestamp"],
  );
  assert.deepStrictEqual(
    signature.components.map((c) => c.type),
    ["string", "uint256", "uint256"],
  );
});

test("buildWeb2JsonRequestBody defaults the optional JSON fields to {}", () => {
  const body = buildWeb2JsonRequestBody({ FDC_API_URL: "https://api.example/price" });
  assert.strictEqual(body.headers, "{}");
  assert.strictEqual(body.body, "{}");
  assert.strictEqual(body.queryParams, "{}");
});
