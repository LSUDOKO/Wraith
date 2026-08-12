# Security policy

## Status

Wraith is pre-production. It runs on **Coston2 testnet only**, against Flare Confidential Compute, which Flare itself describes as "in the final stages of development and not yet a fully public production system."

**Do not put real funds behind this.**

## Known limitations

These are documented in full in [docs/TRUST.md](docs/TRUST.md) and are not vulnerabilities — they are the current design's stated boundaries:

- Encrypted orders are stored on-chain as ciphertext, which is a durable exposure. Flare's own docs advise off-chain secret delivery for production.
- The demo runs with `SIMULATED_TEE=true`, so hardware attestation is not exercised.
- TEE signers are an owner-curated allowlist, because `ITeeMachineRegistry` offers no membership query.
- Wraith hides standing intent, not execution. Execution-moment MEV is explicitly out of scope.

## Reporting a vulnerability

Report privately through [GitHub's private vulnerability reporting](https://github.com/LSUDOKO/Wraith/security/advisories/new). Do not open a public issue.

Please include what an attacker gains, the steps to reproduce, and the affected component (`contracts`, `extension`, `keeper`, or `frontend`).

Findings in the money path are the most valuable: anything that lets a result be forged or replayed, lets an order settle on terms it did not authorize, or leaks an order's condition outside the enclave.
