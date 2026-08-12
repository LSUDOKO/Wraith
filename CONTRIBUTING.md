# Contributing

## Setup

```bash
git clone --recurse-submodules https://github.com/LSUDOKO/Wraith.git
cd Wraith
```

`contracts/lib/forge-std` is a submodule — if you already cloned without it, run `git submodule update --init`.

Requirements: Foundry, Go ≥ 1.25, Node ≥ 22.

## Verify before you push

CI runs all four. Run them locally first:

```bash
cd contracts && forge test -vv
cd extension && go vet ./... && go test ./... -race
cd keeper    && npm ci && npm test
cd frontend  && npm ci && npx tsc --noEmit && npm run build
```

## Commit messages

Conventional Commits are load-bearing: `semantic-release` derives the version, changelog, and GitHub release from them on every merge to `main`. Get the type wrong and the release is wrong.

```
feat(contracts): add order expiry sweep
fix(keeper): stop re-ticking a cancelled order
docs: clarify the FDC trust boundary
chore(deps): bump viem
```

Scopes: `contracts`, `extension`, `keeper`, `frontend`, or omit for repo-wide changes.

- `feat` → minor version
- `fix` → patch version
- `feat!` or a `BREAKING CHANGE:` footer → major version
- `docs`, `chore`, `test`, `ci`, `refactor` → no release

## Rules that are not style preferences

These exist because breaking them breaks the product. `AGENTS.md` carries the same list for AI agents.

1. **An order's plaintext terms must never exist outside the user's browser or the enclave.** Never log them, never return them in a result, never put them on-chain in the clear. `extension/internal/enclave/enclave_test.go` asserts the settlement payload contains no trace of the threshold — keep that true.

2. **`OPType` and `OPCommand` strings must match byte-for-byte** between `contracts/src/WraithOrders.sol` and `extension/internal/config/config.go`. A mismatch produces `unsupported op type` at runtime, not at compile time. Never rename one side alone.

3. **`extension/internal/trigger` stays dependency-free.** It is the logic that decides whether to move someone's money, and it must be testable without a TEE, a chain, or a network.

4. **Do not weaken `execute()` verification.** The signature check, `actionId` replay guard, `contractAddr` binding, `status == 1` check, and order-liveness checks each stop a specific attack. `docs/TRUST.md` explains which.

5. **Money-path changes need a failing-case test**, not just a happy-path one.

6. **Do not touch `setExtensionId()` / `_getExtensionId()`.** The FCC registry wiring is prescribed by Flare's scaffold and marked DO NOT MODIFY.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
