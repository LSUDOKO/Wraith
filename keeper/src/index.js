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
import { readFileSync } from "node:fs";
import {
  handleFetchResultResponse,
  determineRelayAction,
  decodeAction,
  sendTelegramNotification,
  recipientsFor
} from "./lib.js";
import {
  prepareRequest,
  fetchProof,
  calculateRoundId,
  isAttestationFresh,
  shouldRetryAttestation,
  FDC_PROTOCOL_ID,
} from "./attest.js";

const RPC_URL = process.env.RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const WRAITH_ADDRESS = required("WRAITH_ADDRESS");
const EXT_PROXY_URL = (process.env.EXT_PROXY_URL ?? "http://127.0.0.1:6674").replace(/\/$/, "");
const PRIVATE_KEY = required("KEEPER_PRIVATE_KEY");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15_000);
const INSTRUCTION_FEE_WEI = BigInt(process.env.INSTRUCTION_FEE_WEI ?? "0");
const SUBMISSION_TAG = process.env.SUBMISSION_TAG ?? "submit";
// A second oracle for consensus orders. Unset means every tick is a plain tick,
// and consensus orders simply never fire — which is the correct failure: an
// order that needs two sources must not settle on one.
const FDC_ENABLED = Boolean(process.env.FDC_API_URL);
const FLARE_CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
// Where the frontend writes owner -> Telegram chat id. Read fresh on each
// notification rather than cached at boot, so a user subscribing does not have
// to wait for the keeper to be restarted.
const ALERTS_FILE = process.env.WRAITH_ALERTS_FILE ?? "../.wraith-alerts.json";

function loadSubscriptions() {
  try {
    return JSON.parse(readFileSync(ALERTS_FILE, "utf8"));
  } catch {
    // No file yet is the normal state before anyone subscribes.
    return {};
  }
}

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
  "function tickAttestedWeb2(uint256 orderId, (bytes32[] merkleProof, (bytes32 attestationType, bytes32 sourceId, uint64 votingRound, uint64 lowestUsedTimestamp, (string url, string httpMethod, string headers, string queryParams, string body, string postProcessJq, string abiSignature) requestBody, (bytes abiEncodedData) responseBody) data) proof) payable",
  "function execute(bytes resultData, bytes32 actionId, string submissionTag, uint8 status, bytes signature)",
  "function getOrder(uint256 orderId) view returns (address owner, address tokenIn, uint256 amountIn, uint64 expiry, bool executed, bool cancelled, bytes encrypted)",
  "event OrderTicked(uint256 indexed orderId, bytes32 instructionId)",
]);

const account = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({ chain: coston2, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain: coston2, transport: http(RPC_URL) });

/** instructionId -> orderId, for instructions whose result has not arrived yet. */
const pending = new Map();

/** The most recent FDC reading, reused across every order ticked in its window.
 *  Rounds take 90–180s and cost a fee; requesting one per order would be slower
 *  and dearer for no extra assurance, since it is the same reading either way. */
let attestation = null;
/** When the last attestation attempt was made, successful or not. */
let lastAttestationAttempt = null;

const registryAbi = parseAbi([
  "function getContractAddressByName(string name) view returns (address)",
]);
const fdcHubAbi = parseAbi(["function requestAttestation(bytes data) payable"]);
const feeAbi = parseAbi([
  "function getRequestFee(bytes data) view returns (uint256)",
]);
const systemsAbi = parseAbi([
  "function firstVotingRoundStartTs() view returns (uint64)",
  "function votingEpochDurationSeconds() view returns (uint64)",
]);
const relayAbi = parseAbi([
  "function isFinalized(uint256 protocolId, uint256 votingRoundId) view returns (bool)",
]);

function registryLookup(name) {
  return publicClient.readContract({
    address: FLARE_CONTRACT_REGISTRY,
    abi: registryAbi,
    functionName: "getContractAddressByName",
    args: [name],
  });
}

/**
 * Request an FDC attestation and wait for its proof.
 *
 * Returns null rather than throwing when the round has not finalized yet: a
 * missing attestation costs nothing but a plain tick, while a stalled keeper
 * would stop every other order too.
 */
