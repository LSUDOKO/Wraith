"use client";

import { useCallback, useEffect, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, parseUnits, type Address, type Hex } from "viem";
import {
  coston2,
  ERC20_ABI,
  WRAITH_ABI,
  explorerAddress,
  explorerTx,
  formatCipher,
  priceToE18,
  sealTerms,
  type ActionKind,
  type Direction,
} from "@/lib/wraith";
import { Ticker } from "@/app/components/Ticker";
import { ActivityLog } from "@/app/components/ActivityLog";

const WRAITH_ADDRESS = (process.env.NEXT_PUBLIC_WRAITH_ADDRESS ?? "") as Address;
const FXRP_ADDRESS = (process.env.NEXT_PUBLIC_FXRP_ADDRESS ?? "") as Address;
const TOKEN_OUT = (process.env.NEXT_PUBLIC_TOKEN_OUT ?? "") as Address;
// FTSO feed id for FLR/USD. Swap for the feed your order should watch.
const FEED_ID = (process.env.NEXT_PUBLIC_FEED_ID ?? "0x01464c522f55534400000000000000000000000000") as Hex;

type Order = {
  id: number;
  owner: Address;
  amountIn: bigint;
  expiry: bigint;
  executed: boolean;
  cancelled: boolean;
  encrypted: Hex;
};

const publicClient = createPublicClient({ chain: coston2, transport: http() });

