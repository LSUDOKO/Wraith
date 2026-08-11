# Wraith keeper

Pokes live orders so the TEE re-evaluates their private conditions, then relays TEE-signed results on-chain.

## Trust

The keeper is untrusted by design, and anyone can run one.

It never sees an order's terms — it forwards ciphertext it cannot read, and the TEE reads FTSO itself rather than accepting a price from the keeper. The worst a hostile keeper can do is *withhold* ticks, which is precisely why ticking is permissionless: if one keeper stops, anyone else can tick the same order.

What a keeper does learn is whether a given tick fired, since it has to relay the result to settle it. It never learns how far from the trigger an order was, or what the trigger is.

## Run

```bash
npm install

export WRAITH_ADDRESS=0x...
export KEEPER_PRIVATE_KEY=0x...
export EXT_PROXY_URL=http://127.0.0.1:6674
export INSTRUCTION_FEE_WEI=...     # fee forwarded to TeeExtensionRegistry.sendInstructions

npm start
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `RPC_URL` | Coston2 public RPC | Flare RPC endpoint |
| `WRAITH_ADDRESS` | — (required) | Deployed `WraithOrders` |
| `KEEPER_PRIVATE_KEY` | — (required) | Funded key; pays gas and instruction fees |
| `EXT_PROXY_URL` | `http://127.0.0.1:6674` | Extension proxy |
| `POLL_INTERVAL_MS` | `15000` | Loop interval |
| `INSTRUCTION_FEE_WEI` | `0` | Native fee per instruction |
| `SUBMISSION_TAG` | `submit` | Fallback if the proxy omits the tag |

The keeper pays for ticks, so `MIN_TICK_INTERVAL` in the contract also protects it from being drained by a tight loop against a single order.

## Scaling

State is an in-memory map of instructions awaiting results, so a restart forgets in-flight instructions; they are re-ticked on the next pass once `MIN_TICK_INTERVAL` elapses. That is the right trade for a keeper — it is a poller, not a source of truth, and the chain holds everything that matters.
