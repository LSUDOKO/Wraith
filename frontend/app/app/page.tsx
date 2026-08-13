"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
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
import { trackEvent, setPersonProperties, trackError } from "@/lib/analytics";

const WRAITH_ADDRESS = (process.env.NEXT_PUBLIC_WRAITH_ADDRESS ?? "") as Address;
const FXRP_ADDRESS = (process.env.NEXT_PUBLIC_FXRP_ADDRESS ?? "") as Address;
const TOKEN_OUT = (process.env.NEXT_PUBLIC_TOKEN_OUT ?? "") as Address;
const FEED_ID = (process.env.NEXT_PUBLIC_FEED_ID ?? "0x01464c522f55534400000000000000000000000000") as Hex;

type OrderState = "sealed" | "executed" | "cancelled" | "expired";

type Order = {
  id: number;
  owner: Address;
  amountIn: bigint;
  expiry: bigint;
  executed: boolean;
  cancelled: boolean;
  encrypted: Hex;
  state: OrderState;
};

const publicClient = createPublicClient({ chain: coston2, transport: http() });

function stateOf(o: { executed: boolean; cancelled: boolean; expiry: bigint }): OrderState {
  if (o.executed) return "executed";
  if (o.cancelled) return "cancelled";
  if (BigInt(Math.floor(Date.now() / 1000)) >= o.expiry) return "expired";
  return "sealed";
}

function injectedProvider(): unknown | undefined {
  return (globalThis as { ethereum?: unknown }).ethereum;
}

