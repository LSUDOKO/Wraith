/**
 * Privacy-respecting payload scrubbing utility.
 * Recursively scrubs EVM addresses, XRPL addresses, and hex-like strings from any payload.
 */

export function scrubString(val: string): string {
  let s = val;
  // 1. Scrub 0x-prefixed hex strings (e.g., EVM addresses, transaction hashes, ciphertexts)
  s = s.replace(/0x[a-fA-F0-9]+/gi, "[SCRUBBED_HEX]");
  // 2. Scrub XRPL classic addresses (starts with r, then 24-34 Base58 characters)
  s = s.replace(/\br[1-9A-HJ-NP-Za-km-z]{24,34}\b/g, "[SCRUBBED_ADDRESS]");
  // 3. Scrub hex strings without 0x prefix that are 8 or more characters long
  s = s.replace(/\b[a-fA-F0-9]{8,}\b/gi, "[SCRUBBED_HEX]");
  // 4. Scrub any 40-character hex string even without word boundaries
  s = s.replace(/[a-fA-F0-9]{40}/gi, "[SCRUBBED_HEX]");
  return s;
}

/**
 * Keys that could carry an order's terms. These are dropped outright rather
 * than value-scrubbed, because a trigger price is a plain decimal like "2.5" —
 * no value-level pattern can distinguish it from a legitimate metric.
 *
 * A denylist is normally the weaker choice, but the alternative here is
 * scrubbing every number, which would leave analytics useless. The call sites
 * only ever send named funnel events, so this is a backstop against a future
 * change accidentally widening a payload.
 */
const TERM_KEYS = new Set([
  "threshold",
  "thresholde18",
  "secondthreshold",
  "secondthresholde18",
  "takeprofit",
  "stop",
  "direction",
  "minoutorlots",
  "minout",
  "underlyingaddress",
  "terms",
  "condition",
  "encrypted",
  "ciphertext",
  "price",
]);

export function scrub<T>(val: T): T {
  if (val === null || val === undefined) {
    return val;
  }
  if (typeof val === "string") {
    return scrubString(val) as unknown as T;
  }
  if (Array.isArray(val)) {
    return val.map((item) => scrub(item)) as unknown as T;
  }
  if (typeof val === "object") {
    const res: Record<string, any> = {};
    for (const [k, v] of Object.entries(val as Record<string, any>)) {
      if (TERM_KEYS.has(k.toLowerCase())) {
        continue; // never leaves the browser
      }
      res[k] = scrub(v);
    }
    return res as unknown as T;
  }
  return val;
}
