"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Lenis from "lenis";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";

/**
 * The Truus-style layer: the effects an awwwards page carries on top of its
 * scroll reveals. Smooth scroll, a pinned horizontal headline whose letters
 * tumble in, elastic sticker pops, a hand-drawn underline, a ciphertext
 * marquee, a cursor bubble, and thrown-card hover physics.
 *
 * Every hidden start state and every scroll-linked style in here goes through
 * the same gates as LandingMotion.tsx, for the same reason: Motion runs on
 * requestAnimationFrame, rAF is suspendable, and a decorative effect must never
 * be able to hide content. No painted frame → everything renders finished.
 */

/** True once the browser has proved it can paint a frame. See LandingMotion. */
function useFramePainted() {
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setPainted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return painted;
}

function useFxEnabled() {
  const painted = useFramePainted();
  const reduced = useReducedMotion();
  return painted && !reduced;
}

/** Deterministic pseudo-random in [0, 1). Seeded by index so the server and
 *  client render identical values — Math.random() here would be a hydration
 *  mismatch — and so a letter tumbles the same way on every visit. */
function prand(i: number, salt: number) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/* ── Smooth scroll ───────────────────────────────────────────────────────── */

/**
 * Lenis, gated on a painted frame — and this gate is load-bearing in a way the
 * visual ones are not. Lenis swallows wheel events and re-applies them through
 * its own rAF loop, so initialising it in an environment where rAF never fires
 * would not just skip the smoothing: it would make the page unscrollable.
 */
export function SmoothScroll() {
  const enabled = useFxEnabled();

  useEffect(() => {
    if (!enabled) return;

    const lenis = new Lenis({
      duration: 1.15,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      touchMultiplier: 1.5,
    });

    let id = requestAnimationFrame(function raf(time) {
      lenis.raf(time);
      id = requestAnimationFrame(raf);
    });

    return () => {
      cancelAnimationFrame(id);
      lenis.destroy();
    };
  }, [enabled]);

  return null;
}

/* ── Cursor bubble ───────────────────────────────────────────────────────── */

/**
 * The flame bubble that trails the cursor and pops open over anything
 * clickable. Purely additive — the native cursor stays, so if this never runs
 * nothing is lost.
 *
 * `useSpring` on x/y gives the trailing lag; a bouncier spring on scale gives
 * the elastic pop the reference gets from elastic.out.
 */
export function CursorBubble() {
  const enabled = useFxEnabled();
  const [fine, setFine] = useState(false);

  const x = useMotionValue(-100);
  const y = useMotionValue(-100);
  const sx = useSpring(x, { stiffness: 300, damping: 28 });
  const sy = useSpring(y, { stiffness: 300, damping: 28 });
  const scale = useSpring(0, { stiffness: 320, damping: 12 });
  const rotate = useSpring(-25, { stiffness: 320, damping: 14 });

  useEffect(() => {
    if (!enabled) return;
    // Touch screens have no cursor to decorate.
    const mq = window.matchMedia("(pointer: fine)");
    setFine(mq.matches);
    if (!mq.matches) return;

    const onMove = (e: MouseEvent) => {
      x.set(e.clientX + 14);
      y.set(e.clientY - 46);
    };

    // One delegated listener; the bubble opens over anything interactive.
    const onOver = (e: MouseEvent) => {
      const hit = (e.target as Element | null)?.closest?.("a, button");
      scale.set(hit ? 1 : 0);
      rotate.set(hit ? 0 : -25);
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseover", onOver, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseover", onOver);
    };
  }, [enabled, x, y, scale, rotate]);

  if (!enabled || !fine) return null;

  return (
    <motion.div className="m-cursor" style={{ x: sx, y: sy, scale, rotate }} aria-hidden="true">
      open
    </motion.div>
  );
}

/* ── Pinned horizontal headline ──────────────────────────────────────────── */

const CIPHER_WORDS = ["nothing", "to", "hunt."];

