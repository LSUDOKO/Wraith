"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  WNAT_ABI,
  WC2FLR_ADDRESS,
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
import { SystemStatus } from "@/app/components/SystemStatus";
import { remember, recall, describe } from "@/lib/recall";
import { trackEvent, setPersonProperties, trackError } from "@/lib/analytics";

const WRAITH_ADDRESS = (process.env.NEXT_PUBLIC_WRAITH_ADDRESS ?? "") as Address;
// Escrow asset. Defaults to wrapped native because a tester can mint it from
// faucet funds in one click; FXRP needs an FAssets agent and a minting flow,
// which is why an empty-FXRP wallet used to fail with FAssetBalanceTooLow.
const ESCROW_ADDRESS = (process.env.NEXT_PUBLIC_ESCROW_ADDRESS || WC2FLR_ADDRESS) as Address;
const IS_WRAPPED_NATIVE = ESCROW_ADDRESS.toLowerCase() === WC2FLR_ADDRESS.toLowerCase();
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

const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

/**
 * Opens a WalletConnect session, which is what lets mobile and hardware
 * wallets in — window.ethereum only ever covers a desktop extension.
 * Imported lazily so the SDK stays out of the bundle for injected-only users.
 */
async function walletConnectProvider(): Promise<unknown> {
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  return EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    chains: [coston2.id],
    showQrModal: true,
    rpcMap: { [coston2.id]: coston2.rpcUrls.default.http[0] },
  });
}

