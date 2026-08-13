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

### Stealth TWAP / DCA — blocked

Same statelessness problem plus a contract change: `WraithOrders` marks an order
`executed` on first settlement, so partial fills are impossible today. Needs
`remainingAmount` and a per-chunk schedule commitment.

### Gasless via paymaster — planned

Users who minted FXRP hold no FLR for gas. Needs either ERC-4337 plumbing or a
Wraith-sponsored relay that reclaims cost from the escrow.

## Tier 2 — deep Flare integration

### FDC cross-chain triggers — planned

FDC is **not callable from inside the enclave** (`docs/TRUST.md` §7), so the
Merkle proof must arrive via the on-chain instruction. This leaks the observed
data but never the threshold, which is the property that matters.

### Multi-oracle consensus — planned

Requires FDC Web2Json attestations alongside FTSO. Attestation rounds take
90–180s, so this cannot be a per-tick check; it needs a slower cadence.

## Tier 3 — stretch

- Strategy marketplace
- Portfolio command centre
- B2B SDK

---

## Shipped

- Private stop-loss / take-profit with TEE evaluation
- OCO brackets (one escrow, two legs, first to fire settles)
- Registry-backed signer verification, replay guards, expiry, cancellation
- Owner-only local recall of a sealed condition
- Live system status from the FCC registry
- Browser notifications, Telegram alerts (operator-level)
- WalletConnect, Sentry + PostHog with term-key scrubbing
