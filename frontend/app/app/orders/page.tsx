"use client";

import { useMemo, useState } from "react";
import { OrderCard } from "@/app/components/OrderCard";
import { useWraith, WRAITH_ADDRESS } from "../WraithContext";

export default function OrdersPage() {
  const { orders, loadingOrders, account, symbol, busy, cancelOrder } = useWraith();
  const [filter, setFilter] = useState<"all" | "mine">("all");

  const visible = useMemo(
    () => (filter === "mine" && account ? orders.filter((o) => o.owner.toLowerCase() === account.toLowerCase()) : orders),
    [orders, filter, account],
  );

  return (
    <section aria-labelledby="orders-title">
      <div className="panel-head">
        <h2 className="panel-title" id="orders-title">
          Sealed orders
        </h2>
        {account && (
          <div className="filter" role="group" aria-label="Filter orders">
            <button className="filter-btn" type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              All
            </button>
            <button className="filter-btn" type="button" aria-pressed={filter === "mine"} onClick={() => setFilter("mine")}>
              Mine
            </button>
          </div>
        )}
      </div>

      {loadingOrders ? (
        <div className="orders">
          {[0, 1].map((i) => (
            <div className="order skeleton" key={i} aria-hidden="true">
              <div className="sk sk-head" />
              <div className="sk sk-facts" />
              <div className="sk sk-seal" />
            </div>
          ))}
          <p className="sr-only">Loading orders</p>
        </div>
      ) : visible.length === 0 ? (
        <p className="empty">
          {filter === "mine"
            ? "You have not sealed an order yet."
            : "No sealed orders yet. Compose one — everything about it will be public except the thing that matters."}
        </p>
      ) : (
        <div className="orders orders-grid">
          {visible.map((order, i) => (
            <OrderCard
              key={order.id}
              order={order}
              index={i}
              account={account}
              contract={WRAITH_ADDRESS || undefined}
              symbol={symbol}
              busy={busy}
              onCancel={cancelOrder}
            />
          ))}
        </div>
      )}
    </section>
  );
}
