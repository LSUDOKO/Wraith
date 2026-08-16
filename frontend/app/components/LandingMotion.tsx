"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  motion,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  type Variants,
} from "motion/react";

/**
 * Scroll motion for the landing, built on Motion for React.
 *
 * Two kinds of thing live here, and the docs' split is the right one to keep in
 * mind while reading it:
 *
 *   scroll-triggered — fires once when an element enters the viewport
 *                      (`whileInView`). Every reveal and stagger below.
 *   scroll-linked    — a value wired directly to scroll position
 *                      (`useScroll` + `useTransform`). The progress rail, the
 *                      constellation's edge draw, the parallax on the figures.
 *
 * ---------------------------------------------------------------------------
 * The one rule this file exists to respect
 *
 * A decorative effect must never be able to hide content. Motion renders
 * `initial` on the server, so `initial={{ opacity: 0 }}` ships opacity-0 in the
 * HTML — and if hydration fails, or the bundle 404s, or requestAnimationFrame
 * is suspended, the page stays blank. That is not hypothetical here: it is
 * documented in Reveal.tsx as something this project already shipped and tore
 * back out, and it happened again during development under a throttled tab.
 *
 * So `initial` is gated on `useFramePainted()`. The server sends plain, visible
 * markup, and the hidden start state is only ever applied once the browser has
 * proved it can paint — so whatever hides an element is guaranteed to have a
 * clock that can reveal it again. Everything animated here sits below the fold,
 * so the one frame between paint and reveal is not on screen.
 */

/**
 * True once the browser has actually painted a frame.
 *
 * The gate is `requestAnimationFrame`, not `useEffect`, and the difference is
 * the whole point. An effect proves React hydrated; it does not prove anything
 * can animate. Motion drives every tween off rAF, and there are real conditions
 * where rAF is suspended while React is otherwise perfectly alive — occluded
 * windows, background tabs, headless capture. Gating on an effect would apply
 * the hidden start state in exactly those cases and then have no clock to undo
 * it with.
 *
 * Asking rAF itself is the one check that cannot be wrong: if the callback
 * never fires, nothing is ever hidden.
 */
function useFramePainted() {
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setPainted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return painted;
}

/** Whether a scroll-linked style may be attached at all.
 *  Same reasoning as `useSafeInitial`, for the other half of the API: a
 *  `useScroll`-derived value that never advances is frozen at its start, and a
 *  start of `pathLength: 0` or `opacity: 0.5` is just a quieter way of hiding
 *  something. No painted frame means no scroll-linked style, so those elements
 *  render at their natural, finished state. */
function useScrollLinked() {
  const painted = useFramePainted();
  const reduced = useReducedMotion();
  return painted && !reduced;
}

/** `initial` for a scroll reveal, or `false` to render the element plainly.
 *  Reduced motion takes the plain branch: none of this carries information, so
 *  the correct reduced amount is none of it. */
function useSafeInitial() {
  const painted = useFramePainted();
  const reduced = useReducedMotion();
  return painted && !reduced ? "hidden" : false;
}

const EASE = [0.16, 1, 0.3, 1] as const;

const group: Variants = {
  hidden: {},
  // The gap between neighbours is deliberately short. Six cards at 0.15s each
  // take nearly a second to finish, which reads as the page being slow rather
  // than as choreography.
  visible: { transition: { staggerChildren: 0.07, delayChildren: 0.04 } },
};

const item: Variants = {
  hidden: { opacity: 0, y: 28 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.7, ease: EASE } },
};

/** A line of type rising out of its own clipped box. */
const mask: Variants = {
  hidden: { y: "115%" },
  visible: { y: "0%", transition: { duration: 0.85, ease: EASE } },
};

type Tag = "div" | "span" | "p" | "section" | "figure";

const TAGS = {
  div: motion.div,
  span: motion.span,
  p: motion.p,
  section: motion.section,
  figure: motion.figure,
} as const;

/** A stagger parent. Children marked `StaggerItem` arrive in sequence when the
 *  parent crosses into view — one observer for the group, not one per child. */
export function Stagger({
  children,
  className,
  as = "div",
  amount = 0.2,
}: {
  children: ReactNode;
  className?: string;
  as?: Tag;
  amount?: number;
}) {
  const Component = TAGS[as];
  const safeInitial = useSafeInitial();
  return (
    <Component
      className={className}
      variants={group}
      initial={safeInitial}
      whileInView="visible"
      viewport={{ once: true, amount }}
    >
      {children}
    </Component>
  );
}

/** One member of a stagger. Carries the real class, so no wrapper element is
 *  inserted into a grid or flex row that is counting its children. */
export function StaggerItem({
  children,
  className,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: Tag;
}) {
  const Component = TAGS[as];
  return (
    <Component className={className} variants={item}>
      {children}
    </Component>
  );
}

/** A standalone reveal for a block with no siblings to stagger against. */
export function Reveal({
  children,
  className,
  as = "div",
  amount = 0.2,
}: {
  children: ReactNode;
  className?: string;
  as?: Tag;
  amount?: number;
}) {
  const Component = TAGS[as];
  const safeInitial = useSafeInitial();
  return (
    <Component
      className={className}
      variants={item}
      initial={safeInitial}
      whileInView="visible"
      viewport={{ once: true, amount }}
    >
      {children}
    </Component>
  );
}

