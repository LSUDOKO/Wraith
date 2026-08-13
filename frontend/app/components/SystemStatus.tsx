"use client";

import { useEffect, useState } from "react";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { coston2 } from "@/lib/wraith";

const client = createPublicClient({ chain: coston2, transport: http() });

// The FCC TEE manager diamond on Coston2.
const TEE_MANAGER = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE" as Address;

const TEE_ABI = parseAbi([
  "function getActiveTeeMachines(uint256 extensionId) view returns (address[] machines, string[] urls)",
  "function getTeeMachineStatus(address machine) view returns (uint8)",
]);

type Health = {
  enclaveKey?: string;
  machines: number;
  production: number;
  extensionId?: string;
};

/**
 * Live proof that the private half of the system is actually running.
 *
 * Everything here is read from the chain or the enclave itself — the count of
 * TEE machines registered to this extension, how many the registry considers
 * production-ready, and whether the enclave is currently publishing the key
 * orders get sealed to. Without this the privacy claim is just a sentence on a
 * page; with it you can watch the machinery that enforces it.
 */
export function SystemStatus({ extensionId = 66224 }: { extensionId?: number }) {
  const [health, setHealth] = useState<Health>({ machines: 0, production: 0 });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const next: Health = { machines: 0, production: 0 };

      // The enclave key comes through our own API route, which relays the
      // extension proxy — the browser never talks to it directly.
      try {
        const info = await fetch("/api/info").then((r) => r.json());
        if (typeof info?.publicKey === "string") next.enclaveKey = info.publicKey;
        const id = info?.machineData?.extensionId;
        if (id) next.extensionId = BigInt(id).toString();
      } catch {
        // Enclave offline: left undefined, rendered as "offline" below.
      }

      try {
        const [machines] = await client.readContract({
          address: TEE_MANAGER,
          abi: TEE_ABI,
          functionName: "getActiveTeeMachines",
          args: [BigInt(extensionId)],
        });
        next.machines = machines.length;

        const statuses = await Promise.all(
          machines.map((m) =>
            client
              .readContract({ address: TEE_MANAGER, abi: TEE_ABI, functionName: "getTeeMachineStatus", args: [m] })
              .catch(() => 0),
          ),
        );
        next.production = statuses.filter((s) => Number(s) === 2).length;
      } catch {
        // Registry unreachable; counts stay at zero.
      }

      if (!cancelled) {
        setHealth(next);
        setReady(true);
      }
    }

    poll();
    const interval = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [extensionId]);

  const enclaveUp = Boolean(health.enclaveKey);

  return (
    <section className="sysbar" aria-label="System status">
      <span className="sys-item">
        <span className="sys-dot" data-up={enclaveUp} aria-hidden="true" />
        <span className="sys-label">Enclave</span>
        <span className="sys-value">
          {!ready ? "checking…" : enclaveUp ? `${health.enclaveKey!.slice(0, 10)}…` : "offline"}
        </span>
      </span>

      <span className="sys-item">
        <span className="sys-dot" data-up={health.production > 0} aria-hidden="true" />
        <span className="sys-label">TEE machines</span>
        <span className="sys-value">
          {health.production} of {health.machines} in production
        </span>
      </span>

      <span className="sys-item">
        <span className="sys-label">Extension</span>
        <span className="sys-value">{health.extensionId ? `#${health.extensionId}` : `#${extensionId}`}</span>
      </span>

      <span className="sys-note">
        {enclaveUp
          ? "Your condition is sealed to this key. Nobody else can read it — including us."
          : "The enclave is unreachable, so new orders cannot be sealed right now."}
      </span>
    </section>
  );
}