export default function Home() {
  const [account, setAccount] = useState<Address>();
  const [wrongNetwork, setWrongNetwork] = useState(false);
  const [teeKey, setTeeKey] = useState<string>();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<"info" | "error">("info");
  const [busy, setBusy] = useState(false);
  const [lastTx, setLastTx] = useState<string>();
  const [filter, setFilter] = useState<"all" | "mine">("all");

  const [amount, setAmount] = useState("100");
  const [direction, setDirection] = useState<Direction>("below");
  const [threshold, setThreshold] = useState("2.00");
  const [action, setAction] = useState<ActionKind>("swap");
  const [minOut, setMinOut] = useState("150");
  const [xrplAddress, setXrplAddress] = useState("");
  const [days, setDays] = useState("7");
  const [composeStarted, setComposeStarted] = useState(false);

  const startCompose = useCallback(() => {
    if (!composeStarted) {
      setComposeStarted(true);
      trackEvent("order_compose_started", { wallet_connected: Boolean(account) });
    }
  }, [composeStarted, account]);

  const say = (message: string, kind: "info" | "error" = "info") => {
    setStatus(message);
    setTone(kind);
  };

  const configured = Boolean(WRAITH_ADDRESS && FXRP_ADDRESS);

  const loadOrders = useCallback(async () => {
    if (!WRAITH_ADDRESS) {
      setLoadingOrders(false);
      return;
    }
    try {
      const count = await publicClient.readContract({
        address: WRAITH_ADDRESS,
        abi: WRAITH_ABI,
        functionName: "orderCount",
      });

      const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i));
      const loaded = await Promise.all(
        ids.map(async (id) => {
          const [owner, , amountIn, expiry, executed, cancelled, encrypted] = await publicClient.readContract({
            address: WRAITH_ADDRESS,
            abi: WRAITH_ABI,
            functionName: "getOrder",
            args: [id],
          });
          const base = { owner, amountIn, expiry, executed, cancelled };
          return { id: Number(id), ...base, encrypted, state: stateOf(base) } satisfies Order;
        }),
      );

      setOrders(loaded.reverse());
    } catch {
      say("Cannot read orders. Check the contract address and your RPC connection.", "error");
    } finally {
      setLoadingOrders(false);
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
    // Executions and cancellations land from the keeper and other wallets, not
    // only from this page, so the list has to poll.
    const interval = setInterval(loadOrders, 15_000);
    return () => clearInterval(interval);
  }, [loadOrders]);

  useEffect(() => {
    setPersonProperties({ wallet_connected: Boolean(account) });
  }, [account]);

  useEffect(() => {
    if (wrongNetwork) {
      trackEvent("wrong_network_shown", { wallet_connected: Boolean(account) });
    }
  }, [wrongNetwork, account]);

  const stats = useMemo(() => {
    const escrowed = orders
      .filter((o) => o.state === "sealed")
      .reduce((sum, o) => sum + o.amountIn, 0n);
    return {
      total: orders.length,
      sealed: orders.filter((o) => o.state === "sealed").length,
      executed: orders.filter((o) => o.state === "executed").length,
      escrowed,
    };
  }, [orders]);

  const visible = useMemo(
    () => (filter === "mine" && account ? orders.filter((o) => o.owner.toLowerCase() === account.toLowerCase()) : orders),
    [orders, filter, account],
  );

  async function connect() {
    const injected = injectedProvider();
    if (!injected) {
      say("No wallet detected. Install MetaMask, then switch it to Coston2.", "error");
      return;
    }
    try {
      const wallet = createWalletClient({ chain: coston2, transport: custom(injected as never) });
      const [address] = await wallet.requestAddresses();
      const chainId = await wallet.getChainId();
      setAccount(address);
      setWrongNetwork(chainId !== coston2.id);
      say(chainId === coston2.id ? "Wallet connected." : "Wallet connected, but it is on the wrong network.");
    } catch (error) {
      trackError(error);
      say(error instanceof Error ? error.message.split("\n")[0] : "Could not connect.", "error");
    }
  }

  async function switchNetwork() {
    const injected = injectedProvider();
    if (!injected) return;
    try {
      const wallet = createWalletClient({ chain: coston2, transport: custom(injected as never) });
      await wallet.switchChain({ id: coston2.id });
      setWrongNetwork(false);
      say("Switched to Coston2.");
    } catch {
      // Chain is usually just not added to the wallet yet.
      try {
        const wallet = createWalletClient({ chain: coston2, transport: custom(injected as never) });
        await wallet.addChain({ chain: coston2 });
        setWrongNetwork(false);
        say("Added and switched to Coston2.");
      } catch {
        say("Could not switch network. Change it manually in your wallet.", "error");
      }
    }
  }

  async function seal(event: React.FormEvent) {
    event.preventDefault();
    if (!account || !teeKey) return;

    setBusy(true);
    try {
      const injected = injectedProvider();
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
      trackEvent("order_sealed", { wallet_connected: true });
      await loadOrders();
    } catch (error) {
      trackError(error);
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
      const injected = injectedProvider();
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
      say(`Order ${orderId} cancelled. Escrow refunded.`);
      trackEvent("order_cancelled", { wallet_connected: true });
      await loadOrders();
    } catch (error) {
      trackError(error);
      const message = error instanceof Error ? error.message : String(error);
      say(message.split("\n")[0], "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <div id="nav-sentinel" aria-hidden="true" />

      <header className="app-head">
        <div className="shell">
          <h1 className="app-title">Orders</h1>
          <p className="app-sub">
            Compose a conditional order. The trigger is encrypted in this browser and stored onchain as ciphertext.
          </p>
        </div>
      </header>

      <Ticker />

      {wrongNetwork && (
        <div className="banner" role="alert">
          <span>Your wallet is not on Coston2. Orders cannot be read or sealed from another network.</span>
          <button className="banner-action" type="button" onClick={switchNetwork}>
            Switch to Coston2
          </button>
        </div>
      )}

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
            <span className="stat-label">FXRP in escrow</span>
          </div>
        </section>

        <div className="workspace">
          <section aria-labelledby="compose-title" id="compose">
            <h2 className="panel-title" id="compose-title">
              Compose an order
            </h2>

            <form className="compose" onSubmit={seal}>
              <label className="field">
                <span className="field-label">Escrow (FXRP)</span>
                <input value={amount} onChange={(e) => { setAmount(e.target.value); startCompose(); }} inputMode="decimal" required />
              </label>

              <div className="field field-secret">
                <span className="field-label">Trigger</span>
                <div className="field-row">
                  <select value={direction} onChange={(e) => { setDirection(e.target.value as Direction); startCompose(); }}>
                    <option value="below">Falls to</option>
                    <option value="above">Rises to</option>
                  </select>
                  <input
                    value={threshold}
                    onChange={(e) => { setThreshold(e.target.value); startCompose(); }}
                    inputMode="decimal"
                    aria-label="Trigger price"
                    required
                  />
                </div>
              </div>

              <div className="field field-secret">
                <span className="field-label">Then</span>
                <div className="field-row">
                  <select value={action} onChange={(e) => { setAction(e.target.value as ActionKind); startCompose(); }}>
                    <option value="swap">Swap</option>
                    <option value="redeem">Redeem to XRP</option>
                  </select>
                  <input
                    value={minOut}
                    onChange={(e) => { setMinOut(e.target.value); startCompose(); }}
                    inputMode="decimal"
                    aria-label={action === "swap" ? "Minimum output" : "Lots to redeem"}
                    required
                  />
                </div>
              </div>

              {action === "redeem" && (
                <label className="field field-secret">
                  <span className="field-label">XRPL destination</span>
                  <input
                    value={xrplAddress}
                    onChange={(e) => { setXrplAddress(e.target.value); startCompose(); }}
                    placeholder="r…"
                    pattern="r[1-9A-HJ-NP-Za-km-z]{24,34}"
                    title="An XRPL classic address, starting with r"
                    required
                  />
                </label>
              )}

              <label className="field">
                <span className="field-label">Expires in (days)</span>
                <input
                  value={days}
                  onChange={(e) => { setDays(e.target.value); startCompose(); }}
                  inputMode="numeric"
                  pattern="[0-9]+"
                  required
                />
              </label>

              <p className="secret-note">
                Marked fields are encrypted in this browser and never published. The chain stores only ciphertext
                and the escrow.
              </p>

              {account ? (
                <button className="submit" type="submit" disabled={busy || !teeKey || !configured || wrongNetwork}>
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
            <div className="panel-head">
              <h2 className="panel-title" id="orders-title">
                Sealed orders
              </h2>
              {account && (
                <div className="filter" role="group" aria-label="Filter orders">
                  <button
                    className="filter-btn"
                    type="button"
                    aria-pressed={filter === "all"}
                    onClick={() => setFilter("all")}
                  >
                    All
                  </button>
                  <button
                    className="filter-btn"
                    type="button"
                    aria-pressed={filter === "mine"}
                    onClick={() => setFilter("mine")}
                  >
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
              <div className="orders">
                {visible.map((order, i) => (
                  <article className="order" key={order.id} style={{ animationDelay: `${Math.min(i, 6) * 45}ms` }}>
                    <div className="order-head">
                      <span className="order-id">Order {order.id}</span>
                      <span className="head-actions">
                        {order.state === "sealed" && account?.toLowerCase() === order.owner.toLowerCase() && (
                          <button
                            className="cancel-btn"
                            type="button"
                            disabled={busy}
                            onClick={() => cancelOrder(order.id)}
                          >
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
                          {Number(formatUnits(order.amountIn, 18)).toLocaleString()} FXRP
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

                    <div className="seal">
                      <span className="seal-label">Condition · sealed</span>
                      <p className="cipher">{formatCipher(order.encrypted)}</p>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>

        <ActivityLog address={WRAITH_ADDRESS || undefined} />
      </div>

      <footer className="footer">
        <div className="shell footer-inner">
          <p className="footer-note">
            Coston2 testnet. Flare Confidential Compute is pre-release — do not put real funds behind this.
          </p>
          <nav className="footer-links" aria-label="Project links">
            <a className="tx-link" href="https://github.com/LSUDOKO/Wraith" target="_blank" rel="noreferrer">
              Source
            </a>
            <a
              className="tx-link"
              href="https://github.com/LSUDOKO/Wraith/blob/main/docs/TRUST.md"
              target="_blank"
              rel="noreferrer"
            >
              Trust assumptions
            </a>
            <a className="tx-link" href="https://dev.flare.network/fcc/overview" target="_blank" rel="noreferrer">
              Flare Confidential Compute
            </a>
            {WRAITH_ADDRESS && (
              <a className="tx-link" href={explorerAddress(WRAITH_ADDRESS)} target="_blank" rel="noreferrer">
                Contract
              </a>
            )}
          </nav>
        </div>
      </footer>
    </main>
  );
}
