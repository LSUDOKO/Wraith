# Roadmap

Working state for the feature build-out. Each entry records what is done, what
is blocked, and why — so work resumes rather than restarts.

Status: `done` · `in progress` · `blocked` · `planned`

---

## Tier 1 — product features

### FAssets Shield (agent-health triggers) — done

Fire an order when a FAssets agent's collateral ratio falls below a private
threshold, or when the agent enters liquidation. Only possible on Flare,
because no other chain has FAssets.

Grounding (verified live on Coston2, not assumed):

- `AssetManager.getAvailableAgentsList(0, 5)` returns 4 live agents.
- `getAgentInfo(address)` returns `AgentInfo.Info`, **40 fields**. The struct
  contains a dynamic `string` at index 5, which makes `cast`'s tuple decoding
  fail; the fixed fields are read positionally from the ABI head instead.
- Field offsets that matter, relative to the head (word 0 is the struct offset):
  | Field | Head index |
  | --- | --- |
  | `status` | 0 |
  | `vaultCollateralRatioBIPS` | 15 |
  | `poolCollateralRatioBIPS` | 19 |
  | `mintedUBA` | 24 |
- `status` enum: `0 NORMAL`, `1 CCB`, `2 LIQUIDATION`, `3 FULL_LIQUIDATION`,
  `4 DESTROYING`.
- Live sample: agent `0x55c81526…` at vaultCR 545.99%, poolCR 806.97%,
  3070.36 FXRP minted.

Ratios are in BIPS (10000 = 100%).

- [x] Verify agent data is readable on Coston2
- [x] `trigger` core: agent-health condition, tested
- [x] `enclave`: read `getAgentInfo` from inside the TEE
- [x] ABI: carry kind + agent + CR threshold in sealed terms
- [x] Frontend: Shield tab with live agent watchlist

Two traps worth remembering:

- `getAgentInfo` returns a struct with a dynamic string, so `cast` and viem's
  tuple decoders both fail on it. Both sides decode positionally instead, and
  the offsets are pinned by a test using **real captured chain bytes** — a
  hand-built fixture would encode the same misreading the parser might make.
- Collateral ratios drift between calls because they are recomputed from live
  FTSO prices. The fixture is frozen bytes for exactly that reason.

### Trailing stop — done

The stop follows price up and never back down, firing a sealed distance below
the running peak.

The statelessness problem is solved by putting the peak on-chain and passing it
into the enclave with each tick. That is sound rather than a compromise: the
peak is derived from public FTSO prices, so publishing it reveals nothing an
observer could not already compute. The **trail distance** is the secret, it
never leaves the ciphertext, and without it the peak says nothing about where
the order exits.

Mechanically the enclave emits an `ACTION_TRACK` result when the peak rises but
the stop has not been hit. Tracking settles nothing and leaves the order live,
so a trailing order can ratchet for as long as it needs to.

- [x] Contract: `peakE18` per order, ratchet-only, `ACTION_TRACK`
- [x] Instruction carries the peak in; result carries the new peak back
- [x] `trigger`: trailing evaluation, peak never falls
- [x] Frontend: Trailing tab

### Stealth TWAP / DCA — done

A large sell in one shot moves the market and announces its size. Stealth
splits it into tranches at times and sizes an observer cannot predict.

Both halves of the "blocked" note turned out to be solvable:

- **Partial fills.** `Order.remaining` replaces all-or-nothing settlement. The
  order closes only when the escrow is exhausted, a chunk of zero still means
  "spend everything" so single-shot orders are untouched, and an oversized
  chunk is clamped rather than rejected — overdrawing must be impossible even
  if the schedule is computed against a stale view.
- **Statelessness.** The schedule is never stored, it is *derived*:
  `sha256(seed ‖ index)` gives the jitter for both timing and size, so the
  enclave recomputes an identical schedule on every tick and a restart cannot
  lose its place, double-spend, or stall. Progress is read from the contract's
  `remaining` rather than from memory.

The seed is the secret. Chunk sizes only ever shrink under jitter, never grow,
so the schedule cannot overdraw however the randomness falls.

- [x] Contract: `remaining`, partial fills, clamped chunks, refund on cancel
- [x] `trigger`: derived schedule, determinism and bounds tested
- [x] ABI: seed, chunks and window sealed; chunk amount in the result
- [x] Frontend: Stealth tab with a fresh per-order seed

### Gasless via paymaster — done

A user who minted FXRP holds no FLR, so they cannot pay for the transaction that
would escrow it: the asset they want to protect is the one asset they cannot act
on.

