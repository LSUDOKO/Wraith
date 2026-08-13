import test from "node:test";
import assert from "node:assert";
import {
  handleFetchResultResponse,
  determineRelayAction,
  calculateBackoff,
  incrementFailure,
  resetFailure,
  isExceeded,
  evictExpiredPending,
  isRpcError,
  handleHealthRequest,
} from "../src/lib.js";

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

test("calculateBackoff - calculates correctly with jitter and bounds", () => {
  // consecutiveFailures = 0 should return base delay
  assert.strictEqual(calculateBackoff(0, 1000, 15000), 1000);

  // Mock random generator to always return 0.5 (halfway jitter)
  const mockRandom = () => 0.5;

  // consecutiveFailures = 1: base = 1000, 2^1 = 2 -> temp = 2000, half is 1000
  assert.strictEqual(calculateBackoff(1, 1000, 15000, mockRandom), 1000);

  // consecutiveFailures = 4: base = 1000, 2^4 = 16 -> temp = min(15000, 16000) = 15000, half is 7500
  assert.strictEqual(calculateBackoff(4, 1000, 15000, mockRandom), 7500);
});

test("incrementFailure, resetFailure, and isExceeded", () => {
  const failures = new Map();
  const orderId = 12n;

  assert.strictEqual(isExceeded(failures, orderId, 3), false);

  assert.strictEqual(incrementFailure(failures, orderId), 1);
  assert.strictEqual(isExceeded(failures, orderId, 3), false);

  assert.strictEqual(incrementFailure(failures, orderId), 2);
  assert.strictEqual(isExceeded(failures, orderId, 3), false);

  assert.strictEqual(incrementFailure(failures, orderId), 3);
  assert.strictEqual(isExceeded(failures, orderId, 3), true);

  resetFailure(failures, orderId);
  assert.strictEqual(failures.has(orderId), false);
  assert.strictEqual(isExceeded(failures, orderId, 3), false);
});

test("evictExpiredPending - evicts only expired items", () => {
  const pending = new Map([
    ["inst-1", { orderId: 1n, addedAt: 1000 }],
    ["inst-2", { orderId: 2n, addedAt: 2000 }],
    ["inst-3", { orderId: 3n, addedAt: 3000 }],
  ]);

  const now = 3500;
  const ttlMs = 1000; // items older than 2500 should be evicted

  const evicted = evictExpiredPending(pending, ttlMs, now);
  assert.strictEqual(evicted, 2); // inst-1 and inst-2 should be evicted
  assert.strictEqual(pending.has("inst-1"), false);
  assert.strictEqual(pending.has("inst-2"), false);
  assert.strictEqual(pending.has("inst-3"), true);
});

test("isRpcError - detects RPC / network errors correctly", () => {
  // Standard VM Execution Reverts should not be counted as RPC errors
  const revertErr = new Error("Execution reverted: WraithOrders: order not tickable");
  assert.strictEqual(isRpcError(revertErr), false);

  const customRevertErr = {
    name: "ContractFunctionExecutionError",
    message: "The contract function 'tick' reverted with the following reason:\nWraithOrders: order already ticked",
  };
  assert.strictEqual(isRpcError(customRevertErr), false);

  // Network / Fetch errors
  const fetchErr = new Error("fetch failed");
  assert.strictEqual(isRpcError(fetchErr), true);

  const timeoutErr = {
    name: "TimeoutError",
    message: "The request timed out.",
  };
  assert.strictEqual(isRpcError(timeoutErr), true);

  const rateLimitErr = new Error("Too Many Requests: Status 429");
  assert.strictEqual(isRpcError(rateLimitErr), true);

  const nestedErr = {
    message: "Something failed",
    cause: new Error("socket hang up"),
  };
  assert.strictEqual(isRpcError(nestedErr), true);
});

test("handleHealthRequest - responds with 200 for GET /health", () => {
  let responseData = "";
  let writtenStatus = 0;
  let headers = {};

  const req = {
    method: "GET",
    url: "/health",
  };

  const res = {
    writeHead(status, head) {
      writtenStatus = status;
      headers = head;
    },
    end(data) {
      responseData = data;
    },
  };

  const mockHealthData = {
    lastSuccessfulLoopTime: "2023-10-10T10:10:10.000Z",
    pendingCount: 4,
    balance: "1.2345 C2FLR",
  };

  handleHealthRequest(req, res, () => mockHealthData);

  assert.strictEqual(writtenStatus, 200);
  assert.deepStrictEqual(headers, { "Content-Type": "application/json" });
  assert.deepStrictEqual(JSON.parse(responseData), mockHealthData);
});

test("handleHealthRequest - responds with 404 for other endpoints or methods", () => {
  let responseData = "";
  let writtenStatus = 0;

  const req = {
    method: "POST",
    url: "/health",
  };

  const res = {
    writeHead(status) {
      writtenStatus = status;
    },
    end(data) {
      responseData = data;
    },
  };

  handleHealthRequest(req, res, () => ({}));

  assert.strictEqual(writtenStatus, 404);
  assert.deepStrictEqual(JSON.parse(responseData), { error: "Not Found" });
});
