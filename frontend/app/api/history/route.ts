import { NextResponse } from "next/server";

/**
 * Seed history for the price chart.
 *
 * Fetched here rather than from the browser for three reasons, all of which
 * showed up in practice: a public price API rate-limits per client IP, ad and
 * privacy extensions block requests to it outright, and a browser request
 * exposes the visitor's IP to a third party for what is only decorative
 * history. Server-side it is one request per cache window for everybody.
 *
 * This is display data. The live series is read from FTSO in the browser and
 * is the only part of the chart that claims to be authoritative.
 */
const SOURCE =
  "https://api.coingecko.com/api/v3/coins/flare-networks/market_chart?vs_currency=usd&days=7&interval=daily";

/** Long enough that a page reload does not spend a rate-limit slot, short
 *  enough that the seed does not visibly disagree with the live line. */
export const revalidate = 900;

export async function GET() {
  try {
    const response = await fetch(SOURCE, { next: { revalidate } });
    if (!response.ok) {
      return NextResponse.json({ prices: [] });
    }

    const body = (await response.json()) as { prices?: [number, number][] };
    // Answer with an empty series rather than an error: a missing seed costs
    // the chart some history and nothing else, and the component should not
    // have to tell an outage apart from a quiet response.
    return NextResponse.json({ prices: body.prices ?? [] });
  } catch {
    return NextResponse.json({ prices: [] });
  }
}
