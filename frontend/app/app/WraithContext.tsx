"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPublicClient, createWalletClient, custom, http, type Address } from "viem";
import { coston2, ERC20_ABI, WRAITH_ABI } from "@/lib/wraith";
import { setPersonProperties, trackError, trackEvent } from "@/lib/analytics";

export const WRAITH_ADDRESS = (process.env.NEXT_PUBLIC_WRAITH_ADDRESS ?? "") as Address;
export const ESCROW_ADDRESS = (process.env.NEXT_PUBLIC_ESCROW_ADDRESS ||
  "0xC67DCE33D7A8efA5FfEB961899C73fe01bCe9273") as Address;

export const publicClient = createPublicClient({ chain: coston2, transport: http() });

export type OrderState = "sealed" | "executed" | "cancelled" | "expired";

export type Order = {
  id: number;
  owner: Address;
  amountIn: bigint;
  expiry: bigint;
  executed: boolean;
  cancelled: boolean;
  encrypted: `0x${string}`;
  state: OrderState;
  peak: bigint;
  remaining: bigint;
};

function stateOf(o: { executed: boolean; cancelled: boolean; expiry: bigint }): OrderState {
  if (o.executed) return "executed";
  if (o.cancelled) return "cancelled";
  if (BigInt(Math.floor(Date.now() / 1000)) >= o.expiry) return "expired";
  return "sealed";
}

export function injectedProvider(): unknown {
  if (typeof window === "undefined") return undefined;
  return (window as { ethereum?: unknown }).ethereum;
}

type Ctx = {
  account?: Address;
  provider: unknown;
  wrongNetwork: boolean;
  teeKey?: string;
  orders: Order[];
  loadingOrders: boolean;
  symbol: string;
  balance?: bigint;
  status: string;
  tone: "info" | "error";
  busy: boolean;
  lastTx?: string;
  configured: boolean;
  stats: { total: number; sealed: number; executed: number; escrowed: bigint };

  setBusy: (busy: boolean) => void;
  setLastTx: (tx?: string) => void;
  say: (message: string, kind?: "info" | "error") => void;
  connect: (kind?: "injected" | "walletconnect") => Promise<void>;
  switchNetwork: () => Promise<void>;
  loadOrders: () => Promise<void>;
  loadBalance: (who?: Address) => Promise<void>;
  cancelOrder: (orderId: number) => Promise<void>;
};

const WraithCtx = createContext<Ctx | null>(null);

export function useWraith(): Ctx {
  const ctx = useContext(WraithCtx);
  if (!ctx) throw new Error("useWraith must be used inside <WraithProvider>");
  return ctx;
}

/**
 * Everything the app's three routes share.
 *
 * The composer, the order list and the activity feed are separate pages now,
 * but they are one session: the same wallet, the same order set, the same
 * status line. Lifting that into a provider is what lets the chart have the
 * full page width without the routes each opening their own connection and
 * polling the chain independently.
 */
export function WraithProvider({ children }: { children: ReactNode }) {
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

  const say = useCallback((message: string, kind: "info" | "error" = "info") => {
    setStatus(message);
    setTone(kind);
  }, []);

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
  }, [say]);

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
  }, [loadOrders, say]);

  useEffect(() => {
    setPersonProperties({ wallet_connected: Boolean(account) });
  }, [account]);

  useEffect(() => {
    if (wrongNetwork) trackEvent("wrong_network_shown", { wallet_connected: Boolean(account) });
  }, [wrongNetwork, account]);

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

  const connect = useCallback(
    async (kind: "injected" | "walletconnect" = "injected") => {
      let active: unknown;

      if (kind === "walletconnect") {
        try {
          // Imported lazily so the WalletConnect SDK stays out of the bundle
          // for injected-only users.
          const { walletConnectProvider } = await import("./walletconnect");
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
    },
    [loadBalance, say],
  );

  const switchNetwork = useCallback(async () => {
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
  }, [provider, say]);

  const cancelOrder = useCallback(
    async (orderId: number) => {
      if (!account) return;
      setBusy(true);
      try {
        const wallet = createWalletClient({
          account,
          chain: coston2,
          transport: custom((provider ?? injectedProvider()) as never),
        });

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
    },
    [account, provider, loadOrders, say],
  );

  const value: Ctx = {
    account,
    provider,
    wrongNetwork,
    teeKey,
    orders,
    loadingOrders,
    symbol,
    balance,
    status,
    tone,
    busy,
    lastTx,
    configured,
    stats,
    setBusy,
    setLastTx,
    say,
    connect,
    switchNetwork,
    loadOrders,
    loadBalance,
    cancelOrder,
  };

  return <WraithCtx.Provider value={value}>{children}</WraithCtx.Provider>;
}
