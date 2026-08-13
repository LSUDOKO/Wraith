# Known issues

## 1. The frontend's ECIES scheme is incompatible with the enclave — BLOCKING

**Status: confirmed against the live Coston2 stack. This must be fixed before the app can seal a working order.**

`frontend/lib/wraith.ts` encrypts order terms with the npm package `eciesjs`. The enclave decrypts with `github.com/ethereum/go-ethereum/crypto/ecies`, via `tee-node`'s `Node.Decrypt` → `pkg/utils/crypto.go`.

These are different schemes and do not interoperate:

| | Frontend (`eciesjs`) | Enclave (go-ethereum `ecies`) |
| --- | --- | --- |
| KDF | HKDF-SHA256 | NIST SP 800-56 Concat KDF, SHA-256 |
| Cipher | AES-256-GCM | AES-128-CTR |
| MAC | (AEAD tag) | HMAC-SHA-256 |

### Evidence

Ticking an order sealed by the frontend produces, in the enclave log:

```
[wraith] order 2: decrypt failed: decrypt: node returned 400
```

That 400 comes from `decryptWithTeeHandler` in `tee-node/internal/extension/server/server.go`, which returns `"can not decrypt"` with that status when `s.node.Decrypt` fails. The request shape is *correct* — `{"encryptedMessage": <base64>}`, matching `types.DecryptRequest`; a malformed body would fail earlier at `DisallowUnknownFields`. So the payload reaches the decryptor and the decryptor rejects the ciphertext itself.

Verified against three separately-sealed orders, including ones sealed moments after reading the live key from the proxy `/info`, which rules out a stale-key explanation.

### The fix

Encrypt with a go-ethereum-compatible ECIES implementation. This Go call produces ciphertext the enclave accepts, and is the reference:

```go
sealed, err := ecies.Encrypt(rand.Reader, ecies.ImportECDSAPublic(pub), encoded, nil, nil)
```

The browser needs the equivalent. Candidate libraries must be verified against a live enclave rather than assumed — this exact class of mismatch is what caused the bug.

**Do not treat this as fixed until an order sealed by the browser is decrypted by the enclave and logged as an evaluation.**

## 2. Stale TEE identities accumulate on one URL

Every restart of the TEE container mints a new identity, and the old one stays registered and `PRODUCTION` in `TeeMachineRegistry`. Flare's guidance is one active machine per endpoint, and dispatch selects one machine per instruction — so stale entries swallow instructions and cause apparently random delivery failures.

`getActiveTeeMachines(66190)` currently returns several machines all pointing at the same tunnel URL, which is why some ticks route and evaluate while others never reach the handler.

There is no public pause function on the diamond — `pauseTeeMachine`, `pauseMachine`, `deactivateTeeMachine` and `removeTeeMachine` all revert with the diamond's function-not-found selector.

The documented recovery is a fresh `EXTENSION_ID` via `pre-build`. Because `WraithOrders.setExtensionId()` is one-shot by design, that also requires deploying a fresh `WraithOrders`.

**Practical consequence:** restart the TEE as rarely as possible. After any restart, re-register with a capital `R` for a fresh challenge (`-command rRap`) — a stale challenge fails with `Verification.ChallengeExpired`.

## 3. `start-services.sh` does not rebuild a changed extension image

The script starts the compose stack but reuses the cached `extension-tee` image, so edits to the Go extension are silently ignored and the running container can be days older than the source. This cost real debugging time: a corrected decrypt client appeared not to work because the old binary was still running.

Force it after any extension change:

```bash
docker compose -p extension-scaffold-coston2 \
  -f docker-compose.yaml -f docker-compose.coston2.yaml \
  build --no-cache extension-tee
```

Check the image is actually newer than your source before concluding a fix did not work:

```bash
docker images --format "{{.Repository}}\t{{.CreatedAt}}" | grep extension-tee
```

## 4. BuildKit is required

The scaffold's Dockerfiles use `--mount=type=cache` and `--chmod`, both BuildKit-only. Without the `docker-buildx` plugin the build fails with `the --mount option requires BuildKit`. Install it (`docker-buildx` on Arch). Do not strip the directives — they are part of the reproducible-build setup that FCC code hashing depends on.
