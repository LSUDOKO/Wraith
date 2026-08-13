// ecies-geth, not eciesjs: the enclave decrypts with go-ethereum's ECIES
// (Concat-KDF + AES-128-CTR + HMAC-SHA256). eciesjs uses HKDF + AES-256-GCM,
// which the enclave cannot open — see docs/KNOWN-ISSUES.md. Compatibility is
// verified by a cross-language round trip, not assumed.
import { encrypt } from "ecies-geth";
import { encodeAbiParameters, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";

export const WRAITH_ABI = parseAbi([
  "function orderCount() view returns (uint256)",
  "function createOrder(bytes encrypted, address tokenIn, uint256 amountIn, uint64 expiry) returns (uint256)",
  "function getOrder(uint256 orderId) view returns (address owner, address tokenIn, uint256 amountIn, uint64 expiry, bool executed, bool cancelled, bytes encrypted)",
  "function cancel(uint256 orderId)",
  "function peakOf(uint256 orderId) view returns (uint256)",
  "function remainingOf(uint256 orderId) view returns (uint256)",
  "function nonces(address owner) view returns (uint256)",
  "function createOrderFor((address owner, address tokenIn, uint256 amountIn, uint64 expiry, uint256 relayerFee, uint256 deadline) intent, bytes encrypted, bytes signature) returns (uint256)",
]);

/** EIP-712 types for a gasless order intent. Must match CREATE_ORDER_TYPEHASH
 *  in WraithOrders.sol field for field, in this order. */
export const CREATE_ORDER_TYPES = {
  CreateOrder: [
    { name: "owner", type: "address" },
    { name: "encryptedHash", type: "bytes32" },
    { name: "tokenIn", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "relayerFee", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function createOrderDomain(verifyingContract: Address) {
  return { name: "Wraith", version: "1", chainId: coston2.id, verifyingContract } as const;
}

// FtsoV2 on Coston2 — live oracle reads for the ticker. Same contract family the
// enclave reads during evaluation, so what the ticker shows is what the TEE sees.
export const FTSOV2_ADDRESS = "0x3d893C53D9e8056135C26C8c638B76C8b60Df726" as Address;

export const FTSOV2_ABI = parseAbi([
  "function getFeedById(bytes21 feedId) view returns (uint256 value, int8 decimals, uint64 timestamp)",
]);

export const FEEDS: { id: Hex; label: string }[] = [
  { id: "0x01464c522f55534400000000000000000000000000", label: "FLR/USD" },
  { id: "0x015852502f55534400000000000000000000000000", label: "XRP/USD" },
  { id: "0x014254432f55534400000000000000000000000000", label: "BTC/USD" },
  { id: "0x014554482f55534400000000000000000000000000", label: "ETH/USD" },
];

export const WRAITH_EVENTS_ABI = parseAbi([
  "event OrderCreated(uint256 indexed orderId, address indexed owner, address tokenIn, uint256 amountIn, uint64 expiry)",
  "event OrderTicked(uint256 indexed orderId, bytes32 instructionId)",
  "event OrderExecuted(uint256 indexed orderId, uint8 action, uint256 amountIn, uint256 result)",
  "event OrderCancelled(uint256 indexed orderId, uint256 refunded)",
]);

export function explorerAddress(address: string): string {
  return `${coston2.blockExplorers.default.url}/address/${address}`;
}

export function explorerTx(hash: string): string {
  return `${coston2.blockExplorers.default.url}/tx/${hash}`;
}

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address owner) view returns (uint256)",
]);

/** WNat (wrapped native) exposes deposit(), which is how a tester gets escrow
 *  from faucet C2FLR without going through the FAssets minting flow. */
export const WNAT_ABI = parseAbi(["function deposit() payable"]);

/** Coston2 wrapped native. Escrow defaults here because it is obtainable in one
 *  click; FXRP remains the production asset but requires an FAssets agent. */
export const WC2FLR_ADDRESS = "0xC67DCE33D7A8efA5FfEB961899C73fe01bCe9273" as Address;

export const coston2 = {
  id: 114,
  name: "Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: ["https://coston2-api.flare.network/ext/C/rpc"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://coston2.testnet.flarescan.com" } },
} as const;

export type Direction = "below" | "above";

/** Which secret an order carries, mirroring trigger.Kind in the extension. */
export const KIND_PRICE = 0;
export const KIND_AGENT_HEALTH = 1;
export const KIND_TRAILING = 2;
export const KIND_TWAP = 3;
export const KIND_CROSSCHAIN = 4;
export const KIND_CONSENSUS = 5;
export type ActionKind = "swap" | "redeem";

/**
 * The FDC "standard address hash" of an external-chain address.
 *
 * A cross-chain order carries this rather than the address itself. The chain
 * only ever sees the hash — in the sealed terms and in the attested tick — so
 * which XRPL account the order watches stays as private as the threshold does.
 * `tickAttested` renders `sourceAddressHash` the same way, and the enclave
 * compares the two as strings.
 */
export function sourceAddressHash(address: string): string {
  return keccak256(toHex(address.trim()));
}

/** The plaintext of an order. This shape is only ever encrypted, never sent as-is. */
export type Terms = {
  contract: Address;
  feedId: Hex;
  direction: Direction;
  thresholdE18: bigint;
  action: ActionKind;
  /** Optional bracket leg. 0n means a plain single-leg order. */
  secondThresholdE18?: bigint;
  minOutOrLots: bigint;
  tokenOut: Address;
  underlyingAddress: string;
  expiry: bigint;
  /** 0 = price trigger, 1 = FAssets agent health. */
  kind?: number;
  /** Agent vault watched by a Shield order. */
  agent?: Address;
  /** Collateral floor in BIPS; 12000 is 120%. */
  minCollateralBIPS?: bigint;
  /** Trail distance below the running peak, in BIPS; 500 is 5%. */
  trailBIPS?: bigint;
  /** Seed driving a TWAP's randomized schedule. Secret: it is what makes the
   *  release times and sizes unpredictable to an observer. */
  seed?: Hex;
  /** Number of tranches a TWAP splits into. */
  chunks?: bigint;
  /** Execution window, unix seconds. */
  startAt?: bigint;
  endAt?: bigint;
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
  { name: "secondThresholdE18", type: "uint256" },
  { name: "kind", type: "uint8" },
  { name: "agent", type: "address" },
  { name: "minCollateralBIPS", type: "uint256" },
  { name: "trailBIPS", type: "uint256" },
  { name: "seed", type: "bytes32" },
  { name: "chunks", type: "uint256" },
  { name: "startAt", type: "uint64" },
  { name: "endAt", type: "uint64" },
] as const;

/**
 * ABI-encode terms and encrypt them to the enclave's public key.
 *
 * This is the only moment the condition exists in the clear anywhere outside the
 * TEE, and it happens in the user's own browser. What reaches the chain is
 * ciphertext.
 */
export async function sealTerms(terms: Terms, teePublicKey: string): Promise<Hex> {
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
    terms.secondThresholdE18 ?? 0n,
    terms.kind ?? KIND_PRICE,
    terms.agent ?? "0x0000000000000000000000000000000000000000",
    terms.minCollateralBIPS ?? 0n,
    terms.trailBIPS ?? 0n,
    terms.seed ?? "0x0000000000000000000000000000000000000000000000000000000000000000",
    terms.chunks ?? 0n,
    terms.startAt ?? 0n,
    terms.endAt ?? 0n,
  ]);

  const key = teePublicKey.startsWith("0x") ? teePublicKey.slice(2) : teePublicKey;
  const ciphertext = await encrypt(Buffer.from(key, "hex"), Buffer.from(encoded.slice(2), "hex"));

  return `0x${Buffer.from(ciphertext).toString("hex")}`;
}

/** Render ciphertext as grouped hex, truncated — it is meant to be looked at, not read. */
export function formatCipher(bytes: Hex, groups = 24): string {
  const hex = bytes.slice(2);
  const pairs = hex.match(/.{1,2}/g) ?? [];
  const shown = pairs.slice(0, groups).join(" ");
  return pairs.length > groups ? `${shown} … +${pairs.length - groups} bytes` : shown;
}

/**
 * A fresh schedule seed.
 *
 * Generated in the browser and sealed with the order, never sent anywhere in
 * the clear. Without it an observer watching chunks land cannot predict the
 * next release, which is the entire point of a stealth schedule.
 */
export function newSeed(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function priceToE18(input: string): bigint {
  const [whole, frac = ""] = input.trim().split(".");
  const padded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole || "0") * 10n ** 18n + BigInt(padded || "0");
}
