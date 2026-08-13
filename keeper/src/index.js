// Wraith keeper.
//
// Two jobs, both permissionless: poke live orders so the TEE re-evaluates their
// private conditions, and relay TEE-signed results back on-chain.
//
// The keeper is deliberately untrusted. It never sees an order's terms — it
// forwards ciphertext it cannot read, and the TEE reads FTSO itself rather than
// accepting a price from here. The worst a hostile keeper can do is withhold
// ticks, which is why ticking is open to anyone.

import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  handleFetchResultResponse,
  determineRelayAction,
  shouldNotify,
  decodeAction,
  sendTelegramNotification
} from "./lib.js";

const RPC_URL = process.env.RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const WRAITH_ADDRESS = required("WRAITH_ADDRESS");
const EXT_PROXY_URL = (process.env.EXT_PROXY_URL ?? "http://127.0.0.1:6674").replace(/\/$/, "");
const PRIVATE_KEY = required("KEEPER_PRIVATE_KEY");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15_000);
const INSTRUCTION_FEE_WEI = BigInt(process.env.INSTRUCTION_FEE_WEI ?? "0");
const SUBMISSION_TAG = process.env.SUBMISSION_TAG ?? "submit";

const coston2 = {
  id: 114,
  name: "Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const abi = parseAbi([
  "function orderCount() view returns (uint256)",
  "function canTick(uint256 orderId) view returns (bool)",
  "function tick(uint256 orderId) payable",
  "function execute(bytes resultData, bytes32 actionId, string submissionTag, uint8 status, bytes signature)",
  "event OrderTicked(uint256 indexed orderId, bytes32 instructionId)",
]);

const account = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({ chain: coston2, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain: coston2, transport: http(RPC_URL) });

/** instructionId -> orderId, for instructions whose result has not arrived yet. */
const pending = new Map();

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

/**
 * Ask the extension proxy for an instruction's result.
 *
 * Returns null while the TEE is still working, which is the common case — most
 * ticks resolve to "condition not met".
 */
async function fetchResult(instructionId) {
  const response = await fetch(`${EXT_PROXY_URL}/action/result?id=${instructionId}`);
  return handleFetchResultResponse(response, instructionId);
}

async function tickOrders() {
  const count = await publicClient.readContract({ address: WRAITH_ADDRESS, abi, functionName: "orderCount" });

  for (let orderId = 0n; orderId < count; orderId++) {
    const tickable = await publicClient.readContract({
      address: WRAITH_ADDRESS,
      abi,
      functionName: "canTick",
      args: [orderId],
    });
    if (!tickable) continue;

    try {
      const hash = await walletClient.writeContract({
        address: WRAITH_ADDRESS,
        abi,
        functionName: "tick",
        args: [orderId],
        value: INSTRUCTION_FEE_WEI,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // OrderTicked carries the instruction id the proxy will key the result by.
      const events = parseEventLogs({ abi, logs: receipt.logs, eventName: "OrderTicked" });
      for (const event of events) {
        pending.set(event.args.instructionId, orderId);
        console.log(`ticked order ${orderId} -> instruction ${event.args.instructionId}`);
      }
    } catch (error) {
      // One bad order must not stall every other order.
      console.error(`tick failed for order ${orderId}: ${error.shortMessage ?? error.message}`);
    }
  }
}

async function relayResults() {
  for (const [instructionId, orderId] of [...pending]) {
    let result;
    try {
      result = await fetchResult(instructionId);
    } catch (error) {
      console.error(`polling ${instructionId}: ${error.message}`);
      continue;
    }
    if (!result) continue;

    pending.delete(instructionId);

    if (result.status !== 1) {
      console.error(`order ${orderId}: TEE reported failure (status ${result.status})`);
      continue;
    }

    const relayAction = determineRelayAction(result, SUBMISSION_TAG);
    if (!relayAction) {
      continue;
    }

    try {
      const hash = await walletClient.writeContract({
        address: WRAITH_ADDRESS,
        abi,
        functionName: "execute",
        args: [relayAction.data, instructionId, relayAction.submissionTag, relayAction.status, relayAction.signature],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      console.log(`order ${orderId} executed in ${hash}`);

      if (shouldNotify(process.env)) {
        const action = decodeAction(relayAction.data);
        try {
          await sendTelegramNotification(process.env, orderId, action, hash);
        } catch (notifyError) {
          console.error(`Telegram notification error for order ${orderId}: ${notifyError.message}`);
        }
      }
    } catch (error) {
      console.error(`execute failed for order ${orderId}: ${error.shortMessage ?? error.message}`);
    }
  }
}

async function main() {
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`keeper ${account.address} (${formatEther(balance)} C2FLR)`);
  console.log(`watching ${WRAITH_ADDRESS} via ${EXT_PROXY_URL}, every ${POLL_INTERVAL_MS}ms`);

  for (;;) {
    try {
      await tickOrders();
      await relayResults();
    } catch (error) {
      console.error(`loop error: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