export default function Home() {
  const [account, setAccount] = useState<Address>();
  const [provider, setProvider] = useState<unknown>();
  const [wrongNetwork, setWrongNetwork] = useState(false);
  const [teeKey, setTeeKey] = useState<string>();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<"info" | "error">("info");
  const [busy, setBusy] = useState(false);
  const [lastTx, setLastTx] = useState<string>();
  const [balance, setBalance] = useState<bigint>();
  const [symbol, setSymbol] = useState("");
  const [filter, setFilter] = useState<"all" | "mine">("all");

  const [amount, setAmount] = useState("100");
  const [direction, setDirection] = useState<Direction>("below");
  const [threshold, setThreshold] = useState("2.00");
  const [takeProfit, setTakeProfit] = useState("");
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

  const configured = Boolean(WRAITH_ADDRESS && ESCROW_ADDRESS);

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

  const loadBalance = useCallback(async (who?: Address) => {
    if (!who || !ESCROW_ADDRESS) return;
    try {
      const [bal, sym] = await Promise.all([
        publicClient.readContract({ address: ESCROW_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [who] }),
        publicClient.readContract({ address: ESCROW_ADDRESS, abi: ERC20_ABI, functionName: "symbol" }),
      ]);
      setBalance(bal);
      setSymbol(sym);
    } catch {
      // A missing balance is not fatal; submission still checks before sending.
    }
  }, []);

  // Alert on state changes the user did not trigger themselves — an order
  // firing is the whole point and they will not be staring at this tab.
  const seenStates = useRef<Map<number, OrderState>>(new Map());
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;

    for (const order of orders) {
      const prev = seenStates.current.get(order.id);
      seenStates.current.set(order.id, order.state);
      if (!prev || prev === order.state) continue;
      if (order.state !== "executed" && order.state !== "cancelled") continue;
      if (account && order.owner.toLowerCase() !== account.toLowerCase()) continue;

      if (Notification.permission === "granted") {
        new Notification(`Wraith order ${order.id} ${order.state}`, {
          body:
            order.state === "executed"
              ? "Your condition fired and the order settled."
              : "Your order was cancelled and the escrow refunded.",
        });
      }
    }
  }, [orders, account]);

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

  async function connect(kind: "injected" | "walletconnect" = "injected") {
    let active: unknown;

    if (kind === "walletconnect") {
      try {
        const wc = await walletConnectProvider();
        await (wc as { connect: () => Promise<void> }).connect();
        active = wc;
      } catch (error) {
        trackError(error);
        say(error instanceof Error ? error.message.split("\n")[0] : "WalletConnect failed.", "error");
        return;
      }
    } else {
      active = injectedProvider();
      if (!active) {
        say("No browser wallet detected. Install MetaMask, or connect a mobile wallet.", "error");
        return;
      }
    }

    try {
      const wallet = createWalletClient({ chain: coston2, transport: custom(active as never) });
      const [address] = await wallet.requestAddresses();
      const chainId = await wallet.getChainId();
      setProvider(active);
      setAccount(address);
      loadBalance(address);

      // Asked here rather than on page load: permission prompts out of context
      // get denied, and a connected wallet is the moment the offer makes sense.
      if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
      }
      setWrongNetwork(chainId !== coston2.id);
      say(chainId === coston2.id ? "Wallet connected." : "Wallet connected, but it is on the wrong network.");
    } catch (error) {
      trackError(error);
      say(error instanceof Error ? error.message.split("\n")[0] : "Could not connect.", "error");
    }
  }

  async function switchNetwork() {
    const active = provider ?? injectedProvider();
    if (!active) return;
    try {
      const wallet = createWalletClient({ chain: coston2, transport: custom(active as never) });
      await wallet.switchChain({ id: coston2.id });
      setWrongNetwork(false);
      say("Switched to Coston2.");
    } catch {
      // Chain is usually just not added to the wallet yet.
      try {
        const wallet = createWalletClient({ chain: coston2, transport: custom(active as never) });
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
      const wallet = createWalletClient({ account, chain: coston2, transport: custom((provider ?? injectedProvider()) as never) });

      const decimals = await publicClient.readContract({
        address: ESCROW_ADDRESS,
        abi: ERC20_ABI,
        functionName: "decimals",
      });
      const amountIn = parseUnits(amount, decimals);

      // Checking here turns a failed on-chain transaction — which costs gas and
      // reverts with an opaque token error — into an inline message.
      const held = await publicClient.readContract({
        address: ESCROW_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account],
      });
      if (held < amountIn) {
        setBalance(held);
        say(
          `Not enough ${symbol || "escrow"}: you hold ${formatUnits(held, decimals)} and this order needs ${amount}.`,
          "error",
        );
        setBusy(false);
        return;
      }
      const expiry = BigInt(Math.floor(Date.now() / 1000) + Number(days) * 86_400);

      say("Encrypting your condition in this browser…");
      const encrypted = await sealTerms(
        {
          contract: WRAITH_ADDRESS,
          feedId: FEED_ID,
          direction,
          thresholdE18: priceToE18(threshold),
          // Empty means a plain single-leg order; the enclave treats 0 as unset.
          secondThresholdE18: takeProfit.trim() ? priceToE18(takeProfit) : 0n,
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
        address: ESCROW_ADDRESS,
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
        args: [encrypted, ESCROW_ADDRESS, amountIn, expiry],
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

  async function wrapNative() {
    if (!account) return;
    setBusy(true);
    try {
      const wallet = createWalletClient({
        account,
        chain: coston2,
        transport: custom((provider ?? injectedProvider()) as never),
      });
      say("Wrapping 5 C2FLR into escrow…");
      const hash = await wallet.writeContract({
        address: ESCROW_ADDRESS,
        abi: WNAT_ABI,
        functionName: "deposit",
        value: 5_000_000_000_000_000_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setLastTx(hash);
      await loadBalance(account);
      say("Wrapped. You can seal an order now.");
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
      const wallet = createWalletClient({ account, chain: coston2, transport: custom((provider ?? injectedProvider()) as never) });

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

              <label className="field field-secret">
                <span className="field-label">
                  Take profit <span className="field-hint">optional — fires on either side</span>
                </span>
                <input
                  value={takeProfit}
                  onChange={(e) => setTakeProfit(e.target.value)}
                  inputMode="decimal"
                  placeholder={direction === "below" ? "above the stop" : "below the target"}
                />
              </label>

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

              {account && balance !== undefined && (
                <p className="balance-line">
                  Balance: <strong>{Number(formatUnits(balance, 18)).toLocaleString()}</strong> {symbol}
                  {IS_WRAPPED_NATIVE && (
                    <button className="link-btn" type="button" disabled={busy} onClick={wrapNative}>
                      Wrap 5 C2FLR
                    </button>
                  )}
                </p>
              )}

              <p className="secret-note">
                Marked fields are encrypted in this browser and never published. The chain stores only ciphertext
                and the escrow.
              </p>

              {account ? (
                <button className="submit" type="submit" disabled={busy || !teeKey || !configured || wrongNetwork}>
                  {busy ? "Sealing…" : teeKey ? "Seal and submit" : "Waiting for the enclave key"}
                </button>
              ) : (
                <div className="connect-choices">
                  <button className="submit" type="button" onClick={() => connect("injected")}>
                    Connect browser wallet
                  </button>
                  {WC_PROJECT_ID && (
                    <button className="btn btn-ghost connect-wc" type="button" onClick={() => connect("walletconnect")}>
                      Use a mobile or hardware wallet
                    </button>
                  )}
                </div>
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

                    {(() => {
                      const mine = account?.toLowerCase() === order.owner.toLowerCase();
                      const known = mine ? recall(WRAITH_ADDRESS, order.id) : undefined;
                      if (!mine) return null;
                      return known ? (
                        <p className="recall">
                          <span className="recall-tag">Only you can see this</span>
                          {describe(known)}
                        </p>
                      ) : (
                        <p className="recall recall-lost">
                          <span className="recall-tag">Only you can see this</span>
                          Sealed from another browser, so this device cannot show the condition. The order still
                          works.
                        </p>
                      );
                    })()}
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
