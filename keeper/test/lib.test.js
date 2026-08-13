import test from "node:test";
import assert from "node:assert";
import {
  handleFetchResultResponse,
  determineRelayAction,
  shouldNotify,
  decodeAction,
  decodeOrderId,
  buildTelegramMessage,
  sendTelegramNotification,
  recipientsFor
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

test("shouldNotify - returns false when env vars are unset", () => {
  assert.strictEqual(shouldNotify({}), false);
  assert.strictEqual(shouldNotify({ TELEGRAM_BOT_TOKEN: "token" }), false);
  assert.strictEqual(shouldNotify({ TELEGRAM_CHAT_ID: "chat" }), false);
  assert.strictEqual(shouldNotify({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" }), false);
  assert.strictEqual(shouldNotify(null), false);
});

test("shouldNotify - returns true when env vars are set", () => {
  assert.strictEqual(shouldNotify({ TELEGRAM_BOT_TOKEN: "token", TELEGRAM_CHAT_ID: "chat" }), true);
});

test("buildTelegramMessage - message contains order id and tx hash", () => {
  const orderId = "42";
  const action = "swap";
  const txHash = "0xabc123";
  const message = buildTelegramMessage(orderId, action, txHash);

  assert.ok(message.includes("42"), "Message should contain order ID");
  assert.ok(message.includes("swap"), "Message should contain action");
  assert.ok(message.includes("0xabc123"), "Message should contain tx hash");
  assert.ok(message.includes("https://coston2.testnet.flarescan.com/tx/0xabc123"), "Message should contain correct explorer link");
});

test("buildTelegramMessage - message never contains threshold-like fields", () => {
  const orderId = "42";
  const action = "redeem";
  const txHash = "0xabc123";
  const message = buildTelegramMessage(orderId, action, txHash).toLowerCase();

  const forbiddenWords = [
    "threshold",
    "price",
    "limit",
    "trigger",
    "minoutorlots",
    "lots",
    "underlyingaddress",
    "tokenout",
    "direction",
    "feedid",
    "expiry",
    "terms"
  ];
  for (const word of forbiddenWords) {
    assert.ok(!message.includes(word), `Message should not leak the word "${word}"`);
  }
});

test("decodeAction and decodeOrderId - parses hex results correctly", () => {
  // orderId = 5, contract = 0x11..., action = 0 (swap)
  const swapHex = "0x" +
    "0000000000000000000000000000000000000000000000000000000000000005" +
    "0000000000000000000000001111111111111111111111111111111111111111" +
    "0000000000000000000000000000000000000000000000000000000000000000";

  assert.strictEqual(decodeOrderId(swapHex), "5");
  assert.strictEqual(decodeAction(swapHex), "swap");

  // orderId = 42, contract = 0x22..., action = 1 (redeem)
  const redeemHex = "0x" +
    "000000000000000000000000000000000000000000000000000000000000002a" +
    "0000000000000000000000002222222222222222222222222222222222222222" +
    "0000000000000000000000000000000000000000000000000000000000000001";

  assert.strictEqual(decodeOrderId(redeemHex), "42");
  assert.strictEqual(decodeAction(redeemHex), "redeem");

  // test invalid
  assert.strictEqual(decodeAction("0x123"), "unknown");
  assert.strictEqual(decodeOrderId("0x123"), null);
});

test("sendTelegramNotification - posts to Telegram Bot API", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCallArgs = null;

  globalThis.fetch = async (url, options) => {
    fetchCallArgs = { url, options };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    const env = { TELEGRAM_BOT_TOKEN: "my-token", TELEGRAM_CHAT_ID: "my-chat" };
    const success = await sendTelegramNotification(env, "42", "swap", "0xabc123");

    assert.strictEqual(success, true);
    assert.ok(fetchCallArgs, "fetch should have been called");
    assert.strictEqual(fetchCallArgs.url, "https://api.telegram.org/botmy-token/sendMessage");
    assert.strictEqual(fetchCallArgs.options.method, "POST");
    const body = JSON.parse(fetchCallArgs.options.body);
    assert.strictEqual(body.chat_id, "my-chat");
    assert.ok(body.text.includes("42"));
    assert.ok(body.text.includes("swap"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendTelegramNotification - skipped when env unset", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    const success = await sendTelegramNotification({}, "42", "swap", "0xabc123");
    assert.strictEqual(success, false);
    assert.strictEqual(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- per-owner Telegram routing ---
//
// The operator chat is a firehose of every order; an order owner wants only
// their own. Routing has to keep those apart, and must never send one owner's
// fill to another owner's chat.

test("recipientsFor - operator chat receives every order", () => {
  const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "ops" };
  assert.deepStrictEqual(recipientsFor(env, {}, "0xAbC"), ["ops"]);
});

test("recipientsFor - the owner's own chat is added", () => {
  const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "ops" };
  const subs = { "0xabc": "owner-chat" };
  assert.deepStrictEqual(recipientsFor(env, subs, "0xAbC"), ["ops", "owner-chat"]);
});

test("recipientsFor - matches the owner case-insensitively", () => {
  const env = { TELEGRAM_BOT_TOKEN: "t" };
  assert.deepStrictEqual(recipientsFor(env, { "0XABC": "c" }, "0xabc"), ["c"]);
});

test("recipientsFor - never routes one owner's order to another owner", () => {
  const env = { TELEGRAM_BOT_TOKEN: "t" };
  const subs = { "0xaaa": "alice", "0xbbb": "bob" };
  assert.deepStrictEqual(recipientsFor(env, subs, "0xbbb"), ["bob"]);
});

test("recipientsFor - no bot token means no recipients at all", () => {
  assert.deepStrictEqual(recipientsFor({}, { "0xabc": "c" }, "0xabc"), []);
});

test("recipientsFor - the same chat is not messaged twice", () => {
  const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "same" };
  assert.deepStrictEqual(recipientsFor(env, { "0xabc": "same" }, "0xabc"), ["same"]);
});

test("recipientsFor - works with no subscriptions loaded", () => {
  const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "ops" };
  assert.deepStrictEqual(recipientsFor(env, null, "0xabc"), ["ops"]);
});
