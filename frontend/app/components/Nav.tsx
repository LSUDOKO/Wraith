"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Sticky navigation. Goes solid once the hero scrolls past, so the masthead
 * reads as one uninterrupted field at rest and the nav gains a surface only
 * when it is actually overlapping content.
 */
export function Nav() {
  const pathname = usePathname();
  const [lifted, setLifted] = useState(false);
  // The landing carries its own light-theme header; rendering this dark bar on
  // top of it would stack two navigations.
  const onLanding = pathname === "/";

  useEffect(() => {
    // A sentinel beats a scroll listener: no work on the main thread per frame.
    const sentinel = document.getElementById("nav-sentinel");
    if (!sentinel) return;

    const observer = new IntersectionObserver(([entry]) => setLifted(!entry.isIntersecting), {
      rootMargin: "-8px 0px 0px 0px",
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  if (onLanding) return null;

  return (
    <header className="nav" data-lifted={lifted}>
      <div className="shell nav-inner">
        <Link className="nav-mark" href="/" aria-label="Wraith home">
          <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
            <rect x="6" y="6" width="20" height="20" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <g fill="currentColor" opacity="0.9">
              <rect x="10" y="11" width="5" height="2" rx="0.6" />
              <rect x="17" y="11" width="3" height="2" rx="0.6" />
              <rect x="10" y="15" width="3" height="2" rx="0.6" />
              <rect x="15" y="15" width="6" height="2" rx="0.6" />
            </g>
          </svg>
          <span>Wraith</span>
        </Link>

        <nav className="nav-links" aria-label="Main">
          <Link className="nav-link" href="/#problem" data-active={false}>
            Why
          </Link>
          <Link className="nav-link" href="/#mechanism" data-active={false}>
            How
          </Link>
          <a
            className="nav-link"
            href="https://github.com/LSUDOKO/Wraith/blob/main/docs/TRUST.md"
            target="_blank"
            rel="noreferrer"
          >
            Trust
          </a>
          <a className="nav-link" href="https://github.com/LSUDOKO/Wraith" target="_blank" rel="noreferrer">
            Source
          </a>
        </nav>

        <Link className="nav-cta" href="/app" data-active={pathname === "/app"}>
          {pathname === "/app" ? "Orders" : "Open app"}
        </Link>
      </div>
    </header>
  );
}
