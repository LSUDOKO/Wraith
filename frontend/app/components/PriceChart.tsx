"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  LineStyle,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { createPublicClient, http, type Hex } from "viem";
import { coston2, e18ToPrice, FTSOV2_ABI, FTSOV2_ADDRESS, priceToE18 } from "@/lib/wraith";

const client = createPublicClient({ chain: coston2, transport: http() });

const POLL_MS = 10_000;
/** Candle width. FTSO ticks roughly every couple of seconds, so a minute holds
 *  enough reads to have a real open/high/low/close rather than a flat bar. */
const CANDLE_SEC = 60;

/** A candle needs a full bucket to be worth drawing. Below that the plot is
 *  blank, which reads as broken rather than as "no data yet", so the component
 *  says so in words instead. */
const MIN_CANDLES = 2;

/** How much history the plot shows. Purely a view window over candles already
 *  held, so switching is instant and costs no requests. */
const RANGES = {
  "15m": 15 * 60,
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
  all: Number.POSITIVE_INFINITY,
} as const;

type RangeKey = keyof typeof RANGES;

/**
 * Read a CSS custom property so the chart inherits the app's palette rather
 * than carrying a second, drifting one of its own.
 *
 * Resolved against a specific element rather than the document root: the app
 * section overrides these tokens on a scoped wrapper for its light theme, and
 * reading `document.documentElement` would see only the unscoped `:root`
 * values and miss that override entirely.
 */
