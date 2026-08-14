"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  keccak256,
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
  e18ToPrice,
  FEEDS,
  sealTerms,
  type ActionKind,
  type Direction,
} from "@/lib/wraith";
import { Ticker } from "@/app/components/Ticker";
import { ActivityLog } from "@/app/components/ActivityLog";
import { SystemStatus } from "@/app/components/SystemStatus";
import { AgentWatchlist } from "@/app/components/AgentWatchlist";
import { Alerts } from "@/app/components/Alerts";
import { PriceChart } from "@/app/components/PriceChart";
import { FiresAt } from "@/app/components/FiresAt";
import { OrderTimeline } from "@/app/components/OrderTimeline";
import {
  KIND_PRICE,
  KIND_AGENT_HEALTH,
  KIND_TRAILING,
  KIND_TWAP,
  KIND_CROSSCHAIN,
  KIND_CONSENSUS,
  newSeed,
  sourceAddressHash,
  CREATE_ORDER_TYPES,
  createOrderDomain,
} from "@/lib/wraith";
import { remember, recall, describe, MODE_LABEL } from "@/lib/recall";
import { trackEvent, setPersonProperties, trackError } from "@/lib/analytics";

const WRAITH_ADDRESS = (process.env.NEXT_PUBLIC_WRAITH_ADDRESS ?? "") as Address;
// Escrow asset. Defaults to wrapped native because a tester can mint it from
// faucet funds in one click; FXRP needs an FAssets agent and a minting flow,
// which is why an empty-FXRP wallet used to fail with FAssetBalanceTooLow.
const ESCROW_ADDRESS = (process.env.NEXT_PUBLIC_ESCROW_ADDRESS || WC2FLR_ADDRESS) as Address;
const IS_WRAPPED_NATIVE = ESCROW_ADDRESS.toLowerCase() === WC2FLR_ADDRESS.toLowerCase();
const TOKEN_OUT = (process.env.NEXT_PUBLIC_TOKEN_OUT ?? "") as Address;
const FEED_ID = (process.env.NEXT_PUBLIC_FEED_ID ?? "0x01464c522f55534400000000000000000000000000") as Hex;
// Only shown when an operator has actually funded a relayer. Offering a
// gasless path that then fails is worse than not offering one.
const RELAYER_ENABLED = process.env.NEXT_PUBLIC_RELAYER_ENABLED === "true";
// Name the configured feed rather than assuming FLR: the chart and the readout
// both label what they are showing, and a wrong label is worse than none.
const FEED_LABEL = FEEDS.find((f) => f.id.toLowerCase() === FEED_ID.toLowerCase())?.label ?? "Configured feed";
/** Kinds the chart can speak about. A shield watches collateral and a
 *  cross-chain order watches a payment, so a price chart would say nothing
 *  about either. */
const CHART_MODES = new Set(["price", "trailing", "stealth"]);

/** Which sealed condition each composer tab produces. */
const KIND_BY_MODE = {
  price: KIND_PRICE,
  trailing: KIND_TRAILING,
  stealth: KIND_TWAP,
  shield: KIND_AGENT_HEALTH,
  crosschain: KIND_CROSSCHAIN,
  consensus: KIND_CONSENSUS,
} as const;

