/**
 * One order's history, read from the chain.
 *
 * The discipline here is that a line never says more than its event carries.
 * The chain records that an order was ticked, that a peak rose, that something
 * settled. It does not record what the order was waiting for, and no amount of
 * convenient phrasing here may imply that it does.
 *
 * A partial fill is the clearest case: `OrderExecuted` carries the amount spent
 * but not how many chunks a schedule has, because the chunk count is sealed. So
 * the line says what was spent and stops there rather than guessing "2 of 6".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPublicClient, http, type Address, type Hex, type Log } from "viem";
import { coston2, WRAITH_EVENTS_ABI } from "./wraith.ts";

const client = createPublicClient({ chain: coston2, transport: http() });

/** Coston2's RPC rejects any getLogs spanning more than 30 blocks. */
const CHUNK = 30n;
/**
 * Scan depth and cadence, both deliberately modest.
 *
 * Each window is a separate `getLogs`, so depth is a request multiplier per
 * open card, and Coston2's public RPC answers 429 long before it answers
 * slowly. At 60 windows every 15 seconds a viewer with three cards expanded
 * issued nearly 900 requests a minute and rate-limited the whole origin,
 * which surfaced as a chart that would not draw and a TEE count of zero.
 */
const DEPTH = 20; // ~600 blocks, roughly the last 20 minutes
const MAX_LINES = 20;
/** An expanded card refreshes at most this often. */
const REFRESH_MS = 30_000;

export type WraithLog = Log & { eventName: string; args: Record<string, unknown> };

export type TimelineEntry = {
  key: string;
  block: bigint;
  tx: Hex;
  text: string;
  kind: "created" | "relayed" | "ticked" | "peak" | "executed" | "cancelled";
};

/** Backwards-walking scan windows, each inside the RPC's block-span limit. */
export function scanWindows(head: bigint, depth: number): { from: bigint; to: bigint }[] {
  const windows: { from: bigint; to: bigint }[] = [];
  for (let i = 0; i < depth; i++) {
    const to = head - BigInt(i) * CHUNK;
    if (to <= 0n) break;
    windows.push({ from: to > CHUNK ? to - CHUNK : 0n, to });
  }
  return windows;
}

function whole(value: unknown, digits = 4): string {
  return (Number(value ?? 0) / 1e18).toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** Turn one log into a timeline line, or null if this build does not know it. */
export function describeEvent(log: WraithLog): Omit<TimelineEntry, "key" | "block" | "tx"> | null {
  const args = log.args;

  switch (log.eventName) {
    case "OrderCreated":
      return { kind: "created", text: `Sealed, ${whole(args.amountIn)} escrowed` };

    case "OrderRelayed":
      return { kind: "relayed", text: `Sponsored by a relayer for ${whole(args.fee)} in fee` };

    case "OrderTicked":
      return {
        kind: "ticked",
        text: `Evaluated in the enclave, instruction ${String(args.instructionId).slice(0, 10)}…`,
      };

    case "PeakTracked":
      // Safe to name: the peak comes from public FTSO prices, so it reveals
      // nothing an observer could not already compute. The trail below it is
      // the secret, and no event carries that.
      return { kind: "peak", text: `Peak rose to $${whole(args.peakE18, 6)}` };

    case "OrderExecuted": {
      const action = Number(args.action);
      if (action === 2) {
        return { kind: "peak", text: "Peak recorded, order still live" };
      }
      const how = action === 0 ? "swap" : "redeem";
      return { kind: "executed", text: `FIRED, ${how} settled for ${whole(args.amountIn)} spent` };
    }

    case "OrderCancelled":
      return { kind: "cancelled", text: `Cancelled, ${whole(args.refunded)} refunded` };

    default:
      return null;
  }
}

/**
 * Fetch one order's events.
 *
 * `enabled` gates everything: a collapsed card does no network work at all,
 * which matters when a page lists many orders and each would otherwise poll.
 */
export function useOrderEvents(contract: Address | undefined, orderId: number, enabled: boolean) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [ready, setReady] = useState(false);
  const lastLoad = useRef(0);

  const load = useCallback(async () => {
    if (!contract) return;
    lastLoad.current = Date.now();
    try {
      const head = await client.getBlockNumber();
      const results = await Promise.all(
        scanWindows(head, DEPTH).map((w) =>
          client
            // No `args` filter here: viem only supports one when querying a
            // single event, and querying six separately would be six times the
            // requests for a window that is already 30 blocks wide. Filtering
            // by orderId below costs nothing by comparison.
            .getLogs({
              address: contract,
              events: WRAITH_EVENTS_ABI,
              fromBlock: w.from,
              toBlock: w.to,
            })
            // One rejected window must not blank the whole history.
            .catch(() => []),
        ),
      );

      const mapped = results
        .flat()
        .map((log) => {
          const typed = log as unknown as WraithLog;
          if (Number(typed.args.orderId) !== orderId) return null;
          const described = describeEvent(typed);
          if (!described) return null;
          return {
            ...described,
            key: `${log.transactionHash}-${log.logIndex}`,
            block: log.blockNumber ?? 0n,
            tx: (log.transactionHash ?? "0x") as Hex,
          } satisfies TimelineEntry;
        })
        .filter((entry): entry is TimelineEntry => entry !== null);

      setEntries(mapped.sort((a, b) => (a.block > b.block ? -1 : 1)).slice(0, MAX_LINES));
    } catch {
      // Keep whatever was already shown; the explorer link still works.
    } finally {
      setReady(true);
    }
  }, [contract, orderId]);

  useEffect(() => {
    if (!enabled) return;

    // Re-expanding a card it just closed should not re-fetch immediately.
    if (Date.now() - lastLoad.current > REFRESH_MS) load();

    const interval = setInterval(load, REFRESH_MS);
    return () => clearInterval(interval);
  }, [enabled, load]);

  return { entries, ready };
}
