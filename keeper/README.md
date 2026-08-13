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

## Second oracle (consensus orders)

A consensus order only fires when FTSO and an FDC-attested off-chain price both cross the threshold. The enclave cannot fetch the second reading — FDC is a Flare *system* application with no interface a third-party extension may call — so the keeper requests the attestation, the contract verifies the proof on-chain, and only the verified reading crosses into the enclave.

Set `FDC_API_URL` to switch this on. Unset, every tick is a plain tick and consensus orders never fire, which is the correct failure: an order that asked for two sources must not settle on one.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FDC_API_URL` | — | Enables attestation when set |
| `FDC_JQ` | CoinGecko FLR spot | jq producing `{source, valueE18, timestamp}` |
| `FDC_QUERY_PARAMS` | `{}` | JSON string |
| `FDC_HTTP_METHOD` | `GET` | |
| `FDC_HEADERS` / `FDC_BODY` | `{}` | JSON strings |
| `FDC_VERIFIER_URL` | `https://fdc-verifiers-testnet.flare.network` | |
| `FDC_VERIFIER_API_KEY` | — | Issued by Flare |
| `DA_LAYER_URL` | `https://ctn2-data-availability.flare.network` | |
| `DA_LAYER_API_KEY` | — | |

Example:

```bash
export FDC_API_URL=https://api.coingecko.com/api/v3/simple/price
export FDC_QUERY_PARAMS='{"ids":"flare-networks","vs_currencies":"usd","include_last_updated_at":"true"}'
export FDC_VERIFIER_API_KEY=...
```

One attestation serves every order ticked inside a ten-minute window. Rounds take 90–180 seconds and cost a fee, so re-requesting per order would be slower and dearer for no extra assurance — it is the same reading either way. An attested tick is a strict superset of a plain one, so orders that need no second oracle simply ignore the attached reading.

The source API must be on Flare's Web2Json allowlist, and `FDC_JQ` must emit exactly `source`, `valueE18` and `timestamp`, in that order — that is the tuple `tickAttestedWeb2` decodes.

## Scaling

State is an in-memory map of instructions awaiting results, so a restart forgets in-flight instructions; they are re-ticked on the next pass once `MIN_TICK_INTERVAL` elapses. That is the right trade for a keeper — it is a poller, not a source of truth, and the chain holds everything that matters.
