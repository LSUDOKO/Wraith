import test from "node:test";
import assert from "node:assert";
import { handleFetchResultResponse, determineRelayAction } from "../src/lib.js";

test("handleFetchResultResponse - proxy 404 -> null", async () => {
  const response = new Response(null, { status: 404 });
  const result = await handleFetchResultResponse(response, "inst-123");
  assert.strictEqual(result, null);
});

test("handleFetchResultResponse - status >= 2 -> null", async () => {
  const response = Response.json({ status: 2 });
  const result = await handleFetchResultResponse(response, "inst-123");
  assert.strictEqual(result, null);
});

test("handleFetchResultResponse - status undefined -> null", async () => {
  const response = Response.json({ somethingElse: "hello" });
  const result = await handleFetchResultResponse(response, "inst-123");
  assert.strictEqual(result, null);
});

test("handleFetchResultResponse - proxy not ok throwing error", async () => {
  const response = new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" });
  await assert.rejects(
    async () => {
      await handleFetchResultResponse(response, "inst-123");
    },
    {
      message: "proxy returned 500 for inst-123"
    }
  );
});

test("handleFetchResultResponse - status < 2 -> returns body", async () => {
  const body = { status: 1, data: "0x123", signature: "0xabc" };
  const response = Response.json(body);
  const result = await handleFetchResultResponse(response, "inst-123");
  assert.deepStrictEqual(result, body);
});

test("determineRelayAction - status 1 with data -> relayed shape", () => {
  const result = { status: 1, data: "0x123", signature: "0xabc", submissionTag: "my-tag" };
  const action = determineRelayAction(result, "default-tag");
  assert.deepStrictEqual(action, {
    status: 1,
    data: "0x123",
    signature: "0xabc",
    submissionTag: "my-tag",
  });
});

test("determineRelayAction - status 1 with data (missing submissionTag) -> default tag", () => {
  const result = { status: 1, data: "0x123", signature: "0xabc" };
  const action = determineRelayAction(result, "default-tag");
  assert.deepStrictEqual(action, {
    status: 1,
    data: "0x123",
    signature: "0xabc",
    submissionTag: "default-tag",
  });
});

test("determineRelayAction - status != 1 -> skipped (null)", () => {
  const result1 = { status: 0, data: "0x123", signature: "0xabc" };
  const result2 = { status: 2, data: "0x123", signature: "0xabc" };
  
  assert.strictEqual(determineRelayAction(result1), null);
  assert.strictEqual(determineRelayAction(result2), null);
});

test("determineRelayAction - status 1 with no data or 0x -> skipped (null)", () => {
  assert.strictEqual(determineRelayAction({ status: 1, data: null }), null);
  assert.strictEqual(determineRelayAction({ status: 1, data: "" }), null);
  assert.strictEqual(determineRelayAction({ status: 1, data: "0x" }), null);
  assert.strictEqual(determineRelayAction(null), null);
});
