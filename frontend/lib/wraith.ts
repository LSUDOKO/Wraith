import { encrypt } from "eciesjs";
import { encodeAbiParameters, parseAbi, type Address, type Hex } from "viem";

export const WRAITH_ABI = parseAbi([
  "function orderCount() view returns (uint256)",
  "function createOrder(bytes encrypted, address tokenIn, uint256 amountIn, uint64 expiry) returns (uint256)",
  "function getOrder(uint256 orderId) view returns (address owner, address tokenIn, uint256 amountIn, uint64 expiry, bool executed, bool cancelled, bytes encrypted)",
]);

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);

export const coston2 = {
  id: 114,
  name: "Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: ["https://coston2-api.flare.network/ext/C/rpc"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://coston2.testnet.flarescan.com" } },
} as const;

export type Direction = "below" | "above";
export type ActionKind = "swap" | "redeem";

/** The plaintext of an order. This shape is only ever encrypted, never sent as-is. */
export type Terms = {
  contract: Address;
  feedId: Hex;
  direction: Direction;
  thresholdE18: bigint;
  action: ActionKind;
  minOutOrLots: bigint;
  tokenOut: Address;
  underlyingAddress: string;
  expiry: bigint;
};

const TERMS_LAYOUT = [
  { name: "contract", type: "address" },
  { name: "feedId", type: "bytes21" },
  { name: "direction", type: "string" },
  { name: "thresholdE18", type: "uint256" },
  { name: "action", type: "uint8" },
  { name: "minOutOrLots", type: "uint256" },
  { name: "tokenOut", type: "address" },
  { name: "underlyingAddress", type: "string" },
  { name: "expiry", type: "uint64" },
] as const;

/**
 * ABI-encode terms and encrypt them to the enclave's public key.
 *
 * This is the only moment the condition exists in the clear anywhere outside the
 * TEE, and it happens in the user's own browser. What reaches the chain is
 * ciphertext.
 */
export function sealTerms(terms: Terms, teePublicKey: string): Hex {
  const encoded = encodeAbiParameters(TERMS_LAYOUT, [
    terms.contract,
    terms.feedId,
    terms.direction,
    terms.thresholdE18,
    terms.action === "swap" ? 0 : 1,
    terms.minOutOrLots,
    terms.tokenOut,
    terms.underlyingAddress,
    terms.expiry,
  ]);

  const key = teePublicKey.startsWith("0x") ? teePublicKey.slice(2) : teePublicKey;
  const ciphertext = encrypt(Buffer.from(key, "hex"), Buffer.from(encoded.slice(2), "hex"));

  return `0x${Buffer.from(ciphertext).toString("hex")}`;
}

/** Render ciphertext as grouped hex, truncated — it is meant to be looked at, not read. */
export function formatCipher(bytes: Hex, groups = 24): string {
  const hex = bytes.slice(2);
  const pairs = hex.match(/.{1,2}/g) ?? [];
  const shown = pairs.slice(0, groups).join(" ");
  return pairs.length > groups ? `${shown} … +${pairs.length - groups} bytes` : shown;
}

export function priceToE18(input: string): bigint {
  const [whole, frac = ""] = input.trim().split(".");
  const padded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole || "0") * 10n ** 18n + BigInt(padded || "0");
}
