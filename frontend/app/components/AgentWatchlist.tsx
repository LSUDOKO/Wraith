"use client";

import { useEffect, useState } from "react";
import { listAgents, risk, type Agent } from "@/lib/agents";

/**
 * Live FAssets agent health.
 *
 * This is the argument for Shield in one table: these ratios are real, they
 * move, and a minter whose agent slides toward liquidation currently has to
 * notice by hand. Everything here is read straight from the AssetManager.
 */
export function AgentWatchlist({
  floorPct,
  selected,
  onSelect,
}: {
  floorPct: number;
  selected?: string;
  onSelect: (vault: string) => void;
}) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const next = await listAgents();
      if (!cancelled) {
        setAgents(next);
        setReady(true);
      }
    }

    poll();
    const interval = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!ready) {
    return <p className="agents-empty">Reading agent health from the AssetManager…</p>;
  }

  if (agents.length === 0) {
    return <p className="agents-empty">No public agents are currently listed on this network.</p>;
  }

  return (
    <table className="agents">
      <thead>
        <tr>
          <th scope="col">Agent</th>
          <th scope="col">Vault CR</th>
          <th scope="col">Pool CR</th>
          <th scope="col">Minted</th>
          <th scope="col">Health</th>
        </tr>
      </thead>
      <tbody>
        {agents.map((a) => {
          const level = risk(a, floorPct);
          const isSelected = selected?.toLowerCase() === a.vault.toLowerCase();
          return (
            <tr
              key={a.vault}
              className="agent-row"
              data-selected={isSelected}
              onClick={() => onSelect(a.vault)}
              tabIndex={0}
              role="button"
              aria-pressed={isSelected}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(a.vault);
                }
              }}
            >
              <td className="cipher">
                {a.vault.slice(0, 8)}…{a.vault.slice(-4)}
              </td>
              <td className="num">{a.vaultCR.toFixed(2)}%</td>
              <td className="num">{a.poolCR.toFixed(2)}%</td>
              <td className="num">{a.minted.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
              <td>
                <span className="agent-health" data-level={level}>
                  {a.status !== "normal" ? a.status : level}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