function token(name: string, fallback: string, from?: Element | null): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(from ?? document.documentElement).getPropertyValue(name).trim();
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
 * Live FTSO price, drawn as session candles, with the order's trigger levels
 * on top.
 *
 * Every candle is built from real `getFeedById` reads polled during this visit
 * — the same oracle surface the enclave reads when it evaluates. FTSO answers
 * with a spot price per read rather than OHLC bars, so there is no history to
 * seed from truthfully: the caption says these are session candles, and the
 * chart starts empty and fills as reads come in, rather than borrowing a
 * third-party close price and presenting it as FTSO's.
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
  const series = useRef<ISeriesApi<"Candlestick">>(null);
  const lines = useRef<IPriceLine[]>([]);
  const candles = useRef<Map<number, CandlestickData<UTCTimestamp>>>(new Map());
  const onThresholdRef = useRef(onThresholdChange);

  const [live, setLive] = useState<number>();
  const [drawn, setDrawn] = useState(0);
  const [failed, setFailed] = useState(false);
  const [ohlc, setOhlc] = useState<{ o: number; h: number; l: number; c: number }>();
  const [range, setRange] = useState<RangeKey>("1h");
  /** Candle under the crosshair, shown instead of the live close while hovering. */
  const [hover, setHover] = useState<CandlestickData<UTCTimestamp>>();
  // A ref, not the `live` state: depending on state here would tear down and
  // rebuild the interval on every successful poll, doubling the read rate.
  const everRead = useRef(false);

  onThresholdRef.current = onThresholdChange;

  // --- chart lifecycle -----------------------------------------------------

  useEffect(() => {
    if (!holder.current) return;

    const text = token("--muted", "#9a90ad", holder.current);
    const line = token("--line", "#2c2438", holder.current);
    const amber = token("--amber", "#ff9e3d", holder.current);
    const dim = token("--amber-dim", "#b36b22", holder.current);
    const down = token("--error", "#ff8b7a", holder.current);

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
      rightPriceScale: { borderColor: line, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: line, timeVisible: true, secondsVisible: false },
      // A tracking crosshair with labelled axes is the difference between a
      // sparkline and something you can read a level off.
      crosshair: {
        mode: 1,
        vertLine: { color: dim, width: 1, style: LineStyle.Dotted, labelBackgroundColor: dim },
        horzLine: { color: dim, width: 1, style: LineStyle.Dotted, labelBackgroundColor: dim },
      },
      handleScale: false,
      handleScroll: false,
    });

    const added = created.addSeries(CandlestickSeries, {
      upColor: amber,
      downColor: down,
      borderUpColor: amber,
      borderDownColor: down,
      wickUpColor: amber,
      wickDownColor: down,
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

    // Reading the value under the cursor is the whole point of a crosshair, so
    // the header shows it instead of the live close while hovering.
    const onMove = (param: { point?: { x: number; y: number }; seriesData: Map<unknown, unknown> }) => {
      if (!param.point || !series.current) {
        setHover(undefined);
        return;
      }
      const at = param.seriesData.get(series.current) as CandlestickData<UTCTimestamp> | undefined;
      setHover(at);
    };
    created.subscribeCrosshairMove(onMove);

    return () => {
      created.unsubscribeClick(onClick);
      created.unsubscribeCrosshairMove(onMove);
      created.remove();
      chart.current = null;
      series.current = null;
      lines.current = [];
    };
  }, []);

  const repaint = useCallback(() => {
    if (!series.current) return;

    const all = [...candles.current.entries()].sort((a, b) => a[0] - b[0]);

    const span = RANGES[range];
    const newest = all.length > 0 ? all[all.length - 1][0] : 0;
    const windowed = Number.isFinite(span) ? all.filter(([t]) => newest - t <= span) : all;

    const data = windowed.map(([, candle]) => candle);
    series.current.setData(data);
    setDrawn(data.length);

    if (data.length > 0) {
      setOhlc({
        o: data[0].open,
        h: Math.max(...data.map((d) => d.high)),
        l: Math.min(...data.map((d) => d.low)),
        c: data[data.length - 1].close,
      });
    }
  }, [range]);

  // --- live FTSO, aggregated into session candles ---------------------------

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

        const bucket = (Math.floor(Date.now() / 1000 / CANDLE_SEC) * CANDLE_SEC) as UTCTimestamp;
        const open = candles.current.get(bucket);
        candles.current.set(bucket, {
          time: bucket,
          open: open?.open ?? price,
          high: Math.max(open?.high ?? price, price),
          low: Math.min(open?.low ?? price, price),
          close: price,
        });
        repaint();
      } catch {
        // A failure after the first successful read leaves the last candle up:
        // a gap beats a flicker, and beats the chart vanishing mid-compose.
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

    const amber = token("--amber", "#ff9e3d", holder.current);
    const dim = token("--amber-dim", "#b36b22", holder.current);
    const muted = token("--muted", "#9a90ad", holder.current);

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

  const shownClose = hover?.close ?? live;
  const shownOhlc = hover
    ? { o: hover.open, h: hover.high, l: hover.low, c: hover.close }
    : ohlc;
  const changePct = shownOhlc && shownOhlc.o > 0 ? ((shownOhlc.c - shownOhlc.o) / shownOhlc.o) * 100 : undefined;

  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <span className="chart-pair">{feedLabel}</span>
        <span className="chart-live">{shownClose === undefined ? "reading FTSO…" : `$${fmt(shownClose)}`}</span>

        {shownOhlc && (
          <span className="chart-ohlc">
            <span>
              O <b>{fmt(shownOhlc.o)}</b>
            </span>
            <span>
              H <b>{fmt(shownOhlc.h)}</b>
            </span>
            <span>
              L <b>{fmt(shownOhlc.l)}</b>
            </span>
            <span>
              C <b>{fmt(shownOhlc.c)}</b>
            </span>
            {changePct !== undefined && (
              <span className="chart-change" data-dir={changePct >= 0 ? "up" : "down"}>
                {changePct >= 0 ? "+" : ""}
                {changePct.toFixed(2)}%
              </span>
            )}
          </span>
        )}

        <span className="chart-ranges" role="group" aria-label="Chart range">
          {(Object.keys(RANGES) as RangeKey[]).map((key) => (
            <button
              key={key}
              className="chart-range"
              type="button"
              aria-pressed={range === key}
              onClick={() => setRange(key)}
            >
              {key}
            </button>
          ))}
        </span>
      </figcaption>

      <div className="chart-plot">
        <div
          className="chart-canvas"
          ref={holder}
          role="img"
          aria-label={`${feedLabel} price with your trigger levels`}
        />
        {drawn < MIN_CANDLES && (
          <p className="chart-empty">building this session's candles from live FTSO reads…</p>
        )}
      </div>

      <div className="chart-foot">
        <p className="chart-source">
          Session candles, {CANDLE_SEC / 60}m each, built live from FTSOv2 reads on Coston2 every {POLL_MS / 1000}s.
          Click the plot to set your trigger. FTSO answers with a spot price, not a bar, so there is no history to
          seed honestly — the chart starts empty and fills as this visit continues.
        </p>
      </div>
    </figure>
  );
}

/** Six decimals, because FLR trades near six thousandths of a dollar and the
 *  interesting digits are all past the fourth. */
function fmt(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
}
