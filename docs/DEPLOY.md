# Deployment runbook — Coston2

End-to-end order of operations. Steps are sequential; each depends on the previous one.

## 0. Prerequisites

- Foundry, Docker, Go ≥ 1.23, Node ≥ 22, an HTTPS tunnel (`ngrok` or `cloudflared`)
- A Coston2-funded key: [faucet](https://faucet.flare.network/coston2)
- **Coston2 indexer DB credentials** from [Flare support](https://flare.network/resources/technical-support) — the extension proxy cannot start without them, and they are issued by a human. Request them first; everything else can proceed while you wait, except steps 3+.
- The FCC scaffold: `git clone https://github.com/flare-foundation/fce-extension-scaffold.git`

## 1. Deploy WraithOrders

Registry addresses come from the scaffold's `config/coston2/deployed-addresses.json` (FCC is pre-release; they are not in the FlareContractRegistry yet).

```bash
cd contracts
export TEE_EXTENSION_REGISTRY=0x...   # from deployed-addresses.json
export TEE_MACHINE_REGISTRY=0x...
export BLAZESWAP_ROUTER=0x...         # optional: enables swap settlement
export FXRP_ASSET_MANAGER=0x...       # optional: enables redeem settlement

forge script script/Deploy.s.sol \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc \
  --broadcast --private-key $DEPLOYER_KEY
```

## 2. Graft the extension onto the scaffold

Follow `extension/README.md`: copy the Wraith OPType/OPCommand into the scaffold's config, route `WRAITH`/`EVAL_ORDER` to the Wraith handler, and point the scaffold's registration at the deployed `WraithOrders` address (it is its own InstructionSender).

## 3. Register and start the TEE stack

In the scaffold, with `.env` configured (`SIMULATED_TEE=true`, `LOCAL_MODE=false`, tunnel URL in `EXT_PROXY_URL`, indexer credentials in the proxy TOML):

```bash
./scripts/pre-build.sh          # registers the extension → extension ID
./scripts/start-services.sh --chain coston2
./scripts/post-build.sh         # registers the TEE machine
```

Do **not** re-run `pre-build.sh --force` casually — it mints a new extension ID while the TEE machine stays bound to the old one (`MachineManager.TooMany()`).

## 4. Wire the contract to the running stack

```bash
# Once registration is confirmed on-chain:
cast send $WRAITH "setExtensionId()" --rpc-url $RPC --private-key $DEPLOYER_KEY

# TEE signer address, from the proxy: curl $EXT_PROXY_URL/info | jq .machineData
cast send $WRAITH "setTeeAddress(address,bool)" $TEE_ADDR true --rpc-url $RPC --private-key $DEPLOYER_KEY
```

## 5. Start the keeper

```bash
cd keeper && npm install
export WRAITH_ADDRESS=$WRAITH KEEPER_PRIVATE_KEY=0x... EXT_PROXY_URL=https://<tunnel>
npm start
```

## 6. Start the frontend

```bash
cd frontend && npm install
cp .env.example .env.local      # fill in WRAITH_ADDRESS, FXRP, TOKEN_OUT, proxy URL
npm run dev
```

## Smoke test

1. Create an order in the UI with a trigger that is currently false. Confirm the explorer shows only ciphertext.
2. Watch the keeper tick it; confirm no execution (the TEE returns a no-op).
3. Create an order whose trigger is already true. Confirm the keeper relays the signed result and `execute()` settles it.
4. `cast call $WRAITH "getOrder(uint256)" <id>` — confirm `executed == true` and the actionId cannot be replayed.
