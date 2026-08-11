"use client";

import { useEffect, useState } from "react";
import { createPublicClient, http, type Address } from "viem";
import { coston2, explorerTx, WRAITH_EVENTS_ABI } from "@/lib/wraith";

const client = createPublicClient({ chain: coston2, transport: http() });

// How far back to scan for events on load. Coston2 blocks are ~1.8s, so this is
// roughly the last day and a half.
const LOOKBACK_BLOCKS = 70_000n;

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
        const fromBlock = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
        const logs = await client.getLogs({
          address,
          events: WRAITH_EVENTS_ABI,
          fromBlock,
          toBlock: head,
        });
        if (cancelled) return;

        const mapped = logs.map((log): Entry => {
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
          }
        });

        setEntries(mapped.sort((a, b) => (a.block > b.block ? -1 : 1)).slice(0, 40));
      } catch {
        // Keep whatever we had; the explorer link in the footer still works.
      } finally {
        if (!cancelled) setReady(true);
      }
    }

    load();
    const interval = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [address]);

  return (
    <section aria-labelledby="log-title" className="log-panel">
      <h2 className="panel-title" id="log-title">
        Chain activity
      </h2>

      <div className="log" role="log">
        {!ready ? (
          <p className="log-line log-muted">reading events from Coston2…</p>
        ) : entries.length === 0 ? (
          <>
            <p className="log-line log-muted">no Wraith events in the last ~70,000 blocks</p>
            <p className="log-line log-muted">
              every line here is a real on-chain event — and none of them will ever name a trigger price
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
    </section>
  );
}
