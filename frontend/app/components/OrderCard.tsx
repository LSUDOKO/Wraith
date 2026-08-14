"use client";

import { formatUnits, type Address } from "viem";
import { explorerAddress, formatCipher } from "@/lib/wraith";
import { recall, describe, MODE_LABEL } from "@/lib/recall";
import { OrderTimeline } from "@/app/components/OrderTimeline";
import type { Order } from "@/app/app/WraithContext";

/**
 * One sealed order's card: what's public, what only the owner's own device
 * still remembers, and its on-chain history on demand.
 *
 * Extracted from the page component so the order list can be its own route
 * without carrying the compose form's state past it.
 */
export function OrderCard({
  order,
  index,
  account,
  contract,
  symbol,
  busy,
  onCancel,
}: {
  order: Order;
  index: number;
  account?: Address;
  contract?: Address;
  symbol: string;
  busy: boolean;
  onCancel: (orderId: number) => void;
}) {
  const mine = account?.toLowerCase() === order.owner.toLowerCase();
  const known = mine ? recall(contract ?? "", order.id) : undefined;

  return (
    <article className="order" style={{ animationDelay: `${Math.min(index, 6) * 45}ms` }}>
      <div className="order-head">
        <span className="order-id">
          Order {order.id}
          {/* Only the owner's own device knows the kind. To everyone else the
              order is opaque, which is the point — so no badge is shown rather
              than a guess. */}
          {known && <span className="order-mode">{MODE_LABEL[known.mode ?? "price"]}</span>}
        </span>
        <span className="head-actions">
          {order.state === "sealed" && mine && (
            <button className="cancel-btn" type="button" disabled={busy} onClick={() => onCancel(order.id)}>
              Cancel
            </button>
          )}
          <span className="state" data-state={order.state}>
            {order.state}
          </span>
        </span>
      </div>

      <div className="facts">
        <div>
          <div className="fact-label">Owner</div>
          <div className="fact-value cipher">
            <a className="tx-link" href={explorerAddress(order.owner)} target="_blank" rel="noreferrer">
              {order.owner.slice(0, 6)}…{order.owner.slice(-4)}
            </a>
          </div>
        </div>
        <div>
          <div className="fact-label">Escrow</div>
          <div className="fact-value">
            {Number(formatUnits(order.amountIn, 18)).toLocaleString()} {symbol || ""}
          </div>
        </div>
        <div>
          <div className="fact-label">Expires</div>
          <div className="fact-value">
            {new Date(Number(order.expiry) * 1000).toLocaleDateString(undefined, {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </div>
        </div>
      </div>

      {(order.peak > 0n || (order.remaining > 0n && order.remaining < order.amountIn)) && (
        <div className="facts live-facts">
          {order.peak > 0n && (
            <div>
              <div className="fact-label">Peak tracked</div>
              <div className="fact-value">
                ${Number(formatUnits(order.peak, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })}
              </div>
            </div>
          )}
          {order.remaining < order.amountIn && (
            <div>
              <div className="fact-label">Filled</div>
              <div className="fact-value">
                {(((Number(order.amountIn - order.remaining) / Number(order.amountIn)) * 100)).toFixed(0)}% ·{" "}
                {Number(formatUnits(order.remaining, 18)).toLocaleString()} left
              </div>
            </div>
          )}
        </div>
      )}

      <div className="seal">
        <span className="seal-label">Condition · sealed</span>
        <p className="cipher">{formatCipher(order.encrypted)}</p>
      </div>

      <OrderTimeline contract={contract} orderId={order.id} />

      {mine &&
        (known ? (
          <p className="recall">
            <span className="recall-tag">Only you can see this</span>
            {describe(known)}
          </p>
        ) : (
          <p className="recall recall-lost">
            <span className="recall-tag">Only you can see this</span>
            Sealed from another browser, so this device cannot show the condition. The order still works.
          </p>
        ))}
    </article>
  );
}
