"use client";

import { useCallback, useState } from "react";
import { createWalletClient, custom, formatUnits, keccak256, parseUnits, type Address, type Hex } from "viem";
import {
  coston2,
  ERC20_ABI,
  WRAITH_ABI,
  WNAT_ABI,
  WC2FLR_ADDRESS,
  explorerTx,
  priceToE18,
  e18ToPrice,
  FEEDS,
  sealTerms,
  type ActionKind,
  type Direction,
} from "@/lib/wraith";
import { PriceChart } from "@/app/components/PriceChart";
import { FiresAt } from "@/app/components/FiresAt";
import { AgentWatchlist } from "@/app/components/AgentWatchlist";
import { SealSteps, idleSteps, type SealStep } from "@/app/components/SealSteps";
import { StrategyCards, type OrderMode } from "@/app/components/StrategyCards";
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
import { remember } from "@/lib/recall";
import { trackEvent, trackError } from "@/lib/analytics";
import { WC_PROJECT_ID } from "./walletconnect";
import { useWraith, publicClient, injectedProvider, WRAITH_ADDRESS, ESCROW_ADDRESS } from "./WraithContext";

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

export default function ComposePage() {
  const {
    account,
    provider,
    wrongNetwork,
    teeKey,
    symbol,
    balance,
    status,
    tone,
    busy,
    lastTx,
    configured,
    setBusy,
    setLastTx,
    say,
    connect,
    loadOrders,
    loadBalance,
  } = useWraith();

  const [amount, setAmount] = useState("100");
  const [direction, setDirection] = useState<Direction>("below");
  const [threshold, setThreshold] = useState("2.00");
  const [takeProfit, setTakeProfit] = useState("");
  const [mode, setMode] = useState<OrderMode>("price");
  // The take-profit leg is opt-in: an empty field was easy to miss, and a
  // bracket is a second firing condition rather than an extra input.
  const [oco, setOco] = useState(false);
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
  const [steps, setSteps] = useState<SealStep[]>(idleSteps);

  const startCompose = useCallback(() => {
    if (!composeStarted) {
      setComposeStarted(true);
      trackEvent("order_compose_started", { wallet_connected: Boolean(account) });
    }
  }, [composeStarted, account]);

  /** Update one stage of the seal pipeline without disturbing the others. */
  const markStep = (index: number, patch: Partial<SealStep>) =>
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...patch } : step)));

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

  async function seal(event: React.FormEvent) {
    event.preventDefault();
    if (!account || !teeKey) return;

    setBusy(true);
    try {
      const wallet = createWalletClient({ account, chain: coston2, transport: custom((provider ?? injectedProvider()) as never) });

      setSteps(idleSteps());

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
        await loadBalance(account);
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

      const fee = gasless ? parseUnits(relayerFee, decimals) : 0n;

      // Step 1 - approve. Skipping a redundant approval is what makes the
      // gasless path actually gasless on the second order: the allowance is the
      // one thing the user must still sign a transaction for.
      markStep(0, { state: "active" });
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
        markStep(0, { state: "done", tx: approveHash, detail: `Approved ${amount} ${symbol || "escrow"}` });
      } else {
        markStep(0, { state: "done", detail: "Existing allowance already covers this order" });
      }

      // Step 2 - encrypt. Local and instant, and deliberately after the
      // approval: a user who rejects the wallet prompt never has their
      // condition held in memory as plaintext at all.
      markStep(1, { state: "active" });
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
          secondThresholdE18: oco && takeProfit.trim() ? priceToE18(takeProfit) : 0n,
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

      markStep(1, { state: "done", detail: `${encrypted.length / 2 - 1} bytes of ciphertext` });

      // Step 3 - seal.
      markStep(2, {
        state: "active",
        detail: gasless ? "Signing an intent for the sponsor to submit" : "Submitting ciphertext to Coston2",
      });
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
      markStep(2, { state: "done", tx: hash, detail: gasless ? "Sealed by the sponsor" : "Sealed on Coston2" });

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
          takeProfit: oco && takeProfit.trim() ? takeProfit : undefined,
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
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      // Attribute the failure to the stage that was actually running, so a user
      // knows whether to retry everything or only the part that broke.
      setSteps((current) => {
        const running = current.findIndex((s) => s.state === "active");
        if (running < 0) return current;
        return current.map((s, i) => (i === running ? { ...s, state: "failed", error: message } : s));
      });
      say(message, "error");
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

  return (
    <section aria-labelledby="compose-title" id="compose">
      <h2 className="panel-title" id="compose-title">
        Compose an order
      </h2>

      {/* Full page width now that the order list and activity feed live on
          their own routes — the chart is no longer squeezed into a ~25rem
          sidebar column. */}
      {CHART_MODES.has(mode) && (
        <PriceChart
          feedId={FEED_ID}
          feedLabel={FEED_LABEL}
          direction={direction}
          thresholdE18={priceToE18(threshold || "0")}
          takeProfitE18={oco && takeProfit.trim() ? priceToE18(takeProfit) : undefined}
          // A new order has no peak: the first tick establishes it. Drawing a
          // speculative line here would be a fake level.
          peakE18={undefined}
          onThresholdChange={(next) => {
            setThreshold(String(e18ToPrice(next)));
            startCompose();
          }}
        />
      )}

      <form className="compose-layout" onSubmit={seal}>
        <div className="compose-fields">
          <fieldset className="field-group">
            <legend>Position</legend>
            <label className="field">
              <span className="field-label">Escrow{symbol ? ` (${symbol})` : ""}</span>
              <input value={amount} onChange={(e) => { setAmount(e.target.value); startCompose(); }} inputMode="decimal" required />
            </label>
          </fieldset>

          <StrategyCards mode={mode} onSelect={setMode} />

          {mode === "crosschain" && (
            <fieldset className="field-group">
              <legend>Trigger conditions</legend>
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
            </fieldset>
          )}

          {mode === "consensus" && (
            <fieldset className="field-group">
              <legend>Trigger conditions</legend>
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
                  Refuse to act if the two sources differ by more than <span className="field-hint">percent</span>
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
            </fieldset>
          )}

          {mode === "shield" && (
            <fieldset className="field-group">
              <legend>Trigger conditions</legend>
              <div className="field">
                <span className="field-label">Agent to shield</span>
                <AgentWatchlist floorPct={Number(collateralFloor) || 120} selected={agent} onSelect={setAgent} />
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
            </fieldset>
          )}

          {mode === "stealth" && (
            <fieldset className="field-group">
              <legend>Trigger conditions</legend>
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
            </fieldset>
          )}

          {mode === "trailing" && (
            <fieldset className="field-group">
              <legend>Trigger conditions</legend>
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
            </fieldset>
          )}

          {mode === "price" && (
            <fieldset className="field-group">
              <legend>Trigger conditions</legend>

              <div className="field field-secret">
                <span className="field-label">Fires when price</span>
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

              {/* A bracket is a second firing condition on the same escrow, so
                  it is a decision rather than a blank field to overlook.
                  Unchecking clears the value: a hidden take-profit that still
                  sealed into the terms would be a trap. */}
              <label className="oco">
                <input
                  type="checkbox"
                  checked={oco}
                  onChange={(e) => {
                    setOco(e.target.checked);
                    if (!e.target.checked) setTakeProfit("");
                    startCompose();
                  }}
                />
                Add a take-profit leg
                <span className="oco-tag">OCO</span>
              </label>

              {oco && (
                <label className="field field-secret">
                  <span className="field-label">
                    Take profit <span className="field-hint">whichever leg fires first settles</span>
                  </span>
                  <input
                    value={takeProfit}
                    onChange={(e) => setTakeProfit(e.target.value)}
                    inputMode="decimal"
                    placeholder={direction === "below" ? "above the stop" : "below the target"}
                  />
                </label>
              )}
            </fieldset>
          )}

          <fieldset className="field-group">
            <legend>Then</legend>
            <div className="field field-secret">
              <span className="field-label">Action</span>
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
          </fieldset>

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
                  <p className="agent-picked">paid to the sponsor in {symbol || "escrow"}, on top of the amount escrowed</p>
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

          <p className="secret-note">
            Marked fields are encrypted in this browser and never published. The chain stores only ciphertext
            and the escrow.
          </p>
        </div>

        {/* The ticket: what this order costs, what it does if it fires, and the
            one button that submits it. Kept apart from the fields so both are
            legible on their own, the way a real order form separates entry
            from confirmation. */}
        <aside className="compose-ticket">
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

          <FiresAt
            feedId={FEED_ID}
            feedLabel={FEED_LABEL}
            escrowSymbol={symbol || "escrow"}
            outSymbol={symbol || "tokens"}
            mode={mode}
            direction={direction}
            thresholdE18={priceToE18(threshold || "0")}
            takeProfitE18={oco && takeProfit.trim() ? priceToE18(takeProfit) : undefined}
            escrow={Number(amount) || 0}
            minOut={Number(minOut) || 0}
            action={action}
            expirySec={Math.floor(Date.now() / 1000) + Number(days) * 86_400}
            xrplAddress={xrplAddress}
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

          <SealSteps steps={steps} />

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
        </aside>
      </form>
    </section>
  );
}
