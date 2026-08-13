import { createPublicClient, encodeAbiParameters, http, parseAbi, toFunctionSelector, type Address } from "viem";
import { coston2 } from "@/lib/wraith";

const client = createPublicClient({ chain: coston2, transport: http() });

export const ASSET_MANAGER = (process.env.NEXT_PUBLIC_ASSET_MANAGER ??
  "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA") as Address;

const AGENT_LIST_ABI = parseAbi([
  "function getAvailableAgentsList(uint256 start, uint256 end) view returns (address[] agents, uint256 total)",
]);

export type AgentStatus = "normal" | "ccb" | "liquidation" | "full-liquidation" | "destroying";

const STATUS_NAMES: AgentStatus[] = ["normal", "ccb", "liquidation", "full-liquidation", "destroying"];

export type Agent = {
  vault: Address;
  status: AgentStatus;
  /** Collateral ratios as percentages, e.g. 545.88. */
  vaultCR: number;
  poolCR: number;
  /** Minted FXRP, in whole tokens. */
  minted: number;
};

/**
 * AgentInfo.Info head offsets.
 *
 * The struct has 40 fields including a dynamic string, which makes generic
 * tuple decoders fail on it — viem included. The fixed fields sit at known
 * positions in the head, so they are read positionally. Word 0 is the struct
 * offset, so every index is shifted by one.
 *
 * Verified against the deployed AssetManager rather than taken from a doc.
 */
const AGENT_INFO_SELECTOR = toFunctionSelector("function getAgentInfo(address)");

const HEAD_LEAD = 1;
const WORD_STATUS = 0;
const WORD_VAULT_CR = 15;
const WORD_POOL_CR = 19;
const WORD_MINTED = 24;

function wordAt(hex: string, index: number): bigint {
  const start = 2 + (HEAD_LEAD + index) * 64;
  const slice = hex.slice(start, start + 64);
  return slice ? BigInt(`0x${slice}`) : 0n;
}

/** Reads one agent's health straight from the AssetManager. */
export async function readAgent(vault: Address): Promise<Agent | undefined> {
  try {
    // Computed rather than hardcoded: a pasted selector is a silent wrong-call
    // waiting to happen, and this one is not what a guess produces.
    const data = (AGENT_INFO_SELECTOR +
      encodeAbiParameters([{ type: "address" }], [vault]).slice(2)) as `0x${string}`;

    const raw = await client.call({ to: ASSET_MANAGER, data });
    if (!raw.data || raw.data.length < 2 + 41 * 64) return undefined;

    const status = Number(wordAt(raw.data, WORD_STATUS));

    return {
      vault,
      status: STATUS_NAMES[status] ?? "normal",
      // Ratios are in BIPS: 10000 = 100%.
      vaultCR: Number(wordAt(raw.data, WORD_VAULT_CR)) / 100,
      poolCR: Number(wordAt(raw.data, WORD_POOL_CR)) / 100,
      // FXRP is 6-decimal UBA.
      minted: Number(wordAt(raw.data, WORD_MINTED)) / 1e6,
    };
  } catch {
    return undefined;
  }
}

/** Every publicly available agent, with health. */
export async function listAgents(limit = 8): Promise<Agent[]> {
  try {
    const [vaults] = await client.readContract({
      address: ASSET_MANAGER,
      abi: AGENT_LIST_ABI,
      functionName: "getAvailableAgentsList",
      args: [0n, BigInt(limit)],
    });

    const agents = await Promise.all(vaults.map((v) => readAgent(v)));
    return agents.filter((a): a is Agent => Boolean(a));
  } catch {
    return [];
  }
}

/**
 * How worried a minter should be, given a shield floor.
 *
 * Deliberately compares against the *lower* of the two ratios: a healthy vault
 * does not protect someone whose pool side is collapsing.
 */
export function risk(agent: Agent, floorPct = 120): "safe" | "watch" | "danger" {
  if (agent.status !== "normal") return "danger";
  const weakest = Math.min(agent.vaultCR, agent.poolCR);
  if (weakest <= floorPct) return "danger";
  if (weakest <= floorPct * 1.25) return "watch";
  return "safe";
}
