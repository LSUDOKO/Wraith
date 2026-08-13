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

export type OrderMode = "price" | "trailing" | "stealth" | "shield" | "crosschain" | "consensus";

export type RecalledTerms = {
  /** Which composer tab produced this order. Absent on orders sealed before
   *  the mode was recorded; those are all price orders. */
  mode?: OrderMode;
  direction: "below" | "above";
  threshold: string;
  takeProfit?: string;
  action: "swap" | "redeem";
  minOutOrLots: string;
  escrow: string;
  sealedAt: number;

  // Kind-specific, each set only by the tab that owns it.
  trailPct?: string;
  chunks?: string;
  hours?: string;
  agent?: string;
  collateralFloor?: string;
  watchAddress?: string;
  watchAmount?: string;
  deviationPct?: string;
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

/**
 * Human phrasing of a remembered condition, for the order card.
 *
 * Each kind gets its own sentence rather than a shared template. A trailing
 * stop has no trigger price and a shield has no price at all, so describing
 * either as "sell when price falls to $X" would tell the owner a confident lie
 * about where their money exits — worse than saying nothing.
 */
export function describe(terms: RecalledTerms): string {
  const how = terms.action === "swap" ? "swap" : "redeem to XRP";

  switch (terms.mode) {
    case "trailing":
      return `Follow the price up, then sell ${terms.trailPct}% below its peak — then ${how}.`;

    case "stealth":
      return `Release in ${terms.chunks} unpredictable tranches over ${terms.hours} hours — each one a ${how}.`;

    case "shield":
      return `Escape agent ${short(terms.agent)} if its collateral falls to ${terms.collateralFloor}%, or it leaves normal status — then ${how}.`;

    case "crosschain":
      return `Wait for a payment of at least ${terms.watchAmount} XRP from ${short(terms.watchAddress)} — then ${how}.`;

    case "consensus": {
      const side = terms.direction === "below" ? "falls to" : "rises to";
      return `Sell when both oracles agree price ${side} $${terms.threshold}, refusing if they differ by over ${terms.deviationPct}% — then ${how}.`;
    }

    default: {
      const side = terms.direction === "below" ? "falls to" : "rises to";
      const bracket = terms.takeProfit ? `, or reaches $${terms.takeProfit}` : "";
      return `Sell when price ${side} $${terms.threshold}${bracket} — then ${how}.`;
    }
  }
}

/** A long address, shortened for a one-line summary. */
function short(address?: string): string {
  if (!address) return "an unnamed source";
  return address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address;
}

/** Short label for the order card's badge. */
export const MODE_LABEL: Record<OrderMode, string> = {
  price: "Price",
  trailing: "Trailing",
  stealth: "Stealth",
  shield: "Shield",
  crosschain: "Cross-chain",
  consensus: "Consensus",
};
