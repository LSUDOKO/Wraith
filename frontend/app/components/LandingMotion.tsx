"use client";

import { useEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/**
 * Scroll motion for everything below the hero.
 *
 * The hard rule this file exists to respect: a decorative effect must never be
 * able to hide content. An earlier reveal in this codebase parked elements at
 * `opacity: 0` in the stylesheet and waited for JS to release them — when the
 * observer never reported in, the page rendered blank. So nothing here declares
 * a hidden state in CSS. Every tween is `gsap.from()`, which writes the start
 * state at runtime and only after GSAP is already running: no script, no
 * animation, content simply present.
 *
 * The hero is deliberately untouched — it keeps its own CSS `m-rise` load
 * sequence, which fires immediately rather than on scroll.
 */
export function LandingMotion() {
  useEffect(() => {
    // Honour the OS setting rather than dialling the motion down: none of this
    // carries information, so the correct reduced-motion amount is zero.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    gsap.registerPlugin(ScrollTrigger);

    const ctx = gsap.context(() => {
      const rise = (target: gsap.TweenTarget, vars: gsap.TweenVars = {}) =>
        gsap.from(target, {
          opacity: 0,
          y: 28,
          duration: 0.8,
          ease: "power3.out",
          ...vars,
        });

      // Section headers: eyebrow, title and lede move as one small cascade so
      // the block reads as a unit arriving, not three things racing.
      gsap.utils.toArray<HTMLElement>(".m-section .m-center").forEach((block) => {
        rise(block.children, {
          stagger: 0.08,
          scrollTrigger: { trigger: block, start: "top 85%" },
        });
      });

      // Protocol chips: label, then a short stagger left-to-right in reading
      // order. The row itself is never animated, only its children — nesting
      // one fade inside another double-dips the opacity and looks muddy.
      rise(".m-strip-label", {
        y: 14,
        duration: 0.6,
        scrollTrigger: { trigger: ".m-strip-label", start: "top 90%" },
      });

      rise(".m-strip-item", {
        y: 18,
        duration: 0.6,
        stagger: 0.06,
        scrollTrigger: { trigger: ".m-strip-row", start: "top 88%" },
      });

      // Card grids. The gap between neighbours is deliberately small — six
      // cards at 0.15s each would take a second to finish, which reads as the
      // page being slow rather than as choreography.
      [".m-kinds", ".m-steps"].forEach((grid) => {
        rise(`${grid} > *`, {
          y: 32,
          stagger: 0.07,
          scrollTrigger: { trigger: grid, start: "top 82%" },
        });
      });

      // The constellation draws itself: edges first, then the nodes they
      // connect. `pathLength="1"` on each path normalises the dash maths, which
      // a viewBox with preserveAspectRatio="none" would otherwise distort.
      const graph = document.querySelector(".m-graph");
      if (graph) {
        const tl = gsap.timeline({ scrollTrigger: { trigger: graph, start: "top 78%" } });
        tl.from(".m-graph-lines path", {
          strokeDasharray: 1,
          strokeDashoffset: 1,
          duration: 0.9,
          stagger: 0.12,
          ease: "power2.inOut",
        }).from(
          ".m-node",
          { opacity: 0, scale: 0.9, duration: 0.5, stagger: 0.08, ease: "back.out(1.6)" },
          "-=0.6",
        );
      }

      // The two video figures get a slow scrubbed drift. Scrubbed rather than
      // triggered: it is tied to scroll position, so it cannot leave a figure
      // mid-transform if the user reverses direction.
      gsap.utils.toArray<HTMLElement>(".m-art").forEach((art) => {
        gsap.fromTo(
          art,
          { scale: 0.96 },
          {
            scale: 1,
            ease: "none",
            scrollTrigger: { trigger: art, start: "top 90%", end: "top 45%", scrub: 0.6 },
          },
        );
      });

      rise(".m-honest", { scrollTrigger: { trigger: ".m-honest", start: "top 85%" } });
      rise(".m-cta > *", {
        stagger: 0.08,
        scrollTrigger: { trigger: ".m-cta", start: "top 85%" },
      });
    });

    // Watchdog. `gsap.from` writes its start state (opacity 0) the moment the
    // tween is built, and only unwinds it once the ticker runs — and the ticker
    // is requestAnimationFrame, which some environments suspend outright:
    // occluded windows, background tabs, headless capture. There the page would
    // sit at opacity 0 forever, which is the exact failure this project already
    // shipped once and tore back out.
    //
    // setTimeout keeps firing where rAF does not, so it can ask the one question
    // rAF cannot answer about itself: has a single frame been drawn? If not, the
    // animations are never going to run, and reverting the context restores
    // every element to its plain, visible state.
    const startFrame = gsap.ticker.frame;
    const watchdog = window.setTimeout(() => {
      if (gsap.ticker.frame === startFrame) ctx.revert();
    }, 2500);

    return () => {
      window.clearTimeout(watchdog);
      ctx.revert();
    };
  }, []);

  return null;
}
