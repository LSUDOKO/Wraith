/**
 * Local recall of your own order terms.
 *
 * An order's ciphertext is encrypted to the enclave's key, not yours, so once
 * sealed you genuinely cannot read your own condition back from the chain. That
 * is correct for privacy and terrible as a product: a trader has no way to see
 * what they set.
 *
 * The fix is to keep a copy in this browser at seal time. It never leaves the
 * device, so it changes nothing about what the chain or any observer can see —
 * it only closes the gap between "nobody can read it" and "not even you".
 *
 * Clearing site data loses the recall, not the order. The order still lives
 * on-chain and still fires; you just stop being reminded what it says.
 */

export type RecalledTerms = {
  direction: "below" | "above";
  threshold: string;
  takeProfit?: string;
  action: "swap" | "redeem";
  minOutOrLots: string;
  escrow: string;
  sealedAt: number;
};

const KEY = "wraith.recall.v1";

type Store = Record<string, RecalledTerms>;

function slot(contract: string, orderId: number | bigint): string {
  return `${contract.toLowerCase()}:${orderId.toString()}`;
}

function read(): Store {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Store;
  } catch {
    return {};
  }
}

export function remember(contract: string, orderId: number | bigint, terms: RecalledTerms): void {
  if (typeof window === "undefined") return;
  try {
    const store = read();
    store[slot(contract, orderId)] = terms;
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Private browsing or a full quota: recall is a convenience, never a
    // requirement, so failing to save must not break sealing.
  }
}

export function recall(contract: string, orderId: number | bigint): RecalledTerms | undefined {
  return read()[slot(contract, orderId)];
}

/** Human phrasing of a remembered condition, for the order card. */
export function describe(terms: RecalledTerms): string {
  const side = terms.direction === "below" ? "falls to" : "rises to";
  const base = `Sell when price ${side} $${terms.threshold}`;
  const bracket = terms.takeProfit ? `, or reaches $${terms.takeProfit}` : "";
  const how = terms.action === "swap" ? "swap" : "redeem to XRP";
  return `${base}${bracket} — then ${how}.`;
}
