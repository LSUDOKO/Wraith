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
      res[k] = scrub(v);
    }
    return res as unknown as T;
  }
  return val;
}