const MAX_UINT256 = (1n << 256n) - 1n;

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
  /** Running high-water mark for trailing stops, 1e18. */
  peak: bigint;
  /** Escrow not yet spent — below amountIn means a chunked order is midway. */
  remaining: bigint;
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
  const [mode, setMode] = useState<
    "price" | "trailing" | "stealth" | "shield" | "crosschain" | "consensus"
  >("price");
  const [watchAddress, setWatchAddress] = useState("");
  const [watchAmount, setWatchAmount] = useState("100");
  const [deviationPct, setDeviationPct] = useState("2");
  const [gasless, setGasless] = useState(false);
  const [relayerFee, setRelayerFee] = useState("0.5");
  const [trailPct, setTrailPct] = useState("5");
  const [chunks, setChunks] = useState("6");
  const [hours, setHours] = useState("4");
  const [agent, setAgent] = useState("");
  const [collateralFloor, setCollateralFloor] = useState("120");
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
          const [order, peak, remaining] = await Promise.all([
            publicClient.readContract({
              address: WRAITH_ADDRESS,
              abi: WRAITH_ABI,
              functionName: "getOrder",
              args: [id],
            }),
            publicClient
              .readContract({ address: WRAITH_ADDRESS, abi: WRAITH_ABI, functionName: "peakOf", args: [id] })
              .catch(() => 0n),
            publicClient
              .readContract({ address: WRAITH_ADDRESS, abi: WRAITH_ABI, functionName: "remainingOf", args: [id] })
              .catch(() => 0n),
          ]);
          const [owner, , amountIn, expiry, executed, cancelled, encrypted] = order;
          const base = { owner, amountIn, expiry, executed, cancelled };
          return { id: Number(id), ...base, encrypted, state: stateOf(base), peak, remaining } satisfies Order;
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

      if (mode === "shield" && !agent) {
        say("Pick an agent to shield before sealing.", "error");
        setBusy(false);
        return;
      }

      if (mode === "crosschain" && !watchAddress.trim()) {
        say("Name the XRPL address to watch before sealing.", "error");
        setBusy(false);
        return;
      }

      say("Encrypting your condition in this browser…");
      const encrypted = await sealTerms(
        {
          contract: WRAITH_ADDRESS,
          feedId: FEED_ID,
          direction,
          kind: KIND_BY_MODE[mode],
          agent: (agent || "0x0000000000000000000000000000000000000000") as Address,
          // Percent in the UI, BIPS on the wire — 120% becomes 12000.
          minCollateralBIPS: mode === "shield" ? BigInt(Math.round(Number(collateralFloor) * 100)) : 0n,
          // Percent in the UI, BIPS on the wire — 5% becomes 500. Trailing and
          // consensus share this slot: the kinds are mutually exclusive, so a
          // trail distance and a deviation tolerance never coexist in one order.
          trailBIPS:
            mode === "trailing"
              ? BigInt(Math.round(Number(trailPct) * 100))
              : mode === "consensus"
                ? BigInt(Math.round(Number(deviationPct) * 100))
                : 0n,
          // A fresh seed per order, so two orders never share a schedule.
          seed: mode === "stealth" ? newSeed() : undefined,
          chunks: mode === "stealth" ? BigInt(chunks) : 0n,
          startAt: mode === "stealth" ? BigInt(Math.floor(Date.now() / 1000)) : 0n,
          endAt: mode === "stealth" ? BigInt(Math.floor(Date.now() / 1000) + Number(hours) * 3600) : 0n,
          // A cross-chain order's "threshold" is the payment size that fires it,
          // not a price — the same slot, a different unit.
          thresholdE18: mode === "crosschain" ? priceToE18(watchAmount) : priceToE18(threshold),
          // Empty means a plain single-leg order; the enclave treats 0 as unset.
          secondThresholdE18: takeProfit.trim() ? priceToE18(takeProfit) : 0n,
          action,
          minOutOrLots: action === "swap" ? parseUnits(minOut, decimals) : BigInt(minOut),
          tokenOut: TOKEN_OUT,
          // For a cross-chain order this slot names the source being watched, and
          // it travels as the FDC address hash so the account itself never
          // appears on-chain — not in the ciphertext's shadow, not in the tick.
          underlyingAddress: mode === "crosschain" ? sourceAddressHash(watchAddress) : xrplAddress,
          expiry,
        },
        teeKey,
      );

      const fee = gasless ? parseUnits(relayerFee, decimals) : 0n;

      // Skipping a redundant approval is what makes the gasless path actually
      // gasless on the second order: the allowance is the one thing the user
      // must still sign a transaction for, so it is worth only doing once.
      const allowance = await publicClient.readContract({
        address: ESCROW_ADDRESS,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [account, WRAITH_ADDRESS],
      });
      if (allowance < amountIn + fee) {
        say("Approving escrow…");
        const approveHash = await wallet.writeContract({
          address: ESCROW_ADDRESS,
          abi: ERC20_ABI,
          functionName: "approve",
          // A gasless user opts into a standing allowance, because a per-order
          // approval would put a funded transaction back in front of every
          // order and defeat the point.
          args: [WRAITH_ADDRESS, gasless ? MAX_UINT256 : amountIn + fee],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      let hash: Hex;
      if (gasless) {
        hash = await relayOrder(wallet, encrypted, amountIn, expiry, fee);
      } else {
        say("Sealing the order on Coston2…");
        hash = await wallet.writeContract({
          address: WRAITH_ADDRESS,
          abi: WRAITH_ABI,
          functionName: "createOrder",
          args: [encrypted, ESCROW_ADDRESS, amountIn, expiry],
        });
      }
      await publicClient.waitForTransactionReceipt({ hash });

      setLastTx(hash);

      // The ciphertext is encrypted to the enclave, not to the user, so without
      // a local copy nobody — including the owner — can ever read the condition
      // back. Kept in this browser only, so it changes nothing an observer sees.
      const newId = Number(
        await publicClient.readContract({
          address: WRAITH_ADDRESS,
          abi: WRAITH_ABI,
          functionName: "orderCount",
        }),
      ) - 1;
      if (newId >= 0) {
        remember(WRAITH_ADDRESS, newId, {
          mode,
          direction,
          threshold,
          takeProfit: takeProfit.trim() || undefined,
          action,
          minOutOrLots: minOut,
          escrow: amount,
          sealedAt: Date.now(),
          trailPct: mode === "trailing" ? trailPct : undefined,
          chunks: mode === "stealth" ? chunks : undefined,
          hours: mode === "stealth" ? hours : undefined,
          agent: mode === "shield" ? agent : undefined,
          collateralFloor: mode === "shield" ? collateralFloor : undefined,
          watchAddress: mode === "crosschain" ? watchAddress : undefined,
          watchAmount: mode === "crosschain" ? watchAmount : undefined,
          deviationPct: mode === "consensus" ? deviationPct : undefined,
        });
      }

      say("Sealed. Your trigger never touched the chain in the clear.");
      trackEvent("order_sealed", { order_mode: mode, gasless, wallet_connected: true });
      await loadOrders();
    } catch (error) {
      trackError(error);
      const message = error instanceof Error ? error.message : String(error);
      say(message.split("\n")[0], "error");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Hand a signed order to the sponsor.
   *
   * The user signs an EIP-712 intent — free, no chain interaction — and the
   * relayer pays the gas, reimbursing itself in the escrowed token. Every field
   * is covered by the signature, so the relayer cannot change where the escrow
   * goes, what the sealed terms are, or what it charges.
   */
  async function relayOrder(
    wallet: ReturnType<typeof createWalletClient>,
    encrypted: Hex,
    amountIn: bigint,
    expiry: bigint,
    fee: bigint,
  ): Promise<Hex> {
    if (!account) throw new Error("connect a wallet first");

    const nonce = await publicClient.readContract({
      address: WRAITH_ADDRESS,
      abi: WRAITH_ABI,
      functionName: "nonces",
      args: [account],
    });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    say("Sign the order — this costs you nothing…");
    const signature = await wallet.signTypedData({
      account,
      domain: createOrderDomain(WRAITH_ADDRESS),
      types: CREATE_ORDER_TYPES,
      primaryType: "CreateOrder",
      message: {
        owner: account,
        encryptedHash: keccak256(encrypted),
        tokenIn: ESCROW_ADDRESS,
        amountIn,
        expiry,
        relayerFee: fee,
        nonce,
        deadline,
      },
    });

    say("Relaying your order — the sponsor pays the gas…");
    const response = await fetch("/api/relay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wraith: WRAITH_ADDRESS,
        encrypted,
        signature,
        intent: {
          owner: account,
          tokenIn: ESCROW_ADDRESS,
          amountIn: amountIn.toString(),
          expiry: expiry.toString(),
          relayerFee: fee.toString(),
          deadline: deadline.toString(),
        },
      }),
    });

    const relayed = await response.json();
    if (!response.ok) throw new Error(relayed?.error ?? "the relayer refused the order");
    return relayed.hash as Hex;
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
            <span className="stat-label">{symbol || "Tokens"} in escrow</span>
          </div>
        </section>

        <div className="workspace">
          <section aria-labelledby="compose-title" id="compose">
            <h2 className="panel-title" id="compose-title">
              Compose an order
            </h2>

            {CHART_MODES.has(mode) && (
              <PriceChart
                feedId={FEED_ID}
                feedLabel={FEED_LABEL}
                direction={direction}
                thresholdE18={priceToE18(threshold || "0")}
                takeProfitE18={takeProfit.trim() ? priceToE18(takeProfit) : undefined}
                // A new trailing order has no peak: the first tick establishes
                // it. Drawing a speculative line here would be a fake level.
                peakE18={undefined}
                onThresholdChange={(next) => {
                  setThreshold(String(e18ToPrice(next)));
                  startCompose();
                }}
              />
            )}

            <form className="compose" onSubmit={seal}>
              <label className="field">
                <span className="field-label">Escrow{symbol ? ` (${symbol})` : ""}</span>
                <input value={amount} onChange={(e) => { setAmount(e.target.value); startCompose(); }} inputMode="decimal" required />
              </label>

              <div className="modes" role="tablist" aria-label="Order type">
                <button
                  className="mode"
                  type="button"
                  role="tab"
                  aria-selected={mode === "price"}
                  onClick={() => setMode("price")}
                >
                  Price
                </button>
                <button
                  className="mode"
                  type="button"
                  role="tab"
                  aria-selected={mode === "trailing"}
                  onClick={() => setMode("trailing")}
                >
                  Trailing
                </button>
                <button
                  className="mode"
                  type="button"
                  role="tab"
                  aria-selected={mode === "stealth"}
                  onClick={() => setMode("stealth")}
                >
                  Stealth
                </button>
                <button
                  className="mode"
                  type="button"
                  role="tab"
                  aria-selected={mode === "shield"}
                  onClick={() => setMode("shield")}
                >
                  FAssets Shield
                </button>
                <button
                  className="mode"
                  type="button"
                  role="tab"
                  aria-selected={mode === "crosschain"}
                  onClick={() => setMode("crosschain")}
                >
                  Cross-chain
                </button>
                <button
                  className="mode"
                  type="button"
                  role="tab"
                  aria-selected={mode === "consensus"}
                  onClick={() => setMode("consensus")}
                >
                  Consensus
                </button>
              </div>

              {mode === "crosschain" && (
                <>
                  <label className="field field-secret">
                    <span className="field-label">
                      XRPL address to watch <span className="field-hint">never leaves this browser</span>
                    </span>
                    <input
                      value={watchAddress}
                      onChange={(e) => { setWatchAddress(e.target.value); startCompose(); }}
                      placeholder="r…"
                      pattern="r[1-9A-HJ-NP-Za-km-z]{24,34}"
                      title="An XRPL classic address, starting with r"
                      required
                    />
                  </label>

                  <label className="field field-secret">
                    <span className="field-label">
                      Fire when a payment of at least <span className="field-hint">XRP</span>
                    </span>
                    <input
                      value={watchAmount}
                      onChange={(e) => setWatchAmount(e.target.value)}
                      inputMode="decimal"
                      aria-label="Payment amount in XRP"
                      required
                    />
                  </label>

                  <p className="secret-note">
                    The enclave cannot reach FDC, so a keeper fetches the attestation proof and the contract
                    verifies it onchain before relaying the reading inward. What that publishes is a payment
                    XRPL already made public. The address travels as its FDC hash and the amount that fires the
                    order stays encrypted, so neither is readable onchain.
                  </p>
                </>
              )}

              {mode === "consensus" && (
                <>
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
                      Refuse to act if the two sources differ by more than{" "}
                      <span className="field-hint">percent</span>
                    </span>
                    <input
                      value={deviationPct}
                      onChange={(e) => setDeviationPct(e.target.value)}
                      inputMode="decimal"
                      aria-label="Maximum oracle deviation percent"
                      required
                    />
                  </label>

                  <p className="secret-note">
                    Privacy stops someone aiming at your trigger; it does not stop them walking a single price
                    feed until something fires. A consensus order settles only when FTSO and an FDC-attested
                    off-chain price both cross the level, and refuses to act at all when they disagree too
                    widely to trust either.
                  </p>
                </>
              )}

              {mode === "shield" && (
                <>
                  <div className="field">
                    <span className="field-label">Agent to shield</span>
                    <AgentWatchlist
                      floorPct={Number(collateralFloor) || 120}
                      selected={agent}
                      onSelect={setAgent}
                    />
                    {agent ? (
                      <p className="agent-picked cipher">
                        watching {agent.slice(0, 10)}…{agent.slice(-6)}
                      </p>
                    ) : (
                      <p className="agent-picked">Select an agent above.</p>
                    )}
                  </div>

                  <label className="field field-secret">
                    <span className="field-label">
                      Escape when collateral falls to <span className="field-hint">either vault or pool</span>
                    </span>
                    <input
                      value={collateralFloor}
                      onChange={(e) => setCollateralFloor(e.target.value)}
                      inputMode="decimal"
                      aria-label="Collateral floor percentage"
                      required
                    />
                  </label>

                  <p className="secret-note">
                    Shield also fires the moment the agent leaves normal status, whatever the ratio reads. Your
                    floor stays encrypted, so nobody can position against your exit.
                  </p>
                </>
              )}

              {mode === "stealth" && (
                <>
                  <div className="field field-secret">
                    <span className="field-label">Release over</span>
                    <div className="field-row">
                      <input
                        value={chunks}
                        onChange={(e) => setChunks(e.target.value)}
                        inputMode="numeric"
                        aria-label="Number of chunks"
                        required
                      />
                      <input
                        value={hours}
                        onChange={(e) => setHours(e.target.value)}
                        inputMode="decimal"
                        aria-label="Hours"
                        required
                      />
                    </div>
                    <p className="agent-picked">chunks · hours</p>
                  </div>

                  <p className="secret-note">
                    A single large sell moves the market and announces its size. Stealth splits it into tranches at
                    times and sizes derived from a seed that only the enclave can read. Observers see chunks land
                    but cannot tell how many remain or when the next is due.
                  </p>
                </>
              )}

              {mode === "trailing" && (
                <>
                  <label className="field field-secret">
                    <span className="field-label">
                      Sell if price falls <span className="field-hint">below its peak, by</span>
                    </span>
                    <input
                      value={trailPct}
                      onChange={(e) => setTrailPct(e.target.value)}
                      inputMode="decimal"
                      aria-label="Trail distance percent"
                      required
                    />
                  </label>

                  <p className="secret-note">
                    The stop follows price up and never back down. The peak is tracked onchain — it comes from
                    public FTSO prices, so it gives nothing away. Your trail distance stays encrypted, and without
                    it the peak says nothing about where you exit.
                  </p>
                </>
              )}

              <div className="field field-secret" hidden={mode !== "price"}>
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

              <label className="field field-secret" hidden={mode !== "price"}>
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

              {RELAYER_ENABLED && (
                <div className="field">
                  <label className="field-label" htmlFor="gasless">
                    <input
                      id="gasless"
                      type="checkbox"
                      checked={gasless}
                      onChange={(e) => { setGasless(e.target.checked); startCompose(); }}
                    />{" "}
                    Open this order without holding {coston2.nativeCurrency.symbol}
                  </label>
                  {gasless && (
                    <>
                      <div className="field-row">
                        <input
                          value={relayerFee}
                          onChange={(e) => setRelayerFee(e.target.value)}
                          inputMode="decimal"
                          aria-label="Relayer fee"
                        />
                      </div>
                      <p className="agent-picked">
                        paid to the sponsor in {symbol || "escrow"}, on top of the amount escrowed
                      </p>
                    </>
                  )}
                  <p className="secret-note">
                    You sign the order; a sponsor pays the gas and takes its fee out of the same token you are
                    escrowing. The signature covers every field, so the sponsor cannot change where your funds
                    go or what it charges. One approval transaction is still needed the first time.
                  </p>
                </div>
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

              <FiresAt
                feedId={FEED_ID}
                feedLabel={FEED_LABEL}
                escrowSymbol={symbol || "escrow"}
                outSymbol={symbol || "tokens"}
                mode={mode}
                direction={direction}
                thresholdE18={priceToE18(threshold || "0")}
                takeProfitE18={takeProfit.trim() ? priceToE18(takeProfit) : undefined}
                escrow={Number(amount) || 0}
                minOut={Number(minOut) || 0}
                action={action}
                expirySec={Math.floor(Date.now() / 1000) + Number(days) * 86_400}
                xrplAddress={xrplAddress}
                // A composer builds a new order, which has no peak until its
                // first tick. Showing one would invent a level.
                peak={0}
                trailPct={Number(trailPct) || 0}
                chunks={Number(chunks) || 0}
                hours={Number(hours) || 0}
              />

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
                      <span className="order-id">
                        Order {order.id}
                        {(() => {
                          const known =
                            account?.toLowerCase() === order.owner.toLowerCase()
                              ? recall(WRAITH_ADDRESS, order.id)
                              : undefined;
                          // Only the owner's own device knows the kind. To
                          // everyone else the order is opaque, which is the
                          // point — so no badge is shown rather than a guess.
                          return known ? (
                            <span className="order-mode">{MODE_LABEL[known.mode ?? "price"]}</span>
                          ) : null;
                        })()}
                      </span>
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
                          {Number(formatUnits(order.amountIn, 18)).toLocaleString()} {symbol || ""}
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

                    {(order.peak > 0n || (order.remaining > 0n && order.remaining < order.amountIn)) && (
                      <div className="facts live-facts">
                        {order.peak > 0n && (
                          <div>
                            <div className="fact-label">Peak tracked</div>
                            <div className="fact-value">
                              ${Number(formatUnits(order.peak, 18)).toLocaleString(undefined, {
                                maximumFractionDigits: 6,
                              })}
                            </div>
                          </div>
                        )}
                        {order.remaining < order.amountIn && (
                          <div>
                            <div className="fact-label">Filled</div>
                            <div className="fact-value">
                              {(
                                (Number(order.amountIn - order.remaining) / Number(order.amountIn)) *
                                100
                              ).toFixed(0)}
                              % · {Number(formatUnits(order.remaining, 18)).toLocaleString()} left
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="seal">
                      <span className="seal-label">Condition · sealed</span>
                      <p className="cipher">{formatCipher(order.encrypted)}</p>
                    </div>

                    <OrderTimeline contract={WRAITH_ADDRESS || undefined} orderId={Number(order.id)} />

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

        <Alerts address={account} />

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
