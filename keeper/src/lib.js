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
 * Calculates exponential backoff with full jitter.
 *
 * @param {number} consecutiveFailures
 * @param {number} baseDelay
 * @param {number} maxDelay
 * @param {function} [random=Math.random] - Optional random number generator for testing.
 * @returns {number}
 */
export function calculateBackoff(consecutiveFailures, baseDelay, maxDelay, random = Math.random) {
  if (consecutiveFailures <= 0) {
    return baseDelay;
  }
  const temp = Math.min(maxDelay, baseDelay * Math.pow(2, consecutiveFailures));
  return Math.floor(random() * temp);
}

/**
 * Increments the failure count for a given orderId.
 *
 * @param {Map<bigint, number>} failuresMap
 * @param {bigint} orderId
 * @returns {number} The new failure count.
 */
export function incrementFailure(failuresMap, orderId) {
  const count = (failuresMap.get(orderId) ?? 0) + 1;
  failuresMap.set(orderId, count);
  return count;
}

/**
 * Resets the failure count for a given orderId.
 *
 * @param {Map<bigint, number>} failuresMap
 * @param {bigint} orderId
 */
export function resetFailure(failuresMap, orderId) {
  failuresMap.delete(orderId);
}

/**
 * Checks if the failure count for a given orderId has exceeded the cap.
 *
 * @param {Map<bigint, number>} failuresMap
 * @param {bigint} orderId
 * @param {number} maxRetries
 * @returns {boolean}
 */
export function isExceeded(failuresMap, orderId, maxRetries) {
  const count = failuresMap.get(orderId) ?? 0;
  return count >= maxRetries;
}

/**
 * Evicts pending instructions older than the TTL.
 *
 * @param {Map<string, { orderId: bigint, addedAt: number }>} pendingMap
 * @param {number} ttlMs
 * @param {number} now
 * @returns {number} The number of evicted instructions.
 */
export function evictExpiredPending(pendingMap, ttlMs, now = Date.now()) {
  let count = 0;
  for (const [instructionId, entry] of pendingMap.entries()) {
    if (now - entry.addedAt > ttlMs) {
      pendingMap.delete(instructionId);
      count++;
    }
  }
  return count;
}

/**
 * Determines whether an error is a Flare RPC/network failure.
 * We want to distinguish transient RPC issues (which should trigger backoff)
 * from permanent EVM execution failures/reverts (which should not trigger loop backoff).
 *
 * @param {any} error
 * @returns {boolean}
 */
export function isRpcError(error) {
  if (!error) return false;

  const msg = (error.message || "").toLowerCase();
  const shortMsg = (error.shortMessage || "").toLowerCase();
  const name = (error.name || "").toLowerCase();

  // If the error or its name contains revert, it's an execution revert, not an RPC failure.
  if (msg.includes("revert") || shortMsg.includes("revert") || name.includes("revert")) {
    return false;
  }

  // Common network, RPC, connection, or timeout indicators
  if (
    msg.includes("fetch") ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("request") ||
    msg.includes("socket") ||
    msg.includes("eaddrnotavail") ||
    msg.includes("econnrefused") ||
    msg.includes("rate limit") ||
    msg.includes("status 429") ||
    msg.includes("status 503") ||
    msg.includes("status 502") ||
    msg.includes("status 504") ||
    msg.includes("rpc") ||
    msg.includes("connection") ||
    name.includes("httprequesterror") ||
    name.includes("timeouterror") ||
    name.includes("rpcrequesterror")
  ) {
    return true;
  }

  // Recurse into cause if available
  if (error.cause) {
    return isRpcError(error.cause);
  }

  return false;
}

/**
 * Handles HTTP requests for the health endpoint.
 *
 * @param {any} req
 * @param {any} res
 * @param {function} getHealthData
 */
export function handleHealthRequest(req, res, getHealthData) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getHealthData()));
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  }
}
