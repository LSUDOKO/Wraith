## What and why

<!-- What changes, and what problem it solves. -->

## Verification

<!-- Paste the output, do not just tick the box. -->

- [ ] `cd contracts && forge test -vv`
- [ ] `cd extension && go vet ./... && go test ./... -race`
- [ ] `cd keeper && npm test`
- [ ] `cd frontend && npx tsc --noEmit && npm run build`

## Invariants

Confirm any that this PR touches (see `CONTRIBUTING.md`):

- [ ] Order plaintext still never leaves the browser or the enclave
- [ ] `OPType`/`OPCommand` strings still match between Solidity and Go
- [ ] `extension/internal/trigger` still has no dependencies
- [ ] `execute()` verification is unchanged or strengthened, never weakened
- [ ] Money-path changes include a failing-case test

## Commit messages

- [ ] Conventional Commits — `semantic-release` derives the version from these
