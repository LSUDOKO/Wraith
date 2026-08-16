import type { ReactNode } from "react";

/**
 * Landing iconography.
 *
 * These replace nine PNGs in `public/art/` that were all byte-identical
 * placeholders — the same blank grey rounded square at 668 bytes, six times for
 * the order kinds and three times for the steps. They were invisible only
 * because the old pastel card washes sat behind them; on white they read as
 * empty boxes.
 *
 * Stroked geometry on `currentColor`, so a card sets the ink and the icon
 * follows. One weight, one corner treatment, no fills: the accent colour is
 * spent on buttons and eyebrows, not here.
 */

function Glyph({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <svg
      className="m-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {children}
    </svg>
  );
}

/** A price line crossing a dashed threshold — the stop, literally. */
export const IconPriceStop = () => (
  <Glyph>
    <path d="M3 15h18" strokeDasharray="3 3" opacity="0.45" />
    <path d="M3 8l4 5 3-3 4 6 3-4 4 2" />
  </Glyph>
);

/** A rising staircase with the trail following one step behind it. */
export const IconTrailing = () => (
  <Glyph>
    <path d="M3 18h4v-4h4v-4h4V6h6" />
    <path d="M3 21h4v-4h4v-4h4V9h6" opacity="0.4" strokeDasharray="3 3" />
  </Glyph>
);

/** Tranches of uneven size at uneven spacing — the shape of the schedule. */
export const IconStealthTwap = () => (
  <Glyph>
    <path d="M4 20V13" />
    <path d="M9 20v-11" />
    <path d="M14 20v-6" />
    <path d="M19 20V10" />
    <path d="M3 4h5" opacity="0.4" />
    <path d="M12 4h9" opacity="0.4" />
  </Glyph>
);

/** A shield: the FAssets collateral escape. */
export const IconShield = () => (
  <Glyph>
    <path d="M12 3l7 3v5.5c0 4.2-2.9 7.7-7 9.5-4.1-1.8-7-5.3-7-9.5V6z" />
    <path d="M9.5 12l1.8 1.9 3.4-3.8" />
  </Glyph>
);

/** Two chains, one attested hop between them. */
export const IconCrossChain = () => (
  <Glyph>
    <circle cx="5.5" cy="12" r="2.8" />
    <circle cx="18.5" cy="12" r="2.8" />
    <path d="M8.4 12h7.2" />
    <path d="M13.6 9.8l2.2 2.2-2.2 2.2" />
  </Glyph>
);

/** Two feeds overlapping: it settles only where they agree. */
export const IconConsensus = () => (
  <Glyph>
    <circle cx="9" cy="12" r="6" />
    <circle cx="15" cy="12" r="6" />
    <path d="M10.4 12.2l1.4 1.5 2.6-3" />
  </Glyph>
);

/** Step 1 — the condition goes in and the lock closes. */
export const IconSeal = () => (
  <Glyph>
    <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    <path d="M12 14.5v2.5" />
  </Glyph>
);

/** Step 2 — the enclave watching, with the price read inside it. */
export const IconWatch = () => (
  <Glyph>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </Glyph>
);

/** Step 3 — settlement, signed and spent in one stroke. */
export const IconFire = () => (
  <Glyph>
    <path d="M13.5 2.5L5 13.5h6l-1.5 8L18 10.5h-6z" />
  </Glyph>
);
