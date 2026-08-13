import { NextResponse } from "next/server";
import { createPublicClient, createWalletClient, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WRAITH_ABI, coston2 } from "@/lib/wraith";

/**
 * Sponsored order creation.
 *
 * A user who minted FXRP holds no FLR, so they cannot pay for the transaction
 * that would escrow it — the asset they want to protect is the one asset they
 * cannot act on. Here the browser sends an EIP-712 signature and this route
 * pays the gas, reimbursing itself out of the escrowed token via the intent's
 * `relayerFee`.
 *
 * The relayer is not trusted with anything: every field of the intent is
 * covered by the user's signature, so this route cannot retarget the escrow,
 * raise its own fee, or substitute different sealed terms. The worst it can do
 * is refuse to submit.
 */
const RELAYER_KEY = process.env.RELAYER_PRIVATE_KEY;
const RPC_URL = process.env.COSTON2_RPC_URL ?? coston2.rpcUrls.default.http[0];

export const dynamic = "force-dynamic";

type Body = {
  wraith?: string;
  encrypted?: string;
  signature?: string;
  intent?: {
    owner?: string;
    tokenIn?: string;
    amountIn?: string;
    expiry?: string;
    relayerFee?: string;
    deadline?: string;
  };
};

export async function POST(request: Request) {
  if (!RELAYER_KEY) {
    return NextResponse.json({ error: "no relayer configured" }, { status: 503 });
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "malformed request" }, { status: 400 });
  }

  const { wraith, encrypted, signature, intent } = body;
  if (
    !wraith ||
    !isAddress(wraith) ||
    !encrypted?.startsWith("0x") ||
    !signature?.startsWith("0x") ||
    !intent?.owner ||
    !isAddress(intent.owner) ||
    !intent.tokenIn ||
    !isAddress(intent.tokenIn)
  ) {
    return NextResponse.json({ error: "malformed intent" }, { status: 400 });
  }

  let amountIn: bigint;
  let expiry: bigint;
  let relayerFee: bigint;
  let deadline: bigint;
  try {
    amountIn = BigInt(intent.amountIn ?? "0");
    expiry = BigInt(intent.expiry ?? "0");
    relayerFee = BigInt(intent.relayerFee ?? "0");
    deadline = BigInt(intent.deadline ?? "0");
  } catch {
    return NextResponse.json({ error: "intent carries a non-numeric field" }, { status: 400 });
  }

  const account = privateKeyToAccount(RELAYER_KEY as Hex);
  const transport = http(RPC_URL);
  const publicClient = createPublicClient({ chain: coston2, transport });
  const wallet = createWalletClient({ account, chain: coston2, transport });

  const args = [
    {
      owner: intent.owner as Address,
      tokenIn: intent.tokenIn as Address,
      amountIn,
      expiry,
      relayerFee,
      deadline,
    },
    encrypted as Hex,
    signature as Hex,
  ] as const;

  try {
    // Simulating first turns a revert into a readable message instead of a
    // burnt transaction: the relayer pays for failures, so it should not pay
    // for ones it can see coming.
    await publicClient.simulateContract({
      account,
      address: wraith as Address,
      abi: WRAITH_ABI,
      functionName: "createOrderFor",
      args,
    });

    const hash = await wallet.writeContract({
      address: wraith as Address,
      abi: WRAITH_ABI,
      functionName: "createOrderFor",
      args,
    });

    return NextResponse.json({ hash, relayer: account.address });
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