export default function Home() {
  const [account, setAccount] = useState<Address>();
  const [teeKey, setTeeKey] = useState<string>();
  const [orders, setOrders] = useState<Order[]>([]);
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<"info" | "error">("info");
  const [busy, setBusy] = useState(false);
  const [lastTx, setLastTx] = useState<string>();

  const [amount, setAmount] = useState("100");
  const [direction, setDirection] = useState<Direction>("below");
  const [threshold, setThreshold] = useState("2.00");
  const [action, setAction] = useState<ActionKind>("swap");
  const [minOut, setMinOut] = useState("150");
  const [xrplAddress, setXrplAddress] = useState("");
  const [days, setDays] = useState("7");

  const say = (message: string, kind: "info" | "error" = "info") => {
    setStatus(message);
    setTone(kind);
  };

  const loadOrders = useCallback(async () => {
    if (!WRAITH_ADDRESS) return;
    try {
      const count = await publicClient.readContract({
        address: WRAITH_ADDRESS,
        abi: WRAITH_ABI,
        functionName: "orderCount",
      });

      const loaded: Order[] = [];
      for (let id = 0n; id < count; id++) {
        const [owner, , amountIn, expiry, executed, cancelled, encrypted] = await publicClient.readContract({
          address: WRAITH_ADDRESS,
          abi: WRAITH_ABI,
          functionName: "getOrder",
          args: [id],
        });
        loaded.push({ id: Number(id), owner, amountIn, expiry, executed, cancelled, encrypted });
      }
      setOrders(loaded.reverse());
    } catch {
      say("Cannot read orders. Check NEXT_PUBLIC_WRAITH_ADDRESS and your RPC.", "error");
    }
  }, []);

  useEffect(() => {
    fetch("/api/info")
      .then((r) => r.json())
      .then((info) => {
        if (info.publicKey) setTeeKey(info.publicKey);
        else say(info.error ?? "The extension proxy did not return a public key.", "error");
      })
      .catch(() => say("Cannot reach the extension proxy.", "error"));

    loadOrders();
    // Keep the list live: executions and cancellations land from other actors
    // (the keeper, other wallets), not only from this page.
    const interval = setInterval(loadOrders, 15_000);
    return () => clearInterval(interval);
  }, [loadOrders]);

  async function connect() {
    const injected = (globalThis as { ethereum?: unknown }).ethereum;
    if (!injected) {
      say("No wallet found. Install MetaMask and switch to Coston2.", "error");
      return;
    }
    const wallet = createWalletClient({ chain: coston2, transport: custom(injected as never) });
    const [address] = await wallet.requestAddresses();
    setAccount(address);
    say(`Connected ${address.slice(0, 6)}…${address.slice(-4)}`);
  }

  async function seal(event: React.FormEvent) {
    event.preventDefault();
    if (!account || !teeKey) return;

    setBusy(true);
    try {
      const injected = (globalThis as { ethereum?: unknown }).ethereum;
      const wallet = createWalletClient({ account, chain: coston2, transport: custom(injected as never) });

      const decimals = await publicClient.readContract({
        address: FXRP_ADDRESS,
        abi: ERC20_ABI,
        functionName: "decimals",
      });
      const amountIn = parseUnits(amount, decimals);
      const expiry = BigInt(Math.floor(Date.now() / 1000) + Number(days) * 86_400);

      say("Encrypting your condition in this browser…");
      const encrypted = sealTerms(
        {
          contract: WRAITH_ADDRESS,
          feedId: FEED_ID,
          direction,
          thresholdE18: priceToE18(threshold),
          action,
          minOutOrLots: action === "swap" ? parseUnits(minOut, decimals) : BigInt(minOut),
          tokenOut: TOKEN_OUT,
          underlyingAddress: xrplAddress,
          expiry,
        },
        teeKey,
      );

      say("Approving escrow…");
      const approveHash = await wallet.writeContract({
        address: FXRP_ADDRESS,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [WRAITH_ADDRESS, amountIn],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      say("Sealing the order on Coston2…");
      const hash = await wallet.writeContract({
        address: WRAITH_ADDRESS,
        abi: WRAITH_ABI,
        functionName: "createOrder",
        args: [encrypted, FXRP_ADDRESS, amountIn, expiry],
      });
      await publicClient.waitForTransactionReceipt({ hash });

      setLastTx(hash);
      say("Sealed. Your trigger never touched the chain in the clear.");
      await loadOrders();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      say(message.split("\n")[0], "error");
    } finally {
      setBusy(false);
    }
  }

  async function cancelOrder(orderId: number) {
    if (!account) return;
    setBusy(true);
    try {
      const injected = (globalThis as { ethereum?: unknown }).ethereum;
      const wallet = createWalletClient({ account, chain: coston2, transport: custom(injected as never) });

      say(`Cancelling order ${orderId}…`);
      const hash = await wallet.writeContract({
        address: WRAITH_ADDRESS,
        abi: WRAITH_ABI,
        functionName: "cancel",
        args: [BigInt(orderId)],
      });
      await publicClient.waitForTransactionReceipt({ hash });

      setLastTx(hash);
      say(`Order ${orderId} cancelled — escrow refunded.`);
      await loadOrders();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      say(message.split("\n")[0], "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <header className="masthead">
        <div>
          <h1 className="wordmark">
            <span>Wraith</span>
          </h1>
          <p className="thesis">
            Conditional orders that never announce themselves. Your trigger is encrypted to a trusted enclave, so
            nobody can trade against a price they cannot see.
          </p>
          <p className="chain-note">Flare Coston2 · FTSO price triggers · FXRP settlement</p>
        </div>

        <ol className="mechanism" aria-label="How Wraith works">
          <li className="mech-step">
            <span className="mech-name">Seal</span>
            <span className="mech-desc">
              Your condition is encrypted in this browser. The chain stores ciphertext and escrow — nothing else.
            </span>
          </li>
          <li className="mech-step">
            <span className="mech-name">Watch</span>
            <span className="mech-desc">
              A TEE decrypts it in-enclave on every tick and checks live FTSO prices. Keepers relay blindly.
            </span>
          </li>
          <li className="mech-step">
            <span className="mech-name">Fire</span>
            <span className="mech-desc">
              When the condition is met, the enclave signs a settlement. The contract verifies and executes —
              swap, or redeem FXRP to native XRP.
            </span>
          </li>
        </ol>
      </header>

      <Ticker />

      <div className="workspace">
        <section aria-labelledby="compose-title">
          <h2 className="panel-title" id="compose-title">
            Compose an order
          </h2>

          <form className="compose" onSubmit={seal}>
            <label className="field">
              <span className="field-label">Escrow (FXRP)</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required />
            </label>

            <div className="field field-secret">
              <span className="field-label">Trigger</span>
              <div className="field-row">
                <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
                  <option value="below">Falls to</option>
                  <option value="above">Rises to</option>
                </select>
                <input value={threshold} onChange={(e) => setThreshold(e.target.value)} inputMode="decimal" required />
              </div>
            </div>

            <div className="field field-secret">
              <span className="field-label">Then</span>
              <div className="field-row">
                <select value={action} onChange={(e) => setAction(e.target.value as ActionKind)}>
                  <option value="swap">Swap</option>
                  <option value="redeem">Redeem to XRP</option>
                </select>
                <input
                  value={minOut}
                  onChange={(e) => setMinOut(e.target.value)}
                  inputMode="decimal"
                  aria-label={action === "swap" ? "Minimum output" : "Lots"}
                  required
                />
              </div>
            </div>

            {action === "redeem" && (
              <label className="field field-secret">
                <span className="field-label">XRPL destination</span>
                <input
                  value={xrplAddress}
                  onChange={(e) => setXrplAddress(e.target.value)}
                  placeholder="r…"
                  required
                />
              </label>
            )}

            <label className="field">
              <span className="field-label">Expires in (days)</span>
              <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" required />
            </label>

            <p className="secret-note">
              Marked fields are encrypted in this browser and never published. The chain stores only ciphertext and
              the escrow.
            </p>

            {account ? (
              <button className="submit" type="submit" disabled={busy || !teeKey}>
                {busy ? "Sealing…" : teeKey ? "Seal and submit" : "Waiting for the enclave key"}
              </button>
            ) : (
              <button className="submit" type="button" onClick={connect}>
                Connect wallet
              </button>
            )}

            <p className="status" data-tone={tone} role="status">
              {status}
              {lastTx && (
                <>
                  {" "}
                  <a className="tx-link" href={explorerTx(lastTx)} target="_blank" rel="noreferrer">
                    View transaction ↗
                  </a>
                </>
              )}
            </p>
          </form>
        </section>

        <section aria-labelledby="orders-title">
          <h2 className="panel-title" id="orders-title">
            Sealed orders
          </h2>

          {orders.length === 0 ? (
            <p className="empty">
              No sealed orders yet. Compose one — everything about it will be public except the thing that matters.
            </p>
          ) : (
            <div className="orders">
              {orders.map((order) => {
                const state = order.executed
                  ? "executed"
                  : order.cancelled
                    ? "cancelled"
                    : BigInt(Math.floor(Date.now() / 1000)) >= order.expiry
                      ? "expired"
                      : "sealed";

                return (
                  <article className="order" key={order.id}>
                    <div className="order-head">
                      <span className="order-id">Order {order.id}</span>
                      <span className="head-actions">
                        {state === "sealed" && account?.toLowerCase() === order.owner.toLowerCase() && (
                          <button
                            className="cancel-btn"
                            type="button"
                            disabled={busy}
                            onClick={() => cancelOrder(order.id)}
                          >
                            Cancel
                          </button>
                        )}
                        <span className="state" data-state={state}>
                          {state}
                        </span>
                      </span>
                    </div>

                    <div className="facts">
                      <div>
                        <div className="fact-label">Owner</div>
                        <div className="fact-value cipher">
                          <a
                            className="tx-link"
                            href={explorerAddress(order.owner)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {order.owner.slice(0, 6)}…{order.owner.slice(-4)}
                          </a>
                        </div>
                      </div>
                      <div>
                        <div className="fact-label">Escrow</div>
                        <div className="fact-value">{(Number(order.amountIn) / 1e18).toLocaleString()} FXRP</div>
                      </div>
                      <div>
                        <div className="fact-label">Expires</div>
                        <div className="fact-value">
                          {new Date(Number(order.expiry) * 1000).toLocaleDateString()}
                        </div>
                      </div>
                    </div>

                    <div className="seal">
                      <span className="seal-label">Condition · sealed</span>
                      <p className="cipher">{formatCipher(order.encrypted)}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          <ActivityLog address={WRAITH_ADDRESS || undefined} />
        </section>
      </div>
    </main>
  );
}
