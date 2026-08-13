// Wraith keeper.
//
// Two jobs, both permissionless: poke live orders so the TEE re-evaluates their
// private conditions, and relay TEE-signed results back on-chain.
//
// The keeper is deliberately untrusted. It never sees an order's terms — it
// forwards ciphertext it cannot read, and the TEE reads FTSO itself rather than
// accepting a price from here. The worst a hostile keeper can do is withhold
// ticks, which is why ticking is open to anyone.

import { createServer } from "node:http";
import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  handleFetchResultResponse,
  determineRelayAction,
  calculateBackoff,
  incrementFailure,
  resetFailure,
  isExceeded,
  evictExpiredPending,
  isRpcError,
  handleHealthRequest,
} from "./lib.js";

const RPC_URL = process.env.RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const WRAITH_ADDRESS = required("WRAITH_ADDRESS");
const EXT_PROXY_URL = (process.env.EXT_PROXY_URL ?? "http://127.0.0.1:6674").replace(/\/$/, "");
const PRIVATE_KEY = required("KEEPER_PRIVATE_KEY");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15_000);
const INSTRUCTION_FEE_WEI = BigInt(process.env.INSTRUCTION_FEE_WEI ?? "0");
const SUBMISSION_TAG = process.env.SUBMISSION_TAG ?? "submit";

// Configurable environment variables for hardening
const BACKOFF_MAX_MS = Number(process.env.BACKOFF_MAX_MS ?? 300_000);
const ORDER_MAX_RETRIES = Number(process.env.ORDER_MAX_RETRIES ?? 5);
const PENDING_TTL_MS = Number(process.env.PENDING_TTL_MS ?? 3_600_000);
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? 8080);

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

/** instructionId -> { orderId, addedAt } */
const pending = new Map();

/** orderId -> consecutive failures count */
const orderFailures = new Map();

// Variables for health monitoring
let lastSuccessfulLoopTime = null;
let keeperBalanceString = "0 C2FLR";

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
    if (isExceeded(orderFailures, orderId, ORDER_MAX_RETRIES)) {
      continue;
    }

    let tickable = false;
    try {
      tickable = await publicClient.readContract({
        address: WRAITH_ADDRESS,
        abi,
        functionName: "canTick",
        args: [orderId],
      });
    } catch (error) {
      if (isRpcError(error)) {
        throw error;
      }
      console.error(`canTick failed for order ${orderId}: ${error.message}`);
      incrementFailure(orderFailures, orderId);
      continue;
    }

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

      // Reset failure count upon a successful tick
      resetFailure(orderFailures, orderId);

      // OrderTicked carries the instruction id the proxy will key the result by.
      const events = parseEventLogs({ abi, logs: receipt.logs, eventName: "OrderTicked" });
      for (const event of events) {
        pending.set(event.args.instructionId, { orderId, addedAt: Date.now() });
        console.log(`ticked order ${orderId} -> instruction ${event.args.instructionId}`);
      }
    } catch (error) {
      if (isRpcError(error)) {
        throw error;
      }
      console.error(`tick failed for order ${orderId}: ${error.shortMessage ?? error.message}`);
      incrementFailure(orderFailures, orderId);
    }
  }
}

async function relayResults() {
  for (const [instructionId, entry] of [...pending]) {
    const { orderId } = entry;
    let result;
    try {
      result = await fetchResult(instructionId);
    } catch (error) {
      if (isRpcError(error)) {
        throw error;
      }
      console.error(`polling ${instructionId}: ${error.message}`);
      continue;
    }
    if (!result) continue;

    pending.delete(instructionId);

    if (result.status !== 1) {
      console.error(`order ${orderId}: TEE reported failure (status ${result.status})`);
      incrementFailure(orderFailures, orderId);
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
      resetFailure(orderFailures, orderId);
    } catch (error) {
      if (isRpcError(error)) {
        throw error;
      }
      console.error(`execute failed for order ${orderId}: ${error.shortMessage ?? error.message}`);
      incrementFailure(orderFailures, orderId);
    }
  }
}

function getHealthData() {
  return {
    lastSuccessfulLoopTime,
    pendingCount: pending.size,
    keeperBalance: keeperBalanceString,
  };
}

async function main() {
  // Start health HTTP server
  const server = createServer((req, res) => {
    handleHealthRequest(req, res, getHealthData);
  });
  server.listen(HEALTH_PORT, "0.0.0.0", () => {
    console.log(`Health server listening on port ${HEALTH_PORT}`);
  });

  console.log(`keeper ${account.address} watching ${WRAITH_ADDRESS} via ${EXT_PROXY_URL}`);
  console.log(`POLL_INTERVAL_MS=${POLL_INTERVAL_MS}, PENDING_TTL_MS=${PENDING_TTL_MS}, ORDER_MAX_RETRIES=${ORDER_MAX_RETRIES}`);

  let consecutiveRpcFailures = 0;

  for (;;) {
    let delayMs = POLL_INTERVAL_MS;

    try {
      const balance = await publicClient.getBalance({ address: account.address });
      keeperBalanceString = `${formatEther(balance)} C2FLR`;

      await tickOrders();
      await relayResults();

      const evictedCount = evictExpiredPending(pending, PENDING_TTL_MS);
      if (evictedCount > 0) {
        console.log(`evicted ${evictedCount} expired pending instructions from memory`);
      }

      // Loop completed successfully
      lastSuccessfulLoopTime = new Date().toISOString();
      consecutiveRpcFailures = 0;
    } catch (error) {
      if (isRpcError(error)) {
        consecutiveRpcFailures++;
        delayMs = calculateBackoff(consecutiveRpcFailures, POLL_INTERVAL_MS, BACKOFF_MAX_MS);
        console.error(`RPC failure (consecutive count: ${consecutiveRpcFailures}). backing off for ${delayMs}ms: ${error.message}`);
      } else {
        console.error(`unexpected loop error: ${error.message}`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
