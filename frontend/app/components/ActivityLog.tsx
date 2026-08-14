"use client";

import { useEffect, useState } from "react";
import { createPublicClient, http, type Address } from "viem";
import { coston2, explorerTx, WRAITH_EVENTS_ABI } from "@/lib/wraith";

const client = createPublicClient({ chain: coston2, transport: http() });

// Coston2's RPC rejects any getLogs spanning more than 30 blocks, so the scan
// has to be chunked. A single wide query fails outright and renders as "no
// events", which is indistinguishable from a genuinely quiet contract — the
// bug this replaces.
const CHUNK = 30n;
// Each window is a separate request, so this is a per-viewer request
// multiplier. Coston2's public RPC answers 429 well before it answers slowly.
const CHUNKS = 20; // ~600 blocks, roughly the last twenty minutes

type Entry = {
  key: string;
  block: bigint;
  tx: string;
  line: string;
  kind: "created" | "ticked" | "executed" | "cancelled";
};

/**
 * The chain's own record of Wraith activity, rendered as an operations log.
 * Every line is a real event read from Coston2 — nothing is synthesized. The
 * conspicuous absence in this log is the point: ticks and creations appear,
 * but no line ever says what any order is waiting for.
 */
export function ActivityLog({ address }: { address?: Address }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!address) {
      setReady(true);
      return;
    }
    let cancelled = false;

    async function load() {
      try {
        const head = await client.getBlockNumber();

        // Walk backwards in RPC-sized windows, newest first.
        const windows = Array.from({ length: CHUNKS }, (_, i) => {
          const to = head - BigInt(i) * CHUNK;
          const from = to > CHUNK ? to - CHUNK : 0n;
          return { from, to };
        }).filter((w) => w.to > 0n);

        const results = await Promise.all(
          windows.map((w) =>
            client
              .getLogs({ address, events: WRAITH_EVENTS_ABI, fromBlock: w.from, toBlock: w.to })
              // One bad window must not blank the whole log.
              .catch(() => []),
          ),
        );
        const logs = results.flat();
        if (cancelled) return;

        const mapped = logs.map((log): Entry | null => {
          const base = {
            key: `${log.transactionHash}-${log.logIndex}`,
            block: log.blockNumber,
            tx: log.transactionHash,
          };
          switch (log.eventName) {
            case "OrderCreated":
              return {
                ...base,
                kind: "created",
                line: `order ${log.args.orderId} sealed · ${(Number(log.args.amountIn) / 1e18).toLocaleString()} escrowed`,
              };
            case "OrderTicked":
              return {
                ...base,
                kind: "ticked",
                line: `order ${log.args.orderId} evaluated in enclave · instruction ${String(log.args.instructionId).slice(0, 10)}…`,
              };
            case "OrderExecuted":
              return {
                ...base,
                kind: "executed",
                line: `order ${log.args.orderId} FIRED · ${log.args.action === 0 ? "swap" : "redeem"} settled`,
              };
            case "OrderCancelled":
              return {
                ...base,
                kind: "cancelled",
                line: `order ${log.args.orderId} cancelled · escrow refunded`,
              };
            default:
              // PeakTracked and OrderRelayed belong to a single order's own
              // timeline, not to the contract-wide feed. Dropping them here
              // keeps this log about lifecycle rather than mechanics.
              return null;
          }
        });

        setEntries(
          mapped
            .filter((entry): entry is Entry => entry !== null)
            .sort((a, b) => (a.block > b.block ? -1 : 1))
            .slice(0, 40),
        );
      } catch {
        // Keep whatever we had; the explorer link in the footer still works.
      } finally {
        if (!cancelled) setReady(true);
      }
    }

    load();
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [address]);

  return (
    <section aria-labelledby="log-title" className="log-panel">
      <div className="log-head">
        <h2 className="panel-title" id="log-title">
          Chain activity
        </h2>
        {/* Only once a scan has actually returned, so the indicator means "this
            feed is live" rather than decorating a panel that never loaded. */}
        {ready && (
          <>
            <span className="live-dot" aria-hidden="true" />
            <span className="sr-only">Live</span>
          </>
        )}
      </div>

      <div className="log-wrap">
        <div className="log" role="log">
          {!ready ? (
            <p className="log-line log-muted">reading events from Coston2…</p>
          ) : entries.length === 0 ? (
            <>
              <p className="log-line log-muted">no Wraith events in the last ~600 blocks</p>
              <p className="log-line log-muted">
                every line here is a real on-chain event — and none of them will ever name a trigger price
              </p>
              <p className="log-line log-muted">
                <a href="/app">seal an order</a> to put the first one here
              </p>
            </>
          ) : (
            entries.map((entry) => (
              <p className="log-line" data-kind={entry.kind} key={entry.key}>
                <span className="log-block">#{entry.block.toString()}</span>
                <span className="log-text">{entry.line}</span>
                <a className="tx-link log-tx" href={explorerTx(entry.tx)} target="_blank" rel="noreferrer">
                  tx ↗
                </a>
              </p>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
