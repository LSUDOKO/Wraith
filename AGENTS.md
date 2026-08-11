# Wraith — agent guide

Guidance for AI coding agents (Google Jules, Claude Code, Copilot, etc.) working in this repository.

## What this project is

Wraith is a private conditional-order engine on Flare. The trigger condition of an order is ECIES-encrypted to a TEE (Flare Confidential Compute) and stored on-chain as ciphertext; the enclave decrypts it, evaluates it against live FTSO prices, and returns a signed result only when the condition fires. `WraithOrders.sol` verifies that signature and settles by swap or FXRP redemption.

The one invariant that matters everywhere: **an order's plaintext terms must never exist outside the user's browser or the enclave.** Never log terms, never return them in results, never store them on-chain in the clear.

## Layout

| Path | What | Toolchain |
| --- | --- | --- |
| `contracts/` | `WraithOrders.sol` + Foundry tests | `forge build`, `forge test -vv` |
| `extension/` | TEE-side Go code. `internal/trigger` is the pure decision core; `internal/enclave` is the runtime glue (FTSO reads, decrypt, result building) | `go vet ./... && go test ./... -race` |
| `keeper/` | Permissionless tick/relay loop (Node + viem) | `node --check src/index.js` |
| `frontend/` | Next.js order composer; encrypts terms client-side | `npm run build` |
| `docs/TRUST.md` | Trust assumptions — update it when you change trust-relevant behavior | — |

## Environment setup

```bash
# Contracts (requires Foundry)
cd contracts && forge build

# Extension (Go >= 1.23, no external deps by design)
cd extension && go test ./...

# Keeper / frontend (Node >= 22)
cd keeper && npm install
cd frontend && npm install
```

`contracts/lib/forge-std` is a git submodule — run `git submodule update --init` after cloning.

## Rules

1. **Conventional Commits are load-bearing.** semantic-release derives versions from commit messages on `main`. Use `feat:`, `fix:`, `chore:`, etc. with scopes (`contracts`, `extension`, `keeper`, `frontend`).
2. **OPType/OPCommand strings must match byte-for-byte** between `contracts/src/WraithOrders.sol` (`bytes32("WRAITH")`, `bytes32("EVAL_ORDER")`) and `extension/internal/config/config.go`. A mismatch is the most common cause of `unsupported op type` failures. Never rename one side alone.
3. **`extension/internal/trigger` stays dependency-free and pure.** It is the money-path logic and must be testable without a TEE, chain, or network. Do not import anything beyond the stdlib there.
4. **Do not weaken `execute()` verification** in `WraithOrders.sol`: signature check, actionId replay guard, contractAddr binding, status==1, and order-liveness checks are each there to stop a specific attack (see `docs/TRUST.md`).
5. **Money-path changes need tests.** Contracts: Foundry test per behavior. Extension: table-driven Go tests. A branch that moves funds without a failing-case test is incomplete.
6. **Don't touch** `setExtensionId()` / `_getExtensionId()` in `WraithOrders.sol` — the FCC registry wiring is prescribed by Flare's scaffold and marked DO NOT MODIFY.
7. **Secrets**: `.env*` files are gitignored. Never commit RPC keys, private keys, or indexer DB credentials.

## Verification before claiming done

```bash
cd contracts && forge test -vv        # all green
cd extension && go vet ./... && go test ./... -race
cd frontend && npx tsc --noEmit && npm run build
node --check keeper/src/index.js
```

CI runs the same on every push to `main`.
