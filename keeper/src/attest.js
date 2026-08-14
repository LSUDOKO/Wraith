// FDC attestation for the keeper.
//
// The enclave cannot reach FDC — the TEE-based FDC is a Flare *system*
// application with no interface a third-party extension may call. So the proof
// has to arrive from outside, and it has to arrive in a form the chain can
// check: the keeper obtains it here, `tickAttestedWeb2` verifies it on-chain,
// and only the verified reading crosses into the enclave. The keeper is still
// untrusted at the end of that chain, which is the point.
//
// One attestation serves every order ticked in the same window. Rounds take
// 90–180 seconds and cost a fee, so re-requesting per order would be both slow
// and expensive for no extra assurance — the reading is the same reading.

import { decodeAbiParameters } from "viem";

/** How long a fetched attestation is reused before a new round is requested.
 *  The enclave rejects anything older than 30 minutes, so this leaves room for
 *  a slow round plus the relay that follows it. */
const REUSE_WINDOW_MS = 10 * 60 * 1000;

/** FDC's protocol id in the Relay contract. */
export const FDC_PROTOCOL_ID = 200;

/** Flare's published public key for the testnet verifier and DA Layer.
 *  It is documented, not a secret, and it is what makes Coston2 work with no
 *  request to anyone. Raise a Flare API Key Request only for higher DA Layer
 *  rate limits than a keeper needs. */
const PUBLIC_TESTNET_API_KEY = "00000000-0000-0000-0000-000000000000";

/** UTF-8 hex, right-padded to 32 bytes. The verifier rejects anything else. */
export function toUtf8HexString(value) {
  return "0x" + Buffer.from(value, "utf8").toString("hex").padEnd(64, "0");
}

/** Which voting round a request landed in, from the block that carried it. */
export function calculateRoundId(blockTimestamp, firstVotingRoundStartTs, votingEpochDurationSeconds) {
  return Number((BigInt(blockTimestamp) - BigInt(firstVotingRoundStartTs)) / BigInt(votingEpochDurationSeconds));
}

/** How long to wait after a failed attestation before trying again.
 *  The public price APIs rate-limit the verifier's shared IP, so a rejection is
 *  usually transient — and retrying every poll interval is the one response
 *  guaranteed to keep it rejected. */
const RETRY_BACKOFF_MS = 60 * 1000;

/** Whether enough time has passed since the last failed attempt. */
export function shouldRetryAttestation(lastAttemptAt, nowMs) {
  if (!lastAttemptAt) return true;
  return nowMs - lastAttemptAt >= RETRY_BACKOFF_MS;
}

/** Whether a cached attestation may still be reused. */
export function isAttestationFresh(cached, nowMs) {
  if (!cached) return false;
  return nowMs - cached.fetchedAt < REUSE_WINDOW_MS;
}

/**
 * The shape Wraith asks the attestation to be post-processed into.
 *
 * `tickAttestedWeb2` decodes exactly this tuple, in this order, and scales
 * `value` by `decimals` to reach the 1e18 the enclave compares against.
 *
 * The reading carries its own scale rather than arriving pre-scaled because the
 * jq subset FDC permits has no `floor`: turning a float price into a 1e18
 * integer inside jq means string-truncating a number large enough to render in
 * scientific notation, which fails silently and by orders of magnitude. A small
 * integer plus its decimals is exact, and it is the shape FTSO already uses.
 */
const READING_SIGNATURE = JSON.stringify({
  components: [
    { internalType: "string", name: "source", type: "string" },
    { internalType: "uint256", name: "value", type: "uint256" },
    { internalType: "uint256", name: "decimals", type: "uint256" },
    { internalType: "uint256", name: "timestamp", type: "uint256" },
  ],
  internalType: "struct WraithReading",
  name: "reading",
  type: "tuple",
});

/**
 * Build the Web2Json request body.
 *
 * `postProcessJq` must emit `source`, `value`, `decimals` and `timestamp` in
 * that order — the tuple `tickAttestedWeb2` decodes. Keep the scale modest
 * enough that the multiplication stays an exact integer in jq's doubles; the
 * contract does the widening to 1e18.
 */
