/**
 * Processes the HTTP response from the proxy for a result fetch.
 *
 * @param {Response} response - The Fetch Response object.
 * @param {string} [instructionId] - Optional instruction ID for logging/errors.
 * @returns {Promise<any | null>} The parsed response body or null.
 * @throws {Error} If the response status is not OK (except 404).
 */
export async function handleFetchResultResponse(response, instructionId) {
  if (response.status === 404) return null;
  if (!response.ok) {
    const suffix = instructionId ? ` for ${instructionId}` : "";
    throw new Error(`proxy returned ${response.status}${suffix}`);
  }

  const body = await response.json();
  // Status >= 2 means the extension is still processing.
  if (body?.status === undefined || body.status >= 2) return null;
  return body;
}

/**
 * Determines whether a fetched result should be relayed on-chain.
 *
 * @param {any} result - The result from fetchResult.
 * @param {string} [defaultSubmissionTag="submit"] - Default submission tag to use if result has none.
 * @returns {any | null} The relayed shape containing transaction args, or null if skipped/not relayable.
 */
export function determineRelayAction(result, defaultSubmissionTag = "submit") {
  if (!result) return null;
  if (result.status !== 1) return null;
  if (!result.data || result.data === "0x") return null;

  return {
    data: result.data,
    submissionTag: result.submissionTag ?? defaultSubmissionTag,
    status: result.status,
    signature: result.signature,
  };
}

/**
 * Decodes the action from the ABI-encoded result data.
 *
 * @param {string} data - Hex string starting with or without "0x"
 * @returns {string} "swap", "redeem", or "unknown"
 */
export function decodeAction(data) {
  if (!data || typeof data !== "string") return "unknown";
  const cleanData = data.startsWith("0x") ? data.slice(2) : data;
  if (cleanData.length < 192) return "unknown";
  const actionHex = cleanData.slice(128, 192);
  try {
    const actionVal = Number(BigInt("0x" + actionHex));
    if (actionVal === 0) return "swap";
    if (actionVal === 1) return "redeem";
  } catch (e) {
    // ignore
  }
  return "unknown";
}

/**
 * Decodes the order ID from the ABI-encoded result data.
 *
 * @param {string} data - Hex string starting with or without "0x"
 * @returns {string|null} The order ID as a string, or null if invalid
 */
export function decodeOrderId(data) {
  if (!data || typeof data !== "string") return null;
  const cleanData = data.startsWith("0x") ? data.slice(2) : data;
  if (cleanData.length < 64) return null;
  const orderIdHex = cleanData.slice(0, 64);
  try {
    return BigInt("0x" + orderIdHex).toString();
  } catch (e) {
    return null;
  }
}

/**
 * Determines whether Telegram notifications should be sent based on environment.
 *
 * @param {Record<string, string>} env
 * @returns {boolean}
 */
export function shouldNotify(env) {
  return !!(env?.TELEGRAM_BOT_TOKEN && env?.TELEGRAM_CHAT_ID);
}

/**
 * Constructs the explorer transaction link.
 *
 * @param {string} txHash
 * @returns {string}
 */
export function getExplorerTxLink(txHash) {
  return `https://coston2.testnet.flarescan.com/tx/${txHash}`;
}

/**
 * Builds the pure text message for Telegram.
 *
 * @param {string|number} orderId
 * @param {string} action - "swap", "redeem", or "unknown"
 * @param {string} txHash
 * @returns {string}
 */
export function buildTelegramMessage(orderId, action, txHash) {
  const txLink = getExplorerTxLink(txHash);
  return `Order executed!\nID: ${orderId}\nAction: ${action}\nTransaction: ${txLink}`;
}

/**
 * Sends a notification message to the configured Telegram Bot.
 *
 * @param {Record<string, string>} env
 * @param {string|number} orderId
 * @param {string} action
 * @param {string} txHash
 * @returns {Promise<boolean>}
 */
export async function sendTelegramNotification(env, orderId, action, txHash) {
  if (!shouldNotify(env)) {
    return false;
  }
  const message = buildTelegramMessage(orderId, action, txHash);
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`Telegram Bot API error: ${response.status} ${text}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`Telegram network/fetch error: ${error.message}`);
    return false;
  }
}
