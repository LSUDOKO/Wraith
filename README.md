<div align="center">
 <img width="260" alt="Wraith" src="https://github.com/user-attachments/assets/fce30e5b-cf92-4f3c-83ae-ae8bf4a15261" />

# Wraith

**Conditional orders that never announce themselves.**

Encrypted conditions in, attested execution out.

[![CI](https://github.com/LSUDOKO/Wraith/actions/workflows/ci.yml/badge.svg)](https://github.com/LSUDOKO/Wraith/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/LSUDOKO/Wraith?display_name=tag&sort=semver)](https://github.com/LSUDOKO/Wraith/releases)
[![Coston2](https://img.shields.io/badge/Coston2-deployed-ff9e3d)](https://coston2.testnet.flarescan.com/address/0x77B843De799557370c5c5a438cd1Fb23E3a79103)
[![Tests](https://img.shields.io/badge/tests-81%20passing-2ea043)](#verification)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[**Live app**](https://wraith-jet.vercel.app) · [Trust model](docs/TRUST.md) · [Deploy runbook](docs/DEPLOY.md) · [Known issues](docs/KNOWN-ISSUES.md)

</div>

---

## The problem

Every onchain automation protocol today — Gelato, Chainlink Automation, onchain limit-order books, every DeFi stop-loss — publishes the **trigger condition in the clear**. A standing order sits onchain for hours or days announcing exactly what you will do and exactly when.

The best-documented consequence is **stop-loss hunting**: because your stop price is public, price gets deliberately pushed to it. A resting stop is a public commitment to sell at a known level, and pushing price into a visible cluster of stops is profitable *precisely because* the cluster is visible.

Traders have two defences today. Keep the stop on a centralised exchange and accept custody risk, or keep it in your head and accept being asleep when it matters. Neither is a good trade.

Wraith is the third option.

## How it works

Your condition is encrypted to a TEE's public key **in your own browser** and stored onchain as ciphertext. A Flare Compute Extension running inside a Trusted Execution Environment is the only party that can read it. It evaluates the condition against live FTSO prices and emits a **signed result only when the condition fires**. A Flare smart contract verifies that signature and settles.

Nobody — not a searcher, not an indexer, not the keeper that pokes the system — can see what you are waiting for.

```
 ┌── your browser ──────────┐
 │  condition encrypted     │   plaintext exists only here, and in the enclave
 └────────────┬─────────────┘
              ▼
      createOrder(bytes)          ← chain stores ciphertext + escrow, nothing else
              │
   keeper ──► tick(orderId)       ← permissionless; forwards bytes it cannot read
              ▼
 ┌── TEE enclave ───────────┐
 │  decrypt → read FTSO     │   reads the oracle itself, so the keeper cannot lie
 │  → evaluate condition    │
 └────────────┬─────────────┘
              │ fired? sign a settlement.  not fired? indistinguishable no-op.
              ▼
      execute(result, sig)        ← registry-checked signer, replay guard, then settle
```

The no-op and the fired path are deliberately **indistinguishable by status**, so an observer watching tick traffic cannot infer how close an order is to its trigger. Tests enforce this.

## Features

| | |
| --- | --- |
| **Private stop-loss / take-profit** | Trigger price is never published, so it cannot be hunted |
| **OCO brackets** | Stop and take-profit share one escrow; whichever fires first settles, the other dies with it |
| **Trailing stop** | The stop follows price up and never back down; the peak is public, the trail distance is not |
| **Stealth TWAP** | A large order splits into tranches at times and sizes derived from a sealed seed |
| **FAssets Shield** | Escape an FAssets agent whose collateral is falling, on a threshold nobody can see |
| **Cross-chain triggers** | Fire on an FDC-attested XRPL payment; the watched address travels only as its FDC hash |
| **Multi-oracle consensus** | Settles only when FTSO *and* an attested off-chain price agree — one feed alone cannot move a stop |
| **Gasless orders** | Sign an intent, a sponsor pays the gas and takes its fee in the escrowed token |
| **Cross-chain settlement** | Swap FXRP, or redeem it to native XRP on the XRPL |
| **Owner-only recall** | Read your own condition back, from a device-local copy — the chain still holds only ciphertext |
| **Live system status** | Enclave key and TEE machine count read straight from the FCC registry |
| **Browser notifications** | Alerts when your order executes or is cancelled |
| **Telegram alerts** | Subscribe your wallet in-app; the keeper messages you when your order fires, tab open or not |
| **Wallet support** | Injected wallets plus WalletConnect for mobile and hardware |

## Deployment

| | |
| --- | --- |
| **Network** | Flare Coston2 (chain 114) |
| **WraithOrders** | [`0xaD53864967e6Aa0090ee6609F481E7F09Ce753B3`](https://coston2.testnet.flarescan.com/address/0xaD53864967e6Aa0090ee6609F481E7F09Ce753B3) |
| **FCC extension ID** | `0x102b5` (66229) |
| **FdcVerification** | `0x906507E0B64bcD494Db73bd0459d1C667e14B933` |
| **FCC registry** | `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` — FlareTeeManager diamond |
| **FtsoV2** | `0x3d893C53D9e8056135C26C8c638B76C8b60Df726` |
| **AssetManagerFXRP** | `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA` |
| **FXRP** | `0x0b6A3645c240605887a5532109323A3E12273dc7` |
| **Router** | `0x8D29b61C41CF318d15d031BE2928F79630e068e6` — BlazeSwap |

Two details worth stating, because both were verified rather than assumed:

- `AssetManagerFXRP` was resolved live from the `FlareContractRegistry`, and its `fAsset()` returns exactly the FXRP address above. The two agree independently, so neither is a stale copy from a doc.
- The contract's `OP_TYPE_WRAITH` and `OP_COMMAND_EVAL_ORDER` decode onchain to `WRAITH` and `EVAL_ORDER`, byte-identical to `extension/internal/config/config.go`. That match is what FCC instruction routing depends on, and it is checked against the live contract.

Full sequence: [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Flare integration

| Protocol | Role |
| --- | --- |
| **FCC** (Confidential Compute) | Runs the private condition evaluation inside a TEE. An order's plaintext exists nowhere else. |
| **FTSO** | Price triggers, read from block-latency feeds *inside the enclave* — which puts the keeper outside the trust path entirely. |
| **FDC** | Cross-chain triggers via the XRPL `Payment` attestation, and `Web2Json` as the second oracle in a consensus order. Verified on-chain before the reading reaches the enclave, because FDC is a system application the enclave cannot call. |
| **FAssets / FXRP** | Settlement. A fired trigger swaps FXRP or redeems it to native XRP on the XRPL. |

`WraithOrders` is its own FCC `InstructionSender`, so the contract that holds escrow is the same one that dispatches instructions and verifies results.

## What Wraith does *not* claim

Wraith hides **standing intent**. It does not hide the execution transaction — once a trigger fires, the resulting trade is an ordinary public transaction, as exposed to execution-moment MEV as any other. Anyone claiming a TEE makes a trade MEV-proof is overselling.

The narrower claim is the one that holds: **the condition was never public, so it could never be hunted.**

Every assumption behind that is written down in [`docs/TRUST.md`](docs/TRUST.md) — onchain ciphertext exposure, `SIMULATED_TEE` on testnet, what the registry does and does not guarantee, and the fact that a keeper can censor but cannot lie.

## Security model

`execute()` accepts a result only if all of the following hold:

| Check | Prevents |
| --- | --- |
| Recovered signer is an **active TEE** for this extension, per `getActiveTeeMachines` | Forged results |
| `actionId` has not been consumed | Replaying one signed result to execute an order twice |
| `contractAddr` equals `address(this)` | Replaying a result against a different Wraith deployment |
| `status == 1` | Relaying a failed TEE result |
| Order is live — not executed, cancelled, or expired | Settling a dead order |

The signed payload is `keccak256(abi.encode(TEE_ACTION_RESULT_PREFIX, block.chainid, ActionResult.Hash()))` under the EIP-191 prefix. Including `block.chainid` is what stops a result signed on one chain being replayed on another.

**Signer authority comes from the registry, not from the contract owner.** There is no owner-controlled allowlist — a test asserts that even the owner cannot authorise a signer of their choosing, and retiring a machine in the registry revokes its ability to settle immediately.

## Repository

| Path | What |
| --- | --- |
| [`contracts/`](contracts) | `WraithOrders.sol`, Foundry tests, Coston2 deploy script |
| [`extension/`](extension) | Flare Compute Extension (Go): pure trigger core + enclave runtime |
| [`keeper/`](keeper) | Permissionless tick-and-relay loop |
| [`frontend/`](frontend) | Next.js app — seals conditions client-side |
| [`docs/TRUST.md`](docs/TRUST.md) | Trust assumptions, stated plainly |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | End-to-end Coston2 runbook |
| [`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md) | Live-stack findings and operational traps |
| [`AGENTS.md`](AGENTS.md) | Repo guide for coding agents |

## Quick start

```bash
git clone --recurse-submodules https://github.com/LSUDOKO/Wraith.git
cd Wraith

cd contracts  && forge test -vv                        # 15 tests
cd ../extension && go vet ./... && go test ./... -race  # 32 tests
cd ../keeper    && npm ci && npm test                   # 16 tests
cd ../frontend  && npm ci && npm test && npm run dev    # 18 tests
```

Copy `frontend/.env.example` to `.env.local` — the deployed address is already filled in. Connect MetaMask on Coston2 and fund it from the [faucet](https://faucet.flare.network/coston2).

Routes: `/` explains the product, `/app` is the order composer and live order book.

### Using the app

1. Open [the app](https://wraith-jet.vercel.app/app) and connect a wallet on Coston2
2. Click **Wrap 5 C2FLR** to fund escrow from faucet funds
3. Set an escrow amount, a trigger price, optionally a take-profit, and an expiry
4. **Seal and submit** — the condition is encrypted in your browser, then two wallet prompts
5. Your order appears with its condition shown as **unreadable ciphertext**. Check the block explorer: the trigger price genuinely is not there
6. Cancel any time to reclaim the escrow

## Verification

160 tests across four languages, all run in CI on every push:

| Suite | Count | Covers |
| --- | --- | --- |
| `contracts` | 36 | Escrow, settlement, forged signatures, replay, cross-deployment reuse, expiry, cancellation, rate limiting, partial fills, peak tracking, FDC proof rejection, gasless intent forgery and replay |
| `extension` | 80 | Trigger evaluation and boundaries for all six kinds, decimal normalization, stale-price and stale-attestation refusal, oracle disagreement, ABI round-trips, no-op indistinguishability |
| `keeper` | 24 | Proxy response handling, relay decisions, notification privacy, attestation encoding and reuse windows |
| `frontend` | 20 | Price parsing, cipher rendering, analytics scrubbing, FDC address hashing |

Four properties are enforced by test rather than convention:

- **The settlement payload carries no trace of the threshold or direction.** A test greps the encoded result for the secret bytes.
- **Analytics can never carry order terms.** Term-bearing keys are dropped at any nesting depth, because a trigger price is a plain decimal that no value-level pattern can distinguish from a legitimate metric.
- **The contract owner cannot authorize a signer of their choosing.** Settlement authority comes from the TEE machine registry, and a test asserts the owner has no way to add to it.
- **The FDC address hash matches Flare's published vector.** Hashing the documented XRPL example proves both halves compute the hash FDC computes, rather than agreeing on the same mistake.

## Status

Coston2 testnet only. Flare Confidential Compute is itself pre-release. **Do not put real funds behind this.**

The contract, dispatch, registration and enclave routing are verified working end to end — an instruction reaches the enclave and routes as `WRAITH`/`EVAL_ORDER`. Current operational limitations are tracked honestly in [`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md).

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup, the Conventional Commits that drive releases, and the invariants that are not style preferences.

## License

[Apache-2.0](LICENSE)
