<div align="center">

# Wraith

**Conditional orders that never announce themselves.**

Encrypted conditions in, attested execution out.

[![CI](https://github.com/LSUDOKO/Wraith/actions/workflows/ci.yml/badge.svg)](https://github.com/LSUDOKO/Wraith/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/LSUDOKO/Wraith?display_name=tag&sort=semver)](https://github.com/LSUDOKO/Wraith/releases)
[![Coston2](https://img.shields.io/badge/Coston2-deployed-ff9e3d)](https://coston2.testnet.flarescan.com/address/0x9271f82Dc7CD2117ac7DdA630FeE59d400A6ec62)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

</div>

---

## The problem

Every onchain automation protocol today — Gelato, Chainlink Automation, onchain limit-order books, every DeFi stop-loss — publishes the **trigger condition in the clear**. A standing order sits onchain for hours or days announcing exactly what you will do and exactly when.

The best-documented consequence is **stop-loss hunting**: because your stop price is public, price gets deliberately pushed to it. This is why serious traders keep stops off-exchange or mental — they trade custody risk for privacy, because today there is no third option.

Wraith is the third option.

## How it works

Your condition is encrypted to a TEE's public key in your own browser and stored onchain as ciphertext. A Flare Compute Extension running inside a Trusted Execution Environment is the only party that can read it. It evaluates the condition against live FTSO prices and emits a **signed result only when the condition fires**. A Flare smart contract verifies that signature and settles.

Nobody — not a searcher, not an indexer, not the keeper that pokes the system — can see what you are waiting for.

```
 ┌── your browser ──────────┐
 │  condition encrypted     │   plaintext exists only here, and in the enclave
 └────────────┬─────────────┘
              ▼
      createOrder(bytes)          ← chain stores ciphertext + escrow, nothing else
              │
   keeper ──► tick(orderId)       ← permissionless; the keeper forwards bytes it cannot read
              ▼
 ┌── TEE enclave ───────────┐
 │  decrypt → read FTSO     │   reads the oracle itself, so the keeper cannot lie
 │  → evaluate condition    │
 └────────────┬─────────────┘
              │ fired? sign a settlement.  not fired? indistinguishable no-op.
              ▼
      execute(result, sig)        ← ecrecover, replay guard, then swap or redeem FXRP
```

## Deployment

| | |
| --- | --- |
| **Network** | Flare Coston2 (chain 114) |
| **WraithOrders** | [`0x9271f82Dc7CD2117ac7DdA630FeE59d400A6ec62`](https://coston2.testnet.flarescan.com/address/0x9271f82Dc7CD2117ac7DdA630FeE59d400A6ec62) |
| **Deploy tx** | [`0xb52964ee…15109b5b`](https://coston2.testnet.flarescan.com/tx/0xb52964ee70f01c67ffa07b64d6b2b9f9739dc24e4ab0df0a3f81ecfb15109b5b) |
| **FCC registry** | `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` (FlareTeeManager diamond) |
| **FtsoV2** | `0x3d893C53D9e8056135C26C8c638B76C8b60Df726` |
| **AssetManagerFXRP** | `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA` (wired — redeem path live) |
| **FXRP** | `0x0b6A3645c240605887a5532109323A3E12273dc7` |
| **Router** | `0x8D29b61C41CF318d15d031BE2928F79630e068e6` (BlazeSwap — swap path live) |

`AssetManagerFXRP` was resolved live from the `FlareContractRegistry`, and its `fAsset()` returns exactly the FXRP address above — the two agree, so neither is a stale copy from a doc.

The contract's `OP_TYPE_WRAITH` and `OP_COMMAND_EVAL_ORDER` decode onchain to `WRAITH` and `EVAL_ORDER`, matching `extension/internal/config/config.go` byte for byte — the invariant that FCC instruction routing depends on, verified against the live contract rather than assumed.

Full runbook: [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Flare integration

| Protocol | Role |
| --- | --- |
| **FCC** (Confidential Compute) | Runs the private condition evaluation inside a TEE. The order's plaintext exists nowhere else. |
| **FTSO** | Price triggers, read from block-latency feeds *inside the enclave* — so the keeper is outside the trust path. |
| **FDC** | Cross-chain triggers: XRPL `Payment` attestation, and Web2 JSON attestation for off-chain data. |
| **FAssets / FXRP** | Settlement. A fired trigger swaps FXRP or redeems it to native XRP on the XRPL, closing the cross-chain loop. |

## What Wraith does *not* claim

Wraith hides **standing intent**. It does not hide the execution transaction — once a trigger fires, the resulting trade is an ordinary public transaction, as exposed to execution-moment MEV as any other. Anyone claiming a TEE makes a trade MEV-proof is overselling.

The value is narrower and defensible: the condition was never public, so it could never be hunted.

Every trust assumption — onchain ciphertext exposure, `SIMULATED_TEE`, the TEE-signer allowlist, PMW and in-enclave FDC being unavailable to third-party extensions — is written down in [`docs/TRUST.md`](docs/TRUST.md).

## Repository

| Path | What |
| --- | --- |
| [`contracts/`](contracts) | `WraithOrders.sol`, Foundry tests, Coston2 deploy script |
| [`extension/`](extension) | Flare Compute Extension (Go): pure trigger core + enclave runtime |
| [`keeper/`](keeper) | Permissionless tick-and-relay loop |
| [`frontend/`](frontend) | Next.js composer — seals conditions client-side |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | End-to-end Coston2 runbook |
| [`docs/TRUST.md`](docs/TRUST.md) | Trust assumptions |
| [`AGENTS.md`](AGENTS.md) | Repo guide for coding agents |

## Quick start

```bash
git clone --recurse-submodules https://github.com/LSUDOKO/Wraith.git
cd Wraith

cd contracts && forge test -vv                       # 12 tests
cd ../extension && go vet ./... && go test ./... -race
cd ../keeper && npm ci && npm test                   # 9 tests
cd ../frontend && npm ci && npm test && npm run dev   # 11 tests
```

Point the frontend at the live contract by copying `frontend/.env.example` to `.env.local` — the deployed address is already filled in. Connect MetaMask on Coston2 and fund it from the [faucet](https://faucet.flare.network/coston2).

Two routes: `/` explains the product, `/app` is the order composer and live order book.

## Security

Coston2 testnet only. Flare Confidential Compute is itself pre-release. **Do not put real funds behind this.** Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup, the Conventional Commits that drive releases, and the invariants that are not style preferences.

## License

[Apache-2.0](LICENSE)
