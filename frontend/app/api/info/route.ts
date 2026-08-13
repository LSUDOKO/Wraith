import { NextResponse } from "next/server";

// The extension proxy is reached server-side so the browser never makes a
// cross-origin request to it. The proxy has no CORS headers, and its URL is a
// local tunnel that should not be baked into client bundles.
const EXT_PROXY_URL = (process.env.EXT_PROXY_URL ?? "http://127.0.0.1:6674").replace(/\/$/, "");

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const response = await fetch(`${EXT_PROXY_URL}/info`, { cache: "no-store" });
    if (!response.ok) {
      return NextResponse.json(
        { error: `extension proxy returned ${response.status}` },
        { status: 502 },
      );
    }

    const info = await response.json();

    // The proxy reports the enclave key as an {x, y} point. Callers need the
    // uncompressed SEC1 form ("04" || x || y) that ECIES expects, so the
    // conversion happens once here rather than in every consumer.
    const point = info?.teeInfo?.publicKey ?? info?.machineData?.publicKey ?? info?.publicKey;
    const x: string | undefined = point?.x;
    const y: string | undefined = point?.y;

    if (!x || !y) {
      return NextResponse.json({ error: "proxy /info carried no public key" }, { status: 502 });
    }

    const publicKey = `04${x.replace(/^0x/, "")}${y.replace(/^0x/, "")}`;

    return NextResponse.json({ publicKey, machineData: info?.machineData ?? null });
  } catch {
    return NextResponse.json(
      { error: `cannot reach the extension proxy at ${EXT_PROXY_URL}` },
      { status: 502 },
    );
  }
}
