/**
 * What an order would do if it fired right now.
 *
 * This is the last thing a user reads before escrowing, so it is kept pure and
 * tested rather than computed inline in the component. Every number here is one
 * somebody will act on.
 *
 * It deliberately mirrors the enclave's comparisons rather than approximating
 * them: `trigger.crosses` treats both boundaries as inclusive, so a price
 * exactly at the stop counts as crossed here too. A readout that disagreed with
 * the evaluator by one tick would be worse than no readout, because it would be
 * trusted.
 */

import { e18ToPrice } from "./wraith.ts";

export type SimInput = {
  mode: "price" | "trailing" | "stealth" | "shield" | "crosschain" | "consensus";
  /** Live feed price. Undefined until the first read answers. */
  price?: number;
  direction: "below" | "above";
  thresholdE18: bigint;
  takeProfitE18?: bigint;
  escrow: number;
  minOut: number;
  action: "swap" | "redeem";
  expirySec: number;
  nowSec: number;
  xrplAddress?: string;

  // Trailing
  peak?: number;
  trailPct?: number;

  // Stealth
  chunks?: number;
  hours?: number;
};

export type SimOutput = {
  /** Percent the price must move to reach the nearest firing level. */
  distancePct?: number;
  /** Which leg that distance was measured to. */
  nearestLeg?: "stop" | "take-profit";
  crossed: boolean;
  /** Swap only: escrow valued at the live price. */
  estimatedOut?: number;
  /** Trailing only: peak reduced by the trail. */
  trailStop?: number;
  warnings: string[];
};

/** Percentage move from `price` to `level`, relative to where the price is now. */
function movePct(price: number, level: number): number {
  return (Math.abs(level - price) / price) * 100;
}

export function simulate(input: SimInput): SimOutput {
  const warnings: string[] = [];
  const out: SimOutput = { crossed: false, warnings };

  if (input.expirySec <= input.nowSec) {
    warnings.push("This expiry is already in the past, so the order could only be cancelled.");
  }

  if (input.action === "redeem" && !input.xrplAddress?.trim()) {
    warnings.push("A redeem needs an XRPL destination, or the enclave will reject the terms.");
  }

  const price = input.price;
  const hasPrice = typeof price === "number" && price > 0;

  // A swap's proceeds track the live price; a redeem is lot-granular, so
  // valuing it the same way would be a confident guess at the wrong number.
  if (hasPrice && input.action === "swap") {
    out.estimatedOut = input.escrow * price;
    if (input.minOut > out.estimatedOut) {
      warnings.push(
        "Your minimum output is above what this trade would return now, so it would fire and then revert on slippage.",
      );
    }
  }

  if (input.mode === "trailing") {
    const peak = input.peak ?? 0;
    const trail = input.trailPct ?? 0;
    if (peak > 0 && trail > 0) {
      out.trailStop = peak * (1 - trail / 100);
    }
    return out;
  }

  // Stealth releases on a schedule, and shield, cross-chain and consensus
  // orders are not judged against this feed alone. None of them has a single
  // price the user is waiting for, so reporting a distance would describe a
  // condition the order does not have.
  if (input.mode !== "price" && input.mode !== "consensus") {
    return out;
  }

  if (!hasPrice) return out;

  const stop = e18ToPrice(input.thresholdE18);
  const takeProfit = input.takeProfitE18 ? e18ToPrice(input.takeProfitE18) : undefined;

  const legs: { level: number; name: "stop" | "take-profit"; side: "below" | "above" }[] = [];
  if (stop > 0) legs.push({ level: stop, name: "stop", side: input.direction });
  if (takeProfit && takeProfit > 0) {
    // The bracket's second leg always fires on the opposite side of the first.
    legs.push({
      level: takeProfit,
      name: "take-profit",
      side: input.direction === "below" ? "above" : "below",
    });
  }
  if (legs.length === 0) return out;

  out.crossed = legs.some((leg) => (leg.side === "below" ? price <= leg.level : price >= leg.level));
  // No warning here for a crossed trigger: the readout already says so on the
  // leg line (glyph turns to `!`), and repeating it as a warning would read as
  // two different findings about the same fact.

  // Whichever leg is nearer is the one that will actually fire, so that is the
  // distance worth showing.
  const nearest = legs.reduce((best, leg) =>
    movePct(price, leg.level) < movePct(price, best.level) ? leg : best,
  );
  out.distancePct = movePct(price, nearest.level);
  out.nearestLeg = nearest.name;

  return out;
}
