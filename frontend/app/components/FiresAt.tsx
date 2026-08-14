"use client";

import { useEffect, useState } from "react";
import { createPublicClient, http, type Hex } from "viem";
import { coston2, FTSOV2_ABI, FTSOV2_ADDRESS } from "@/lib/wraith";
import { simulate, type SimInput } from "@/lib/fires";

const client = createPublicClient({ chain: coston2, transport: http() });

const POLL_MS = 10_000;

function money(value: number, digits = 6): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

type Props = Omit<SimInput, "price" | "nowSec"> & {
  feedId: Hex;
  feedLabel: string;
  escrowSymbol: string;
  outSymbol: string;
};

/**
 * What this order would do if it fired right now.
 *
 * Everything else in the composer describes intent. This describes consequence,
 * and it sits directly above the submit button because that is the moment the
 * two need to be compared. The arithmetic lives in `lib/fires.ts` so it can be
 * tested against the enclave's own comparison rules rather than approximated
 * inline.
 */
export function FiresAt({ feedId, feedLabel, escrowSymbol, outSymbol, ...terms }: Props) {
  const [price, setPrice] = useState<number>();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const [value, decimals] = await client.readContract({
          address: FTSOV2_ADDRESS,
          abi: FTSOV2_ABI,
          functionName: "getFeedById",
          args: [feedId],
        });
        if (cancelled) return;
        setPrice(Number(value) / 10 ** decimals);
        setNow(Math.floor(Date.now() / 1000));
      } catch {
        // Keep the last reading. The warnings that do not need a price -
        // expiry, missing destination - stay correct either way.
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [feedId]);

  const sim = simulate({ ...terms, price, nowSec: now });

  return (
    <div className="fires" aria-live="polite">
      <p className="fires-line">
        <span className="fires-key">{feedLabel} now</span>
        <span className="fires-value">{price === undefined ? "reading FTSO…" : `$${money(price)}`}</span>
      </p>

      {terms.mode === "trailing" ? (
        <p className="fires-line">
          <span className="fires-key">Trailing stop</span>
          <span className="fires-value">
            {sim.trailStop === undefined
              ? `no peak yet - the first tick establishes it, then the stop sits ${terms.trailPct ?? 0}% below`
              : `peak $${money(terms.peak ?? 0)} · trail ${terms.trailPct}% · stop at $${money(sim.trailStop)}`}
          </span>
        </p>
      ) : terms.mode === "stealth" ? (
        <p className="fires-line">
          <span className="fires-key">Schedule</span>
          <span className="fires-value">
            {terms.chunks} chunks over {terms.hours} hours, at sizes and times derived from a seed only the enclave
            can read
          </span>
        </p>
      ) : sim.distancePct !== undefined ? (
        <p className="fires-line">
          <span className="fires-key">Your {sim.nearestLeg}</span>
          <span className="fires-value">
            {sim.crossed
              ? "already crossed, so it fires on the next tick"
              : `${money(sim.distancePct, 2)}% away`}
          </span>
        </p>
      ) : null}

      {sim.estimatedOut !== undefined && (
        <p className="fires-line">
          <span className="fires-key">If it fires now</span>
          <span className="fires-value">
            about {money(sim.estimatedOut, 4)} {outSymbol} for {money(terms.escrow, 4)} {escrowSymbol}, with{" "}
            {money(terms.minOut, 4)} as the floor you set
          </span>
        </p>
      )}

      {sim.warnings.map((warning) => (
        <p className="fires-line fires-warn" key={warning} role="status">
          <span className="fires-key">Check</span>
          <span className="fires-value">{warning}</span>
        </p>
      ))}
    </div>
  );
}
