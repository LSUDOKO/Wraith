# Wraith TEE extension

The enclave-side half of Wraith. This is where an order's plaintext briefly exists — and nowhere else.

## What lives here

| Package | Role |
| --- | --- |
| `internal/trigger` | Pure decision logic: given decrypted terms and an FTSO reading, has the condition fired? Fully unit-tested, zero dependencies. |
| `internal/config` | `OPType` / `OPCommand` identifiers. **Must match `contracts/src/WraithOrders.sol` byte for byte.** |

`internal/trigger` is deliberately dependency-free. The decision that moves someone's money is the part worth testing hardest, and keeping it pure means it is testable without a TEE, a chain, or a network.

```bash
go test ./... -race
```

## Grafting onto the Flare scaffold

The runnable TEE service is the Flare scaffold — it carries the `tee-node` harness, the `ext-proxy`, the Docker compose stack and the deploy scripts:

```bash
git clone https://github.com/flare-foundation/fce-extension-scaffold.git
```

Wire Wraith into it by customizing the six files the FCC guide names:

| Scaffold file | Change |
| --- | --- |
| `internal/config/config.go` | Take `OPTypeWraith` / `OPCommandEvalOrder` from this repo's config |
| `pkg/types/types.go` | Request/response structs for `EVAL_ORDER` |
| `internal/extension/extension.go` | Route `WRAITH` → decrypt → `trigger.Evaluate` → build result |
| `pkg/types/register.go` | Decoders for the types server |
| `contracts/InstructionSender.sol` | Replaced by `WraithOrders.sol`, which is its own instruction sender |
| `tools/cmd/run-test/main.go` | End-to-end assertions |

The `OPType` and `OPCommand` strings must be identical in Solidity and Go. A mismatch is the documented most-common cause of `unsupported op type` / `unsupported op command`.

Do not use an `OPType` beginning with `F_` — that prefix is reserved for Flare system operations.

## Handler shape

```
POST /action  (WRAITH / EVAL_ORDER)
  │
  ├─ decode instruction → (orderId, contractAddr, ciphertext)
  ├─ decrypt ciphertext via the TEE node /decrypt endpoint on SIGN_PORT
  ├─ read the FTSO feed over RPC, from inside the enclave
  ├─ trigger.Evaluate(terms, observation, now)
  │
  ├─ not fired → status 1, no-op result   (indistinguishable from any other tick)
  └─ fired     → status 1, ABI-encoded result for WraithOrders.execute()
```

Reading FTSO from inside the enclave rather than accepting a price from the keeper keeps the keeper out of the trust path: it can withhold ticks, but it cannot lie about the price.

## Two constraints worth knowing

**State is volatile.** The enclave has no sealed storage, so nothing here may be treated as durable. The on-chain ciphertext is the canonical copy of an order and is re-decrypted on every tick.

**FDC is not callable from inside the enclave.** The TEE-based FDC is a Flare *system* application with no developer SDK surface. Cross-chain triggers therefore take their attestation proof from the instruction payload rather than fetching it here. Only the *observed data* is public that way — the threshold it is compared against stays secret, which is the property that matters.