ERC-4337 was the wrong tool here. It would mean an EntryPoint, a bundler and an
account abstraction the user does not otherwise need, to solve a problem that is
one signature wide. Instead the user signs an EIP-712 intent — free, no chain
interaction — and any relayer submits it, reimbursing itself **in the escrowed
token** rather than in native gas. Settlement was already permissionless, so the
user never needs FLR at any point in an order's life.

The relayer is trusted with nothing. Every field is covered by the signature, so
it cannot retarget the escrow, substitute different sealed terms, or raise its
own fee; the worst it can do is refuse to submit, and anyone else can then take
the same intent. A per-signer nonce makes each intent single-use, and it is
consumed before any transfer so a token with a callback cannot re-enter and
spend it twice.

One honest limit: the ERC-20 allowance still needs one funded transaction from
the user the first time, unless the token supports EIP-2612. The UI therefore
takes a standing allowance on the gasless path and skips the approval entirely
when one already covers the order.

- [x] Contract: `CreateIntent`, `createOrderFor`, EIP-712 domain, nonces
- [x] Contract tests: forged signature, replay, expiry, inflated fee
- [x] Relayer route that simulates before it spends
- [x] Frontend: gasless toggle, allowance reuse

## Tier 2 — deep Flare integration

### FDC cross-chain triggers — done

FDC is **not callable from inside the enclave** (`docs/TRUST.md` §7), so the
proof arrives by a different route: the keeper fetches it, `tickAttested`
verifies it on-chain against a finalized attestation round, and only the
verified reading crosses into the enclave. By the time the extension sees it,
`verified` reflects a Merkle check rather than the keeper's word — which is what
lets the enclave refuse an unverified attestation outright instead of having to
trust whoever relayed it.

What this publishes is the *observed* fact: that some XRPL payment landed. XRPL
already published that. What it does not publish is the amount that fires the
order, which stays in the ciphertext.

The watched address does not appear on-chain either. It travels as the FDC
standard address hash, in the sealed terms and in the tick alike, so the two
sides can match without either publishing the account. The hash is pinned to
Flare's own published XRPL vector in a test — matching a documented value proves
it is the hash FDC computes, not merely one both halves of this repo agree on.

The instruction grew four slots for this, and the enclave distinguishes "no proof
offered" from "a proof was offered and the chain rejected it" by whether the
message carries them at all. Only the second is evidence of a hostile keeper, so
collapsing them into a zero-valued attestation would have thrown the signal away.

- [x] Contract: `IPayment` proof verified on-chain, drops scaled to 1e18
- [x] Instruction carries the verified reading; enclave refuses a plain tick
- [x] `trigger`: source match, verification and freshness checked before threshold
- [x] Frontend: Cross-chain tab, address hashed in-browser

### Multi-oracle consensus — done

Privacy stops someone aiming at a trigger they cannot see. It does not stop them
walking a single price feed until *something* fires. A consensus order closes
that: it settles only when FTSO **and** an FDC-attested off-chain price both
cross the threshold. Forcing two independent sources in the same direction at
the same moment is a different and much harder problem than nudging one.

A deviation tolerance sits on top, and deliberately does the opposite of firing:
when the two sources disagree beyond it, the order refuses to act at all. A wide
gap between two honest sources means one of them is wrong, and acting on either
reading is worse than waiting.

Rounds take 90–180s, so this cannot be a per-tick request. The keeper requests
one attestation and reuses it across every order ticked in a ten-minute window —
the same reading either way, so per-order requests would cost more and assure
nothing extra. An attested tick is a strict superset of a plain one, so orders
that need no second oracle ignore the attached reading.

The tolerance shares a wire slot with the trailing stop's trail distance. The
kinds are mutually exclusive, so the two never coexist in one order, and
widening the sealed layout for a second basis-point field would have cost every
order the bytes for nothing.

- [x] Contract: `tickAttestedWeb2`, `(source, valueE18, timestamp)` decode
- [x] `trigger`: both-cross agreement, deviation circuit breaker, staleness
- [x] Keeper: request, wait for finalization, fetch proof, reuse within a window
- [x] Frontend: Consensus tab

## Tier 3 — stretch

- Strategy marketplace
- Portfolio command centre
- B2B SDK

---

## Shipped

- Private stop-loss / take-profit with TEE evaluation
- Gasless order creation via signed intents and a sponsored relay
- FDC cross-chain triggers and multi-oracle consensus
- OCO brackets (one escrow, two legs, first to fire settles)
- Registry-backed signer verification, replay guards, expiry, cancellation
- Owner-only local recall of a sealed condition
- Live system status from the FCC registry
- Browser notifications, Telegram alerts (operator-level)
- WalletConnect, Sentry + PostHog with term-key scrubbing
