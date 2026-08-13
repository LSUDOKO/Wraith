import { NextResponse } from "next/server";
import { readFileSync, writeFileSync } from "node:fs";
import { isAddress } from "viem";

/**
 * Telegram subscriptions: wallet address -> chat id.
 *
 * Browser notifications only reach someone with the tab open, which is exactly
 * the wrong moment — an order fires while you are asleep or away. Telegram
 * closes that gap, but only the keeper is awake when it happens, so the two
 * processes have to agree on who wants what.
 *
 * They agree through this file. It is deliberately the smallest possible
 * mechanism for a single-box deployment: no database, no queue, no service to
 * keep running. The keeper re-reads it on every notification, so subscribing
 * takes effect immediately rather than at the next keeper restart.
 *
 * ponytail: a shared file assumes keeper and frontend share a filesystem. Move
 * this to the keeper's own HTTP surface if they are ever deployed apart.
 */
const ALERTS_FILE = process.env.WRAITH_ALERTS_FILE ?? "../.wraith-alerts.json";

export const dynamic = "force-dynamic";

type Subscriptions = Record<string, string>;

function load(): Subscriptions {
  try {
    return JSON.parse(readFileSync(ALERTS_FILE, "utf8")) as Subscriptions;
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address");
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: "bad address" }, { status: 400 });
  }
  // Only ever reports whether *this* address is subscribed. Returning the whole
  // file would hand any visitor every user's chat id.
  const chatId = load()[address.toLowerCase()] ?? null;
  return NextResponse.json({ subscribed: Boolean(chatId) });
}

export async function POST(request: Request) {
  let body: { address?: string; chatId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "malformed request" }, { status: 400 });
  }

  const { address, chatId } = body;
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: "bad address" }, { status: 400 });
  }

  // Telegram chat ids are integers, negative for groups. Rejecting anything
  // else keeps arbitrary text out of the file the keeper trusts.
  const trimmed = (chatId ?? "").trim();
  if (trimmed && !/^-?\d{1,20}$/.test(trimmed)) {
    return NextResponse.json({ error: "a Telegram chat id is a number" }, { status: 400 });
  }

  try {
    const subscriptions = load();
    if (trimmed) {
      subscriptions[address.toLowerCase()] = trimmed;
    } else {
      // An empty chat id is how the UI unsubscribes.
      delete subscriptions[address.toLowerCase()];
    }
    writeFileSync(ALERTS_FILE, `${JSON.stringify(subscriptions, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `could not save: ${message}` }, { status: 500 });
  }

  return NextResponse.json({ subscribed: Boolean(trimmed) });
}
