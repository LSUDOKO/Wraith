"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { formatUnits } from "viem";
import { Ticker } from "@/app/components/Ticker";
import { SystemStatus } from "@/app/components/SystemStatus";
import { WraithProvider, useWraith } from "./WraithContext";

const TABS = [
  { href: "/app", label: "Compose" },
  { href: "/app/orders", label: "Orders" },
  { href: "/app/activity", label: "Activity" },
] as const;

/**
 * The masthead, ticker, system status and stats row are one session's worth of
 * state shared by three routes now rather than one page's worth of markup.
 * Splitting compose, orders and activity out of a single narrow-column layout
 * is what lets the chart use the page's full width instead of a ~25rem
 * sidebar — the width the old two-column `.workspace` grid left it.
 *
 * This section carries its own top nav rather than the site's dark global one:
 * the app is light now, and a dark bar sitting directly above a white page
 * read as two different products stacked on top of each other.
 */
function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { account, wrongNetwork, switchNetwork, loadingOrders, stats, symbol } = useWraith();

  return (
    <main className="app-light">
      <div id="nav-sentinel" aria-hidden="true" />

      <header className="app-nav">
        <div className="shell app-nav-inner">
          <Link className="app-mark" href="/" aria-label="Wraith home">
            <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
              <rect x="6" y="6" width="20" height="20" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <g fill="currentColor" opacity="0.9">
                <rect x="10" y="11" width="5" height="2" rx="0.6" />
                <rect x="17" y="11" width="3" height="2" rx="0.6" />
                <rect x="10" y="15" width="3" height="2" rx="0.6" />
                <rect x="15" y="15" width="6" height="2" rx="0.6" />
              </g>
            </svg>
            Wraith
          </Link>

          <nav className="app-nav-links" aria-label="Site">
            <Link className="app-nav-link" href="/">
              Site
            </Link>
            <a className="app-nav-link" href="https://github.com/LSUDOKO/Wraith/blob/main/docs/TRUST.md" target="_blank" rel="noreferrer">
              Trust
            </a>
            <a className="app-nav-link" href="https://github.com/LSUDOKO/Wraith" target="_blank" rel="noreferrer">
              Source
            </a>
          </nav>

          {account && (
            <span className="wallet-chip">
              <span className="live-dot" aria-hidden="true" />
              {account.slice(0, 6)}…{account.slice(-4)}
            </span>
          )}
        </div>
      </header>

      <div className="app-masthead">
        <div className="shell">
          <h1 className="app-title">Orders</h1>
          <p className="app-sub">
            Compose a conditional order. The trigger is encrypted in this browser and stored onchain as ciphertext.
          </p>
        </div>
      </div>

      <Ticker />

      {wrongNetwork && (
        <div className="banner" role="alert">
          <span>Your wallet is not on Coston2. Orders cannot be read or sealed from another network.</span>
          <button className="banner-action" type="button" onClick={switchNetwork}>
            Switch to Coston2
          </button>
        </div>
      )}

      <SystemStatus />

      <div className="shell">
        <section className="stats" aria-label="Contract totals">
          <div className="stat">
            <span className="stat-value">{loadingOrders ? "—" : stats.total}</span>
            <span className="stat-label">Orders created</span>
          </div>
          <div className="stat">
            <span className="stat-value">{loadingOrders ? "—" : stats.sealed}</span>
            <span className="stat-label">Currently sealed</span>
          </div>
          <div className="stat">
            <span className="stat-value">{loadingOrders ? "—" : stats.executed}</span>
            <span className="stat-label">Fired</span>
          </div>
          <div className="stat">
            <span className="stat-value">
              {loadingOrders ? "—" : Number(formatUnits(stats.escrowed, 18)).toLocaleString()}
            </span>
            <span className="stat-label">{symbol || "Tokens"} in escrow</span>
          </div>
        </section>

        <nav className="app-tabs" aria-label="Wraith app sections">
          {TABS.map((tab) => (
            <Link
              key={tab.href}
              className="app-tab"
              href={tab.href}
              aria-current={pathname === tab.href ? "page" : undefined}
            >
              {tab.label}
            </Link>
          ))}
        </nav>

        {children}
      </div>

      <footer className="app-footer">
        <div className="shell app-footer-inner">
          <p className="app-footer-note">
            Coston2 testnet. Flare Confidential Compute is pre-release — do not put real funds behind this.
          </p>
          <nav className="app-footer-links" aria-label="Project links">
            <a href="https://github.com/LSUDOKO/Wraith" target="_blank" rel="noreferrer">
              Source
            </a>
            <a href="https://github.com/LSUDOKO/Wraith/blob/main/docs/TRUST.md" target="_blank" rel="noreferrer">
              Trust assumptions
            </a>
            <a href="https://dev.flare.network/fcc/overview" target="_blank" rel="noreferrer">
              Flare Confidential Compute
            </a>
          </nav>
        </div>
      </footer>
    </main>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <WraithProvider>
      <AppChrome>{children}</AppChrome>
    </WraithProvider>
  );
}