export function buildWeb2JsonRequestBody(env) {
  return {
    url: env.FDC_API_URL,
    httpMethod: env.FDC_HTTP_METHOD ?? "GET",
    headers: env.FDC_HEADERS ?? "{}",
    queryParams: env.FDC_QUERY_PARAMS ?? "{}",
    body: env.FDC_BODY ?? "{}",
    postProcessJq: env.FDC_JQ ?? DEFAULT_JQ,
    abiSignature: READING_SIGNATURE,
  };
}

/**
 * CoinGecko's FLR spot price, shaped into the reading tuple.
 *
 * `tostring | split(".") | .[0] | tonumber` is the truncation, because FDC's jq
 * subset has no `floor`. It is safe at 1e8 — FLR near $0.006 gives a six-digit
 * integer that jq never renders in scientific notation — and would not be at
 * 1e18, where it would silently return the leading digit alone.
 */
const DEFAULT_JQ =
  '{source: "coingecko:flare", value: (.["flare-networks"].usd * 100000000 | tostring | split(".") | .[0] | tonumber), decimals: 8, timestamp: .["flare-networks"].last_updated_at}';

/** The IWeb2Json.Response tuple, for decoding the DA layer's raw hex. */
const WEB2JSON_RESPONSE = [
  {
    type: "tuple",
    components: [
      { name: "attestationType", type: "bytes32" },
      { name: "sourceId", type: "bytes32" },
      { name: "votingRound", type: "uint64" },
      { name: "lowestUsedTimestamp", type: "uint64" },
      {
        name: "requestBody",
        type: "tuple",
        components: [
          { name: "url", type: "string" },
          { name: "httpMethod", type: "string" },
          { name: "headers", type: "string" },
          { name: "queryParams", type: "string" },
          { name: "body", type: "string" },
          { name: "postProcessJq", type: "string" },
          { name: "abiSignature", type: "string" },
        ],
      },
      {
        name: "responseBody",
        type: "tuple",
        components: [{ name: "abiEncodedData", type: "bytes" }],
      },
    ],
  },
];

/** Ask the verifier to turn a request into the bytes FdcHub accepts. */
export async function prepareRequest(env, fetchImpl = fetch) {
  const base = (env.FDC_VERIFIER_URL ?? "https://fdc-verifiers-testnet.flare.network").replace(/\/$/, "");
  const response = await fetchImpl(`${base}/verifier/web2/Web2Json/prepareRequest`, {
    method: "POST",
    headers: {
      "X-API-KEY": env.FDC_VERIFIER_API_KEY ?? PUBLIC_TESTNET_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      attestationType: toUtf8HexString("Web2Json"),
      sourceId: toUtf8HexString("PublicWeb2"),
      requestBody: buildWeb2JsonRequestBody(env),
    }),
  });

  if (!response.ok) {
    throw new Error(`verifier returned ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  if (!data?.abiEncodedRequest) {
    throw new Error(`verifier returned no abiEncodedRequest (status ${data?.status ?? "unknown"})`);
  }
  return data.abiEncodedRequest;
}

/** Pull the finalized proof out of the DA layer. Returns null until it exists. */
export async function fetchProof(env, abiEncodedRequest, roundId, fetchImpl = fetch) {
  const base = (env.DA_LAYER_URL ?? "https://ctn2-data-availability.flare.network").replace(/\/$/, "");
  const response = await fetchImpl(`${base}/api/v1/fdc/proof-by-request-round-raw`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": env.DA_LAYER_API_KEY ?? PUBLIC_TESTNET_API_KEY,
    },
    body: JSON.stringify({ votingRoundId: roundId, requestBytes: abiEncodedRequest }),
  });

  if (!response.ok) return null;
  const proof = await response.json();
  const hex = proof?.response_hex ?? proof?.responseHex;
  if (!hex) return null;

  const [data] = decodeAbiParameters(WEB2JSON_RESPONSE, hex);
  return { merkleProof: proof.proof ?? proof.merkleProof ?? [], data };
}
