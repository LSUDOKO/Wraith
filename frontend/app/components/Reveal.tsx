import type { ReactNode } from "react";

/**
 * Layout passthrough. This once ran a JS IntersectionObserver reveal, then a
 * native scroll-driven one; both held elements at opacity 0 until the animation
 * machinery reported in, and in any environment where it did not, the entire
 * page rendered blank.
 *
 * A decorative effect must never be able to hide content, so the effect is gone
 * and the element is plain. The page keeps its motion where it cannot cause
 * harm: the cipher scramble, hover states, and the hero rule.
 */
export function Reveal({
  children,
  as: Tag = "div",
  className = "",
}: {
  children: ReactNode;
  as?: "div" | "section" | "li" | "article";
  className?: string;
}) {
  return <Tag className={className || undefined}>{children}</Tag>;
}
