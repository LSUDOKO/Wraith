# Trust assumptions

What runs privately, what is verified on-chain, and where the edges are.

Everything below is a real limitation, stated plainly. A privacy claim you cannot defend under questioning is worth less than a narrower one you can.

---

## What is actually hidden

**Hidden:** the trigger condition — the price, the direction, the action it authorizes, and the deadline. This is the whole secret, and it exists in plaintext only inside the enclave.

**Not hidden:** that an order exists, who owns it, which asset is escrowed, how much, and — once a condition fires — the resulting transaction.

Wraith removes the *advance warning*. Conventional on-chain automation publishes your trigger price and leaves it sitting there, which is exactly what makes stop-loss hunting possible. Wraith does not publish it, so it cannot be hunted.

Wraith does **not** make execution private. When a trigger fires, the swap or redemption is an ordinary public transaction and is as exposed to execution-moment MEV as any other trade. Anyone claiming a TEE makes a trade MEV-proof is overselling: the transaction still enters a mempool.

---

## Assumptions

### 1. Ciphertext is stored on-chain

The encrypted order rides on-chain as an ECIES ciphertext. Flare's own documentation is direct about this:

> Storing encrypted secrets on-chain is not advisable in production — on-chain data is public and encryption can be broken over time. A production extension should use offchain channels for secret delivery.

The exposure is *durable*: a ciphertext published today can be attacked indefinitely. For a stop-loss with a horizon of days this is an acceptable trade; for a long-lived secret it is not. Production Wraith needs an off-chain delivery channel to the enclave. This is the most significant open item.

### 2. The demo runs a simulated TEE

`SIMULATED_TEE=true`, so the code hash and platform are simulated and there is no Confidential VM hardware behind the demo. The signature verification path, the instruction lifecycle and the contract logic are all real; the hardware attestation is not. Real attestation is the production path and requires Confidential Space hardware.

### 3. You trust the TEE platform

A TEE moves trust rather than eliminating it. You are trusting the silicon vendor's attestation, the enclave's isolation against side-channel attacks, and Flare's registration of that machine. This is a smaller and more auditable trust surface than "trust the operator," but it is not zero.

### 4. Enclave state is volatile

There is no sealed storage. The extension keeps nothing durable across restarts, so the on-chain ciphertext is the canonical copy of every order and is re-decrypted on each tick. The TEE identity key is generated at boot.

### 5. TEE signers come from the registry, not from the owner

`WraithOrders.execute()` asks `TeeMachineRegistry.getActiveTeeMachines(extensionId)` whether the recovered signer is a TEE currently registered to this extension. There is no owner-controlled allowlist, so **the contract owner cannot authorize a signer of their choosing** — a test asserts exactly that. Retiring a machine in the registry revokes its ability to settle immediately, with no action needed from us.

This replaces an earlier design that did use an owner-curated allowlist. That was a real trust assumption, and it is now gone.

### 6. PMW is unavailable to third-party extensions

Protocol Managed Wallets — Flare's TEE-held cross-chain signing — is a built-in *system* application. Extension IDs below `0x10000` are reserved for system extensions and there is no developer interface to PMW.

Wraith therefore does not have a TEE sign XRPL transactions directly. Cross-chain settlement goes through FAssets redemption instead: the contract redeems FXRP and the FAssets agent delivers native XRP on the XRPL.

### 7. FDC is not callable from inside the enclave

The TEE-based FDC is likewise a system application with no developer SDK surface. Cross-chain and consensus triggers therefore take their proof from outside: the keeper fetches it, `tickAttested` / `tickAttestedWeb2` verify it on-chain against a finalized attestation round, and only the verified reading crosses into the enclave.

This is what lets the enclave refuse an unverified attestation outright rather than having to trust whoever relayed it — by the time the extension sees `verified`, it reflects a Merkle check, not the keeper's claim. The enclave also distinguishes "no proof was offered" from "a proof was offered and the chain rejected it", because only the second is evidence of a hostile keeper.

This makes the *observed data* public — but never the threshold it is compared against. Knowing "an XRPL payment of 100 XRP landed" tells an observer nothing about which orders, if any, care. The watched address is not published either: it travels as the FDC standard address hash on both sides.

### 7a. A consensus order needs two sources to agree

Privacy stops someone aiming at a trigger they cannot see; it does not stop them walking a single price feed until something fires. A consensus order settles only when FTSO and an FDC-attested off-chain price both cross the threshold, and refuses to act at all when the two disagree beyond a sealed tolerance.

The residual assumption is the attested source itself. A consensus order trusts that the Web2 endpoint behind the attestation is not controlled by the same adversary as the FTSO feed — FDC proves the API *said* something, not that it was right.

### 8. A relayer can refuse, but cannot alter

Gasless creation has the user sign an EIP-712 intent that a relayer submits. Every field is covered by the signature, so the relayer cannot retarget the escrow, substitute different sealed terms, or raise its own fee. A per-signer nonce makes each intent single-use.

The relayer can decline to submit — at which point anyone else can take the same intent, exactly as with keepers. The one thing a gasless user still needs a funded transaction for is the initial ERC-20 allowance, unless the token supports EIP-2612.

### 9. The keeper can censor, but cannot lie

The keeper sees ciphertext it cannot read, and the TEE reads FTSO itself rather than accepting a price from the keeper. A hostile keeper cannot forge a trigger or feed a false price. It *can* refuse to tick — which is why ticking is permissionless and any keeper can cover for another.

A keeper does learn whether a tick fired, since it must relay the result to settle it. It never learns the threshold or how close an order was to it.

### 10. Coston2 only

Flare Confidential Compute is "in the final stages of development and is not yet a fully public production system." Wraith targets Coston2. Do not put real funds behind this.

---

## What is verified on-chain

`WraithOrders.execute()` accepts a result only if all of the following hold:

| Check | Prevents |
| --- | --- |
| `ecrecover` over the domain-separated `ActionResult` hash resolves to an allowlisted TEE address | Forged results |
| `actionId` has not been consumed | Replaying one signed result to execute an order twice |
| `contractAddr` equals `address(this)` | Replaying a result against a different Wraith deployment |
| `status == 1` | Relaying a failed TEE result |
| Order is live: not executed, not cancelled, not expired | Settling a dead order |

The signed payload is `keccak256(abi.encode(TEE_ACTION_RESULT_PREFIX, block.chainid, ActionResult.Hash()))` under the EIP-191 prefix. Including `block.chainid` is what stops a result signed on one chain from being replayed on another.
