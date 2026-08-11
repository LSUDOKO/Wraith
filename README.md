# Wraith

[![CI](https://github.com/LSUDOKO/Wraith/actions/workflows/ci.yml/badge.svg)](https://github.com/LSUDOKO/Wraith/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/LSUDOKO/Wraith?display_name=tag&sort=semver)](https://github.com/LSUDOKO/Wraith/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![semantic-release](https://img.shields.io/badge/semantic--release-conventional_commits-e10079)](https://semantic-release.gitbook.io/semantic-release)

**Private cross-chain trigger engine on Flare.** Encrypted conditions in, attested execution out.

Built for the Flare Summer Signal hackathon — submitted to **Bounty 1 (Interoperable Asset Products)** and **Bounty 2 (Confidential Compute Apps)**.

---

## The problem

Every onchain automation protocol today — Gelato, Chainlink Automation, onchain limit-order books, DeFi stop-losses — publishes the **trigger condition in the clear**. A standing order sits onchain for hours or days announcing exactly what you will do and exactly when.

The best-documented consequence is **stop-loss hunting**. Because your stop price is public, price gets deliberately pushed to it. This is why serious traders keep stops off-exchange or mental: today the only way to hide your trigger is to hand custody to someone else, or to not automate at all.

Wraith is the third option.

## How it works

Your trigger condition is encrypted to a TEE's public key and stored onchain as ciphertext. A Flare Compute Extension running inside a Trusted Execution Environment is the only party that can read it. The TEE evaluates the condition against live FTSO prices (and, for cross-chain triggers, FDC-attested external-chain events), and emits a signed result **only when the condition fires**. A Flare smart contract verifies that signature and settles.

Nobody — not a searcher, not an indexer, not the keeper that pokes the system — can see what you are waiting for.

```
User → encrypt order to TEE pubkey → WraithOrders.createOrder(bytes)
                                            ↓ ciphertext onchain
Keeper → WraithOrders.tick(orderId) → TeeExtensionRegistry.sendInstructions()
                                            ↓ relayed
                        ext-proxy → TEE → extension POST /action
                                            ↓
              decrypt in-enclave → read FTSO → evaluate threshold
                                            ↓ triggered
                        TEE-signed ActionResult → polled from proxy
                                            ↓
Anyone → WraithOrders.execute(...) → ecrecover == teeAddress → swap / redeem FXRP
```

## Flare integration

| Protocol | Role |
| --- | --- |
| **FCC** (Confidential Compute) | Runs the private condition evaluation inside a TEE. The order plaintext exists nowhere else. |
| **FTSO** | Price triggers — block-latency feeds read from inside the enclave, so the keeper is not in the trust path. |
| **FDC** | Cross-chain triggers: XRPL payment attestation (`Payment`), and Web2 JSON attestation for off-chain data. |
| **FAssets / FXRP** | Settlement. A fired trigger can swap FXRP or redeem it to native XRP on the XRPL, closing the cross-chain loop. |

## What Wraith does *not* claim

Wraith hides **standing intent**. It does not hide the execution transaction — that lands onchain and is as visible as any trade. Execution-moment MEV is out of scope. The value is that the condition was never public, so it could never be hunted.

Full trust assumptions are in [`docs/TRUST.md`](docs/TRUST.md).

## Repository layout

| Path | What |
| --- | --- |
| `contracts/` | `WraithOrders.sol`, Foundry tests, and the Coston2 deploy script |
| `extension/` | Flare Compute Extension (Go): pure trigger core + enclave runtime (FTSO reads, decrypt, ABI codecs) |
| `keeper/` | Minimal loop that ticks live orders and relays signed results |
| `frontend/` | Order creation UI (Next.js + viem) — seals conditions client-side |
| `docs/DEPLOY.md` | End-to-end Coston2 deployment runbook |
| `docs/TRUST.md` | Trust assumptions, stated plainly |
| `AGENTS.md` | Repo guide for coding agents (Google Jules, Claude Code, …) |

## Status

Coston2 testnet. Flare Confidential Compute is itself "in the final stages of development and is not yet a fully public production system", so this runs against Coston2 with `SIMULATED_TEE=true`.

## Development

```bash
npm install
npm test              # forge tests + go tests
```

Releases are automated with [semantic-release](https://semantic-release.gitbook.io/semantic-release) — commit messages follow [Conventional Commits](https://www.conventionalcommits.org/), and merging to `main` cuts the version, changelog, and GitHub release. Dependencies are kept current by Dependabot.

## License

Apache-2.0
