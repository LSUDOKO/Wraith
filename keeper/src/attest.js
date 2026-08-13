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

/** Whether a cached attestation may still be reused. */
export function isAttestationFresh(cached, nowMs) {
  if (!cached) return false;
  return nowMs - cached.fetchedAt < REUSE_WINDOW_MS;
}

/**
 * The shape Wraith asks the attestation to be post-processed into.
 *
 * `tickAttestedWeb2` decodes exactly this tuple, and the enclave compares
 * `valueE18` against a threshold at the same 1e18 scale, so the jq has to
 * produce all three fields in this order.
 */
const READING_SIGNATURE = JSON.stringify({
  components: [
    { internalType: "string", name: "source", type: "string" },
    { internalType: "uint256", name: "valueE18", type: "uint256" },
    { internalType: "uint256", name: "timestamp", type: "uint256" },
  ],
  internalType: "struct WraithReading",
  name: "reading",
  type: "tuple",
});

/**
 * Build the Web2Json request body.
 *
 * Note the jq runs in double precision, so scaling to 1e18 loses the low digits.
 * That is harmless here: a consensus order compares two sources within a
 * tolerance measured in basis points, which is many orders of magnitude wider
 * than the rounding.
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

/** CoinGecko's FLR spot price, shaped into the reading tuple. */
const DEFAULT_JQ =
  '{source: "coingecko:flare", valueE18: (."flare-networks".usd * 1000000000000000000 | floor), timestamp: (."flare-networks".last_updated_at)}';

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