/** A section title whose lines rise out of a clipped box. Belongs inside a
 *  `Stagger`, which supplies the timing. */
export function Headline({
  children,
  className,
  as = "h2",
}: {
  children: ReactNode;
  className?: string;
  as?: "h1" | "h2";
}) {
  const Tag = as;
  return (
    <Tag className={className}>
      <span className="m-mask">
        <motion.span className="m-mask-line" variants={mask}>
          {children}
        </motion.span>
      </span>
    </Tag>
  );
}

/**
 * The reading rail: a flame hairline across the top of the viewport whose
 * scaleX is the page's scroll progress.
 *
 * Spring-smoothed rather than raw. A bare progress value tracks a trackpad's
 * jitter exactly, and the honest readout of a noisy input looks like a broken
 * one.
 */
export function ScrollProgress() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 120, damping: 30, restDelta: 0.001 });
  const reduced = useReducedMotion();

  if (reduced) return null;

  return <motion.div className="m-progress" style={{ scaleX }} aria-hidden="true" />;
}

/**
 * Scroll-linked framing for the two video figures: each settles from slightly
 * small and slightly dim to full size as it crosses the lower half of the
 * viewport.
 *
 * Linked rather than triggered on purpose — it is tied to scroll position, so
 * reversing direction reverses the effect instead of stranding a figure
 * mid-transform.
 */
export function ArtFigure({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLElement>(null);
  const linked = useScrollLinked();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "center center"] });
  const scale = useTransform(scrollYProgress, [0, 1], [0.94, 1]);
  const opacity = useTransform(scrollYProgress, [0, 0.6], [0.5, 1]);

  return (
    <motion.figure ref={ref} className={className} style={linked ? { scale, opacity } : undefined}>
      {children}
    </motion.figure>
  );
}

/**
 * The hero screenshot, drifting up a little as the page scrolls under it.
 *
 * The shot already overlaps the fold by a negative margin; this deepens that
 * overlap as you scroll instead of letting the image travel at exactly the
 * speed of everything around it. Small on purpose — the hero is not the place
 * for a large effect.
 */
export function HeroMock({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const linked = useScrollLinked();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], [0, -70]);

  return (
    <div ref={ref} className={className}>
      <motion.div style={linked ? { y } : undefined}>{children}</motion.div>
    </div>
  );
}

/**
 * The constellation, drawing itself against scroll position.
 *
 * The edges are the scroll-linked part: `pathLength` runs 0 → 1 as the graph
 * crosses the viewport, so the diagram assembles under the reader's own scroll
 * rather than playing at them. The nodes are scroll-triggered on top of it,
 * because a card either exists or it does not — there is no half-drawn card the
 * way there is a half-drawn line.
 */
export function Constellation({
  nodes,
}: {
  nodes: ReadonlyArray<{ accent: string; title: string; meta: string; x: number; y: number }>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const linked = useScrollLinked();
  const safeInitial = useSafeInitial();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 0.9", "center 0.55"] });
  const drawn = useSpring(scrollYProgress, { stiffness: 90, damping: 26, restDelta: 0.001 });

  // Endpoints match the node coordinates exactly: the SVG spans the same box the
  // nodes are positioned in, so an edge always meets the centre of its card.
  const edges = ["M6 38 L25 8", "M25 8 L44 44", "M44 44 L64 10", "M44 44 L66 66", "M44 44 L84 34"];

  // `.m-graph` is both the stagger parent and the positioning context. Wrapping
  // the nodes in an extra element would have been tidier to read and wrong to
  // ship: the nodes are absolutely positioned against this box, and on mobile
  // the same box becomes a plain stacked grid. An intermediate div breaks both.
  return (
    <motion.div
      ref={ref}
      className="m-graph"
      role="img"
      aria-label="How an order flows from your browser through the enclave to settlement"
      variants={group}
      initial={safeInitial}
      whileInView="visible"
      viewport={{ once: true, amount: 0.35 }}
    >
      <svg className="m-graph-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {edges.map((d) => (
          // pathLength="1" normalises every edge to a unit length, so the draw
          // survives a viewBox stretched by preserveAspectRatio="none".
          <motion.path key={d} d={d} pathLength={1} style={linked ? { pathLength: drawn } : undefined} />
        ))}
      </svg>

      {nodes.map((node) => (
        <motion.div
          className="m-node"
          data-accent={node.accent}
          key={node.title}
          // The centring offset has to travel through Motion rather than stay in
          // CSS: Motion writes the whole `transform` when it animates scale, so
          // a stylesheet `translate(-50%, -50%)` would simply be overwritten and
          // every card would hang off its own coordinate.
          style={{ left: `${node.x}%`, top: `${node.y}%`, x: "-50%", y: "-50%" }}
          variants={{
            hidden: { opacity: 0, scale: 0.88 },
            visible: { opacity: 1, scale: 1, transition: { duration: 0.5, ease: EASE } },
          }}
        >
          <strong>{node.title}</strong>
          <span>{node.meta}</span>
        </motion.div>
      ))}
    </motion.div>
  );
}
