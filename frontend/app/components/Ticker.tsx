"use client";

import { useEffect, useState } from "react";
import { createPublicClient, http } from "viem";
import { coston2, FEEDS, FTSOV2_ABI, FTSOV2_ADDRESS } from "@/lib/wraith";

const client = createPublicClient({ chain: coston2, transport: http() });

type Quote = {
  label: string;
  price: string;
  ageSec: number;
};

/**
 * Live FTSO block-latency feeds, read straight from Coston2. This is the same
 * oracle surface the enclave reads during evaluation — what this strip shows is
 * what the TEE would see on the next tick.
 */
export function Ticker() {
  const [quotes, setQuotes] = useState<Quote[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const results = await Promise.all(
          FEEDS.map((feed) =>
            client.readContract({
              address: FTSOV2_ADDRESS,
              abi: FTSOV2_ABI,
              functionName: "getFeedById",
              args: [feed.id],
            }),
          ),
        );
        if (cancelled) return;

        const nowSec = Math.floor(Date.now() / 1000);
        setQuotes(
          results.map(([value, decimals, timestamp], i) => ({
            label: FEEDS[i].label,
            price: (Number(value) / 10 ** decimals).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: decimals > 4 ? 4 : decimals,
            }),
            ageSec: Math.max(0, nowSec - Number(timestamp)),
          })),
        );
      } catch {
        // Leave the previous quotes up; a gap beats a flicker.
      }
    }

    poll();
    const interval = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (quotes.length === 0) {
    return (
      <div className="ticker" aria-label="Live FTSO feeds">
        <span className="ticker-item ticker-loading">Reading FTSO feeds from Coston2…</span>
      </div>
    );
  }

  return (
    <div className="ticker" aria-label="Live FTSO feeds">
      {quotes.map((q) => (
        <span className="ticker-item" key={q.label}>
          <span className="ticker-pair">{q.label}</span>
          <span className="ticker-price">${q.price}</span>
          <span className="ticker-age">{q.ageSec}s</span>
        </span>
      ))}
      <span className="ticker-source">FTSOv2 · live</span>
    </div>
  );
}
