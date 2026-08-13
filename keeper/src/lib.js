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
 * Bookkeeper for the pending map tracking instructionId -> orderId.
 */
export class PendingBookkeeper {
  constructor() {
    this.pending = new Map();
  }

  /**
   * Adds an instruction to the pending map.
   * @param {string} instructionId
   * @param {bigint|number} orderId
   */
  add(instructionId, orderId) {
    this.pending.set(instructionId, orderId);
  }

  /**
   * Removes an instruction from the pending map.
   * @param {string} instructionId
   * @returns {boolean} True if the element existed and was removed, false otherwise.
   */
  delete(instructionId) {
    return this.pending.delete(instructionId);
  }

  /**
   * Checks if an instruction exists in the pending map.
   * @param {string} instructionId
   * @returns {boolean}
   */
  has(instructionId) {
    return this.pending.has(instructionId);
  }

  /**
   * Gets the orderId for a given instruction.
   * @param {string} instructionId
   * @returns {bigint|number|undefined}
   */
  get(instructionId) {
    return this.pending.get(instructionId);
  }

  /**
   * Returns a copy of the pending entries as an array of [instructionId, orderId] pairs.
   * @returns {Array<[string, bigint|number]>}
   */
  entries() {
    return [...this.pending.entries()];
  }

  /**
   * Gets the number of pending instructions.
   * @returns {number}
   */
  get size() {
    return this.pending.size;
  }
}