function CipherLetter({
  ch,
  i,
  n,
  progress,
  linked,
  accent,
}: {
  ch: string;
  i: number;
  n: number;
  progress: MotionValue<number>;
  linked: boolean;
  accent?: boolean;
}) {
  // Each letter finishes its tumble at its own point along the track, so the
  // word assembles left to right under the reader's scroll — the reference
  // scrubs each letter against the container animation; this is the same
  // shape with the section's progress as the container.
  const at = 0.22 + 0.68 * (i / Math.max(n - 1, 1));
  const y = useTransform(progress, [at - 0.14, at], [(prand(i, 1) - 0.5) * 240, 0]);
  const rotate = useTransform(progress, [at - 0.14, at], [(prand(i, 2) - 0.5) * 70, 0]);

  return (
    <motion.span
      className="m-letter"
      data-accent={accent || undefined}
      aria-hidden="true"
      style={linked ? { y, rotate } : undefined}
    >
      {ch}
    </motion.span>
  );
}

/**
 * The Truus signature: a viewport-high section that pins while a giant
 * headline drives through it horizontally, letters tumbling into place as they
 * arrive.
 *
 * No pinning plugin — a 300vh section with a sticky, viewport-high inner box
 * is the same mechanic in CSS, and the horizontal drive is the section's own
 * scroll progress mapped onto x. Scrubbed, not triggered: reverse the scroll
 * and the letters tumble back out.
 *
 * Under 900px the CSS collapses all of it to a plain wrapped heading —
 * `!important` on the transforms, since Motion writes them inline.
 */
