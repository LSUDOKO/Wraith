"use client";

import { useState } from "react";
import type { Address } from "viem";
import { explorerTx } from "@/lib/wraith";
import { useOrderEvents } from "@/lib/orderEvents";

/**
 * One order's history, from the chain's own record.
 *
 * Collapsed by default and inert while collapsed: a page listing many orders
 * would otherwise open a poll per card. Expanding is what starts the work.
 *
 * The conspicuous absence is the point. The history shows an order being
 * created, ticked, tracked and settled, and never once says what it was waiting
 * for.
 */
export function OrderTimeline({ contract, orderId }: { contract?: Address; orderId: number }) {
  const [open, setOpen] = useState(false);
  const { entries, ready } = useOrderEvents(contract, orderId, open);

  return (
    <details className="timeline" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="timeline-summary">History</summary>

      <div className="timeline-body">
        {!ready ? (
          <p className="timeline-line timeline-muted">reading this order&apos;s events…</p>
        ) : entries.length === 0 ? (
          <p className="timeline-line timeline-muted">no events yet</p>
        ) : (
          entries.map((entry) => (
            <p className="timeline-line" data-kind={entry.kind} key={entry.key}>
              <span className="timeline-block">#{entry.block.toString()}</span>
              <span className="timeline-text">{entry.text}</span>
              <a className="tx-link timeline-tx" href={explorerTx(entry.tx)} target="_blank" rel="noreferrer">
                tx ↗
              </a>
            </p>
          ))
        )}
      </div>
    </details>
  );
}