async function refreshAttestation() {
  if (!FDC_ENABLED) return null;
  if (isAttestationFresh(attestation, Date.now())) return attestation;
  if (!shouldRetryAttestation(lastAttestationAttempt, Date.now())) return attestation;

  lastAttestationAttempt = Date.now();
  const abiEncodedRequest = await prepareRequest(process.env);

  const [fdcHub, feeConfig, systemsManager, relay] = await Promise.all([
    registryLookup("FdcHub"),
    registryLookup("FdcRequestFeeConfigurations"),
    registryLookup("FlareSystemsManager"),
    registryLookup("Relay"),
  ]);

  const fee = await publicClient.readContract({
    address: feeConfig,
    abi: feeAbi,
    functionName: "getRequestFee",
    args: [abiEncodedRequest],
  });

  const hash = await walletClient.writeContract({
    address: fdcHub,
    abi: fdcHubAbi,
    functionName: "requestAttestation",
    args: [abiEncodedRequest],
    value: fee,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  // By hash, not by number. A load-balanced public RPC can answer a
  // number lookup from a lagging node, and a block timestamp hours stale
  // yields a round id hours in the past — one that is already finalized but
  // contains no proof, so the wait below times out with nothing to show for
  // it. A hash lookup either returns that exact block or fails loudly.
  const block = await publicClient.getBlock({ blockHash: receipt.blockHash });

  const [firstStart, epochSeconds] = await Promise.all([
    publicClient.readContract({ address: systemsManager, abi: systemsAbi, functionName: "firstVotingRoundStartTs" }),
    publicClient.readContract({
      address: systemsManager,
      abi: systemsAbi,
      functionName: "votingEpochDurationSeconds",
    }),
  ]);
  const roundId = calculateRoundId(block.timestamp, firstStart, epochSeconds);
  console.log(
    `requested attestation for round ${roundId} (fee ${formatEther(fee)} C2FLR, block ts ${block.timestamp})`,
  );

  // Rounds take 90-180s. Waiting here blocks ticking, so the wait is bounded and
  // the loop simply retries on the next pass if the round is slow.
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const finalized = await publicClient.readContract({
      address: relay,
      abi: relayAbi,
      functionName: "isFinalized",
      args: [BigInt(FDC_PROTOCOL_ID), BigInt(roundId)],
    });
    if (finalized) {
      const proof = await fetchProof(process.env, abiEncodedRequest, roundId);
      if (proof) {
        attestation = { proof, fetchedAt: Date.now() };
        console.log(`attestation for round ${roundId} ready`);
        return attestation;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }

  console.error(`round ${roundId} did not finalize in time; ticking without a second oracle`);
  return null;
}

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
      // An attested tick is a strict superset of a plain one: kinds that do not
      // need a second oracle ignore the reading entirely, so attaching it when
      // one is available costs nothing and is the only way a consensus order
      // ever fires.
      const hash = attestation
        ? await walletClient.writeContract({
            address: WRAITH_ADDRESS,
            abi,
            functionName: "tickAttestedWeb2",
            args: [orderId, attestation.proof],
            value: INSTRUCTION_FEE_WEI,
          })
        : await walletClient.writeContract({
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

      if (process.env.TELEGRAM_BOT_TOKEN) {
        const action = decodeAction(relayAction.data);
        const owner = await publicClient
          .readContract({ address: WRAITH_ADDRESS, abi, functionName: "getOrder", args: [orderId] })
          .then((order) => order[0])
          .catch(() => null);
        const chats = recipientsFor(process.env, loadSubscriptions(), owner);
        if (chats.length > 0) {
          try {
            await sendTelegramNotification(process.env, orderId, action, hash, chats);
          } catch (notifyError) {
            console.error(`Telegram notification error for order ${orderId}: ${notifyError.message}`);
          }
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
  console.log(
    FDC_ENABLED
      ? `second oracle: ${process.env.FDC_API_URL}`
      : "no second oracle configured — consensus orders will not fire",
  );

  for (;;) {
    try {
      if (FDC_ENABLED) {
        try {
          await refreshAttestation();
        } catch (error) {
          // A failed attestation must not stop plain orders from ticking.
          console.error(`attestation refresh failed: ${error.shortMessage ?? error.message}`);
        }
      }
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