export function HorizontalCipher() {
  const sectionRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const linked = useFxEnabled();

  const { scrollYProgress } = useScroll({ target: sectionRef, offset: ["start end", "end end"] });
  const smooth = useSpring(scrollYProgress, { stiffness: 75, damping: 24, restDelta: 0.001 });

  // The end of the drive depends on how wide the rendered text actually is.
  const [range, setRange] = useState({ from: 0, to: 0 });
  useEffect(() => {
    const measure = () => {
      const track = trackRef.current;
      if (!track) return;
      const vw = window.innerWidth;
      setRange({ from: vw, to: -(track.scrollWidth - vw * 0.45) });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const x = useTransform(smooth, [0.05, 1], [range.from, range.to]);

  let letterIndex = 0;
  const total = CIPHER_WORDS.join("").length;

  return (
    <section ref={sectionRef} className="m-cipher" aria-label="Nothing to hunt">
      <div className="m-cipher-pin">
        <motion.div ref={trackRef} className="m-cipher-track" style={linked ? { x } : undefined}>
          <h2 className="m-cipher-h" aria-label="nothing to hunt.">
            {CIPHER_WORDS.map((word, w) => (
              <span className="m-cipher-word" key={word}>
                {word.split("").map((ch) => {
                  const i = letterIndex++;
                  return (
                    <CipherLetter
                      key={i}
                      ch={ch}
                      i={i}
                      n={total}
                      progress={smooth}
                      linked={linked}
                      accent={ch === "."}
                    />
                  );
                })}
                {/* The sealed-order sticker rides between "to" and "hunt.",
                    tumbling in like a letter because it is indexed as one. */}
                {w === 1 && <CipherSticker i={letterIndex} n={total} progress={smooth} linked={linked} />}
              </span>
            ))}
          </h2>
        </motion.div>

        <p className="m-cipher-note">
          The chain holds your escrow and 761 bytes of ciphertext.
          <br />
          The price you would sell at is not on it.
        </p>
      </div>
    </section>
  );
}

function CipherSticker({
  i,
  n,
  progress,
  linked,
}: {
  i: number;
  n: number;
  progress: MotionValue<number>;
  linked: boolean;
}) {
  const at = 0.22 + 0.68 * (i / Math.max(n - 1, 1));
  const scale = useTransform(progress, [at - 0.14, at], [0, 1]);
  const rotate = useTransform(progress, [at - 0.14, at], [-40, -8]);

  return (
    <motion.span className="m-cipher-sticker" aria-hidden="true" style={linked ? { scale, rotate } : undefined}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
        <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
        <path d="M12 14.5v2.5" />
      </svg>
    </motion.span>
  );
}

/* ── Ciphertext marquee ──────────────────────────────────────────────────── */

/** Real bytes from a sealed order on Coston2, not lorem hex. */
const BYTES =
  "04 f6 c2 e0 87 66 f8 a3 46 ba ac d0 15 53 af 13 27 c5 ef 6f f2 59 ff f1";

const MARQUEE_ROWS = [
  ["SEALED", BYTES, "NO PLAINTEXT", BYTES],
  [BYTES, "CIPHERTEXT ONLY", BYTES, "+761 BYTES"],
];

/**
 * Two counter-scrolling rows of the thing the chain actually sees. Pure CSS
 * animation — no JS, no observer, nothing that can strand it hidden — with the
 * content doubled so the -50% translate loops seamlessly.
 */
export function ByteMarquee() {
  return (
    <div className="m-marquee" aria-hidden="true">
      {MARQUEE_ROWS.map((row, r) => (
        <div className={`m-marquee-row ${r === 1 ? "m-marquee-row-rev" : ""}`} key={r}>
          <div className="m-marquee-track">
            {[0, 1].map((dup) => (
              <span className="m-marquee-seq" key={dup}>
                {row.map((chunk, c) => (
                  <span className="m-marquee-chunk" data-word={/[A-Z]/.test(chunk) || undefined} key={c}>
                    {chunk}
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Elastic pop ─────────────────────────────────────────────────────────── */

/**
 * The sticker pop: scale and rotation snapping in on a bouncy spring, the
 * Motion equivalent of the reference's elastic.out entrances. Declares only
 * variants, so it joins whatever Stagger it sits inside and inherits its
 * parent's gate — plain render when the parent never hides.
 */
export function PopIn({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.span
      className={className}
      variants={{
        hidden: { scale: 0.2, rotate: -24, opacity: 0 },
        visible: {
          scale: 1,
          rotate: 0,
          opacity: 1,
          transition: { type: "spring", stiffness: 260, damping: 13, mass: 0.9 },
        },
      }}
    >
      {children}
    </motion.span>
  );
}

/* ── Thrown-card hover ───────────────────────────────────────────────────── */

/** Rest tilts for the six order cards — the reference deals its cards onto the
 *  table slightly rotated, which is what makes the hover straighten land. */
const TILTS = [-2.2, 1.6, -1.2, 2.1, -1.7, 1.4];

/**
 * A card that sits at a slight tilt and snaps straight, lifted and slightly
 * grown, on hover — on a spring loose enough to overshoot, which is the whole
 * "thrown" feel. whileHover needs no gate: it has no hidden state.
 */
export function TiltCard({
  children,
  className,
  index,
}: {
  children: ReactNode;
  className?: string;
  index: number;
}) {
  const tilt = TILTS[index % TILTS.length];
  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y: 40, rotate: tilt * 3 },
        visible: {
          opacity: 1,
          y: 0,
          rotate: tilt,
          transition: { type: "spring", stiffness: 90, damping: 14 },
        },
      }}
      whileHover={{ rotate: 0, scale: 1.04, y: -8 }}
      transition={{ type: "spring", stiffness: 260, damping: 15 }}
    >
      {children}
    </motion.div>
  );
}

/* ── Hand-drawn underline ────────────────────────────────────────────────── */

/**
 * A scribbled double-stroke underline that draws itself when it enters the
 * viewport, the reference's strokeDashoffset move expressed as pathLength.
 * Opacity never changes — undrawn is simply undrawn, so there is nothing a
 * dead rAF could keep hidden.
 */
export function Scribble() {
  const enabled = useFxEnabled();

  return (
    <svg className="m-scribble" viewBox="0 0 320 22" fill="none" aria-hidden="true">
      <motion.path
        d="M4 14 C 70 6, 150 4, 316 9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        initial={enabled ? { pathLength: 0 } : false}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true, amount: 0.9 }}
        transition={{ duration: 0.9, ease: "easeOut" }}
      />
      <motion.path
        d="M46 19 C 120 13, 200 12, 276 15"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        initial={enabled ? { pathLength: 0 } : false}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true, amount: 0.9 }}
        transition={{ duration: 0.9, delay: 0.25, ease: "easeOut" }}
      />
    </svg>
  );
}
