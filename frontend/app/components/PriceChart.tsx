"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { createPublicClient, http, type Hex } from "viem";
import { coston2, e18ToPrice, FTSOV2_ABI, FTSOV2_ADDRESS, priceToE18 } from "@/lib/wraith";

const client = createPublicClient({ chain: coston2, transport: http() });

const POLL_MS = 10_000;

/** A line series needs two points to draw anything. Below that the plot is
 *  blank, which reads as broken rather than as "no data yet", so the component
 *  says so in words instead. */
const MIN_POINTS = 2;

/** Read a CSS custom property so the chart inherits the app's palette rather
 *  than carrying a second, drifting one of its own. */
function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

type Props = {
  feedId: Hex;
  feedLabel: string;
  direction: "below" | "above";
  thresholdE18: bigint;
  takeProfitE18?: bigint;
  /** Trailing mode only. Zero or undefined means no peak has been set yet. */
  peakE18?: bigint;
  /** Called with the price the user clicked, already scaled to 1e18. */
  onThresholdChange?: (thresholdE18: bigint) => void;
};

/**
 * Live FTSO price with the order's trigger levels drawn on it.
 *
 * The session buffer is the honest part: every point after mount is a real
 * `getFeedById` read, the same oracle surface the enclave reads when it
 * evaluates. History before mount is seeded from a public price API purely so
 * the line has somewhere to sit, and is labelled as such — a chart that mixes
 * the two silently would imply a precision the seed does not have.
 */
export function PriceChart({
  feedId,
  feedLabel,
  direction,
  thresholdE18,
  takeProfitE18,
  peakE18,
  onThresholdChange,
}: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi>(null);
  const series = useRef<ISeriesApi<"Line">>(null);
  const lines = useRef<IPriceLine[]>([]);
  const points = useRef<Map<number, number>>(new Map());
  const onThresholdRef = useRef(onThresholdChange);

  const [live, setLive] = useState<number>();
  const [plotted, setPlotted] = useState(0);
  const [failed, setFailed] = useState(false);
  // A ref, not the `live` state: depending on state here would tear down and
  // rebuild the interval on every successful poll, doubling the read rate.
  const everRead = useRef(false);

  onThresholdRef.current = onThresholdChange;

  // --- chart lifecycle -----------------------------------------------------

  useEffect(() => {
    if (!holder.current) return;

    const text = token("--muted", "#9a90ad");
    const line = token("--line", "#2c2438");
    const amber = token("--amber", "#ff9e3d");

    const created = createChart(holder.current, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: text,
        fontFamily: "var(--font-mono), ui-monospace, monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderColor: line },
      timeScale: { borderColor: line, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      handleScale: false,
      handleScroll: false,
    });

    const added = created.addSeries(LineSeries, {
      color: amber,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: { type: "price", precision: 6, minMove: 0.000001 },
    });

    chart.current = created;
    series.current = added;

    // Clicking the plot sets the threshold. The composer input stays the source
    // of truth; this only writes into it, so a mis-click is one undo away.
    const onClick = (param: { point?: { x: number; y: number } }) => {
      if (!param.point || !series.current) return;
      const price = series.current.coordinateToPrice(param.point.y);
      if (price === null || price <= 0) return;
      onThresholdRef.current?.(priceToE18(String(price)));
    };
    created.subscribeClick(onClick);

    return () => {
      created.unsubscribeClick(onClick);
      created.remove();
      chart.current = null;
      series.current = null;
      lines.current = [];
    };
  }, []);

  // --- seed history, display only -----------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function seed() {
      try {
        // Through this app's own server, not straight to the price API: ad and
        // privacy extensions block the third-party request outright, and it is
        // rate-limited per client IP.
        const response = await fetch("/api/history");
        if (!response.ok) return;
        const body = (await response.json()) as { prices?: [number, number][] };
        if (cancelled || !body.prices?.length || !series.current) return;

        for (const [ms, price] of body.prices) {
          const day = Math.floor(ms / 1000 / 86_400) * 86_400;
          if (!points.current.has(day)) points.current.set(day, price);
        }
        repaint();
      } catch {
        // A missing seed costs the chart some history and nothing else. The
        // live series is the part that matters and it does not depend on this.
      }
    }

    seed();
    return () => {
      cancelled = true;
    };
  }, []);

  const repaint = useCallback(() => {
    if (!series.current) return;
    const data = [...points.current.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([time, value]) => ({ time: time as UTCTimestamp, value }));
    if (data.length > 0) series.current.setData(data);
    setPlotted(data.length);
  }, []);

  // --- live FTSO ------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const [value, decimals] = await client.readContract({
          address: FTSOV2_ADDRESS,
          abi: FTSOV2_ABI,
          functionName: "getFeedById",
          args: [feedId],
        });
        if (cancelled) return;

        const price = Number(value) / 10 ** decimals;
        everRead.current = true;
        setLive(price);
        setFailed(false);

        // Bucketed at the poll interval rather than per minute. A per-minute
        // bucket gives a fresh chart exactly one point for its first sixty
        // seconds, and one point draws nothing, so the plot looked broken on
        // every first visit.
        points.current.set(Math.floor(Date.now() / POLL_MS) * (POLL_MS / 1000), price);
        repaint();
      } catch {
        // A failure after the first successful read leaves the last line up: a
        // gap beats a flicker, and beats vanishing mid-compose.
        if (!cancelled && !everRead.current) setFailed(true);
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [feedId, repaint]);

  // --- trigger levels -------------------------------------------------------

  useEffect(() => {
    const target = series.current;
    if (!target) return;

    for (const existing of lines.current) target.removePriceLine(existing);
    lines.current = [];

    const amber = token("--amber", "#ff9e3d");
    const dim = token("--amber-dim", "#b36b22");
    const muted = token("--muted", "#9a90ad");

    const draw = (price: number, color: string, title: string, style: LineStyle) => {
      if (!Number.isFinite(price) || price <= 0) return;
      lines.current.push(
        target.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }),
      );
    };

    draw(e18ToPrice(thresholdE18), amber, direction === "below" ? "stop" : "target", LineStyle.Dashed);
    draw(e18ToPrice(takeProfitE18), dim, "second leg", LineStyle.Dashed);
    draw(e18ToPrice(peakE18), muted, "peak", LineStyle.Dotted);
  }, [thresholdE18, takeProfitE18, peakE18, direction]);

  if (failed) return null;

  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <span className="chart-pair">{feedLabel}</span>
        <span className="chart-live">
          {live === undefined ? "reading FTSO…" : `$${live.toLocaleString(undefined, { maximumFractionDigits: 6 })}`}
        </span>
        <span className="chart-note">click to set your trigger</span>
      </figcaption>

      <div className="chart-plot">
        <div
          className="chart-canvas"
          ref={holder}
          role="img"
          aria-label={`${feedLabel} price with your trigger levels`}
        />
        {plotted < MIN_POINTS && (
          <p className="chart-empty">building the session line from live FTSO reads…</p>
        )}
      </div>

      <p className="chart-source">
        Live points are FTSOv2 reads from Coston2, polled every {POLL_MS / 1000}s. Earlier history is seeded from a
        public price API for shape only.
      </p>
    </figure>
  );
}
