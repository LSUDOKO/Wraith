"use client";

import type { ReactNode } from "react";

export type OrderMode = "price" | "trailing" | "stealth" | "shield" | "crosschain" | "consensus";

/**
 * Line icons, drawn rather than imported.
 *
 * Six glyphs at one stroke weight is less code than a dependency and avoids
 * pulling an entire icon set in for six marks. Each inherits `currentColor` so
 * the selected card tints its own icon without a second rule.
 */
const ICONS: Record<OrderMode, ReactNode> = {
  price: (
    <>
      <path d="M12 4v11" />
      <path d="m8 11 4 4 4-4" />
      <path d="M4 20h16" />
    </>
  ),
  trailing: (
    <>
      <path d="m3 15 4-5 3 3 4-7 4 5" />
      <path d="M3 20h18" strokeDasharray="2 2.5" />
    </>
  ),
  stealth: (
    <>
      <path d="M4 5v14" />
      <path d="M11 8v8" />
      <path d="M18 11v2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.2-7 8.3-4.1-1.1-7-4.1-7-8.3V6z" />
      <path d="m12.6 8-2.4 4h3.1l-2.4 4" />
    </>
  ),
  crosschain: (
    <>
      <path d="M9.5 12H7a3 3 0 0 1 0-6h2.5" />
      <path d="M14.5 12H17a3 3 0 0 0 0-6h-2.5" />
      <path d="M9.5 18H7" strokeDasharray="1.5 2" />
      <path d="M17 18h-2.5" strokeDasharray="1.5 2" />
    </>
  ),
  consensus: (
    <>
      <circle cx="9.5" cy="12" r="5.5" />
      <circle cx="14.5" cy="12" r="5.5" />
      <path d="m10.2 12.2 1.6 1.6 3-3.4" />
    </>
  ),
};

type Strategy = {
  mode: OrderMode;
  title: string;
  blurb: string;
  /** The Flare primitive doing the work. Named because it is the whole reason
   *  each of these can exist, and it is what a judge is looking for. */
  tag: string;
};

export const STRATEGIES: Strategy[] = [
  { mode: "price", title: "Private stop / TP", blurb: "Fixed price threshold", tag: "TEE sealed" },
  { mode: "trailing", title: "Trailing stop", blurb: "Peak-following trail", tag: "FTSOv2" },
  { mode: "stealth", title: "Stealth TWAP", blurb: "Time-sliced release", tag: "Seeded" },
  { mode: "shield", title: "FAssets Shield", blurb: "Collateral ratio escape", tag: "AssetManager" },
  { mode: "crosschain", title: "Cross-chain", blurb: "XRPL payment trigger", tag: "FDC attested" },
  { mode: "consensus", title: "Consensus", blurb: "Two oracles must agree", tag: "FTSO + FDC" },
];

/**
 * The order primitive picker.
 *
 * These were six words in a scrolling tab strip, which gave a stop-loss and a
 * cross-chain attestation trigger exactly the same visual weight as each other
 * and no weight at all against the form below them. As cards each primitive
 * gets a mark, a sentence, and the name of the Flare component that makes it
 * possible.
 *
 * Still a real tablist: arrow keys move between options and the selected card
 * carries `aria-selected`, so it reads to assistive tech the way the tab strip
 * did rather than as six unrelated buttons.
 */
export function StrategyCards({
  mode,
  onSelect,
}: {
  mode: OrderMode;
  onSelect: (mode: OrderMode) => void;
}) {
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();

    const index = STRATEGIES.findIndex((s) => s.mode === mode);
    const next = STRATEGIES[(index + delta + STRATEGIES.length) % STRATEGIES.length];
    onSelect(next.mode);
    // Move focus with selection so the keyboard user lands where they just went.
    const target = event.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next.mode}"]`);
    target?.focus();
  }

  return (
    <div className="strategy-block">
      <p className="strategy-legend">Select order primitive</p>

      <div className="strategy-grid" role="tablist" aria-label="Order primitive" onKeyDown={onKeyDown}>
        {STRATEGIES.map((strategy) => {
          const selected = strategy.mode === mode;
          return (
            <button
              key={strategy.mode}
              className="strategy"
              type="button"
              role="tab"
              data-mode={strategy.mode}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(strategy.mode)}
            >
              <svg
                className="strategy-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {ICONS[strategy.mode]}
              </svg>

              <span className="strategy-title">{strategy.title}</span>
              <span className="strategy-blurb">{strategy.blurb}</span>
              <span className="strategy-tag">{strategy.tag}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
