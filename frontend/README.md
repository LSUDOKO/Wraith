# Wraith frontend

Where an order's condition is encrypted — in the user's own browser, before anything reaches the chain.

## Run

```bash
npm install
cp .env.example .env.local   # fill in the deployed addresses
npm run dev
```

Connect MetaMask on Coston2 (chain ID 114) and fund it from the [Coston2 faucet](https://faucet.flare.network/coston2).

The extension stack must be running, since the app fetches the enclave's public key from the proxy's `/info` endpoint before it can seal anything.

## How the encryption path works

1. `/api/info` (server-side) fetches the enclave public key from the extension proxy. It is relayed rather than called from the browser because the proxy sets no CORS headers, and its tunnel URL should not ship in a client bundle.
2. `sealTerms()` ABI-encodes the order terms and ECIES-encrypts them to that key. This happens in the browser; the plaintext never leaves the page.
3. `createOrder()` stores the ciphertext on Coston2 alongside the escrow.

From then on the condition is readable only inside the enclave.

## Design

**Darkroom safelight.** A darkroom is where things develop unseen and light destroys them, which is the right world for an order whose condition must never be exposed. Violet-cast ink ground, one signal colour (safelight amber), and a single type family.

Two decisions carry the idea:

- **Mono is reserved for cipher bytes.** Nothing else on the page is monospaced, so the unreadable material reads as the most privileged thing on screen.
- **The seal is the signature element.** Every legible fact about an order sits above a hex block with a slow safelight sweep across it. The design's whole argument is the contrast: everything is public except the one thing that matters.

Fields whose values are encrypted carry an amber left border, so it is visually obvious which parts of the form stay secret.

Motion is one ambient sweep, disabled under `prefers-reduced-motion`.
