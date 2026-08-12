"use client";

import { memo, useEffect, useState } from "react";

const HEX = "0123456789abcdef";
const ROWS = 6;
const PER_ROW = 16;

function randomRow(seed: number): string {
  // Deterministic per index so the server and first client paint agree; the
  // scramble below only starts after mount.
  let x = seed * 2654435761;
  const out: string[] = [];
  for (let i = 0; i < PER_ROW; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    out.push(HEX[x % 16] + HEX[(x >>> 4) % 16]);
  }
  return out.join(" ");
}

/**
 * The hero artifact: an order whose every field is legible except the one that
 * matters. The cipher block re-scrambles slowly, so the thing you cannot read
 * is also the only thing on the page that moves.
 *
 * Isolated and memoized because it runs a perpetual interval — it must never
 * re-render the page around it.
 */
export const SealedVisual = memo(function SealedVisual() {
  const [rows, setRows] = useState(() => Array.from({ length: ROWS }, (_, i) => randomRow(i + 1)));

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let tick = ROWS;
    const id = setInterval(() => {
      tick += 1;
      const target = tick % ROWS;
      setRows((prev) => prev.map((row, i) => (i === target ? randomRow(tick * 31 + i) : row)));
    }, 900);

    return () => clearInterval(id);
  }, []);

  return (
    <aside className="artifact" aria-label="An example sealed order">
      <div className="artifact-head">
        <span className="artifact-id">Order 07</span>
        <span className="artifact-state">sealed</span>
      </div>

      <dl className="artifact-facts">
        <div>
          <dt>Escrow</dt>
          <dd>2,400 FXRP</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>14 Sep 2026</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd className="mono">0x86fB…0042</dd>
        </div>
      </dl>

      <div className="artifact-seal">
        <div className="artifact-seal-head">
          <span>Condition</span>
          <span className="artifact-lock">encrypted to enclave</span>
        </div>
        <pre className="artifact-cipher" aria-hidden="true">
          {rows.join("\n")}
        </pre>
        <p className="sr-only">
          The trigger condition is stored as ciphertext and cannot be read from the chain.
        </p>
      </div>

      <p className="artifact-caption">
        Everything here is public except the trigger. That is the entire product.
      </p>
    </aside>
  );
});
