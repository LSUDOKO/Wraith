import Link from "next/link";
import Image from "next/image";
import { Playfair_Display } from "next/font/google";

// The landing's display face. Playfair 800/900 stands in for a chunky
// editorial serif; the product UI keeps Archivo, so the magazine-cover /
// workhorse contrast is the typographic identity of the page.
const display = Playfair_Display({
  subsets: ["latin"],
  weight: ["700", "800", "900"],
  variable: "--font-display",
});

const CONTRACT = process.env.NEXT_PUBLIC_WRAITH_ADDRESS ?? "";

/** The Flare surface area, named plainly. Text marks, not invented logos. */
const PROTOCOLS = [
  { name: "FTSOv2", note: "block-latency prices" },
  { name: "FDC", note: "attested facts" },
  { name: "FAssets", note: "FXRP settlement" },
  { name: "FCC", note: "confidential compute" },
  { name: "Coston2", note: "testnet" },
];

/** Six order kinds, six pastel washes. The wash carries the block; the icon is
 *  a small categorical marker on top of it, not the subject. */
const KINDS = [
  {
    wash: "mint",
    icon: "/art/kind-price.png",
    title: "Price stop",
    body: "A stop-loss or take-profit at a level nobody can read. Fires the moment FTSO crosses it.",
  },
  {
    wash: "peach",
    icon: "/art/kind-trailing.png",
    title: "Trailing stop",
    body: "Follows price up and never back down. The peak is public math; the trail distance is the secret.",
  },
  {
    wash: "lavender",
    icon: "/art/kind-stealth.png",
    title: "Stealth TWAP",
    body: "A large order split into tranches at times and sizes derived from a sealed seed. Observers cannot predict the next release.",
  },
  {
    wash: "teal",
    icon: "/art/kind-shield.png",
    title: "FAssets Shield",
    body: "Escape an agent whose collateral is falling, on a threshold nobody can position against.",
  },
  {
    wash: "peach",
    icon: "/art/kind-crosschain.png",
    title: "Cross-chain trigger",
    body: "Fires on an FDC-attested XRPL payment. The watched address travels only as its hash.",
  },
  {
    wash: "mint",
    icon: "/art/kind-consensus.png",
    title: "Consensus order",
    body: "Settles only when FTSO and an attested off-chain price both agree. One feed alone cannot move your stop.",
  },
];

/** The constellation: what touches an order, and what each part can see. */
const NODES = [
  { accent: "azure", title: "Your browser", meta: "seals the condition with ECIES", x: 6, y: 38 },
  { accent: "orchid", title: "Onchain ciphertext", meta: "escrow plus unreadable bytes", x: 25, y: 8 },
  { accent: "teal", title: "TEE enclave", meta: "decrypts, reads, decides", x: 44, y: 44 },
  { accent: "coral", title: "FTSO", meta: "prices read inside the enclave", x: 64, y: 10 },
  { accent: "amber", title: "FDC", meta: "cross-chain facts, verified onchain", x: 66, y: 66 },
  { accent: "ink", title: "Settlement", meta: "swap, or redeem FXRP to XRP", x: 84, y: 34 },
];

export default function Landing() {
  return (
    <main className={`m-root ${display.variable}`}>
      {/* --- header ------------------------------------------------------- */}
      <header className="m-nav">
        <div className="m-shell m-nav-inner">
          <Link className="m-mark" href="/" aria-label="Wraith home">
            <Image src="/wraith-logo.svg" alt="" width={26} height={33} priority />
            <span>Wraith</span>
          </Link>

          <nav className="m-nav-pills" aria-label="Main">
            <a className="m-pill" href="#why">
              Why
            </a>
            <a className="m-pill" href="#kinds">
              Orders
            </a>
            <a className="m-pill" href="#how">
              How
            </a>
            <a
              className="m-pill"
              href="https://github.com/LSUDOKO/Wraith/blob/main/docs/TRUST.md"
              target="_blank"
              rel="noreferrer"
            >
              Trust
            </a>
            <a className="m-pill" href="https://github.com/LSUDOKO/Wraith" target="_blank" rel="noreferrer">
              Source
            </a>
          </nav>

          <Link className="m-btn m-btn-dark" href="/app">
            Open app
          </Link>
        </div>
      </header>

      {/* --- hero: the one saturated viewport ----------------------------- */}
      <section className="m-hero">
        <div className="m-shell m-hero-stack">
          <p className="m-eyebrow-pill m-rise" style={{ animationDelay: "0ms" }}>
            <Image src="/wraith-logo.svg" alt="" width={12} height={15} />
            Built on Flare Confidential Compute
          </p>

          <h1 className="m-display m-rise" style={{ animationDelay: "80ms" }}>
            Orders that never
            <br />
            announce themselves.
          </h1>

          <p className="m-hero-sub m-rise" style={{ animationDelay: "160ms" }}>
            Your trigger is encrypted to a trusted enclave. The chain sees only ciphertext, so there is nothing to
            hunt.
          </p>

          <div className="m-hero-actions m-rise" style={{ animationDelay: "240ms" }}>
            <Link className="m-btn m-btn-dark" href="/app">
              Launch Wraith
            </Link>
            <a
              className="m-btn m-btn-white"
              href="https://github.com/LSUDOKO/Wraith/blob/main/docs/TRUST.md"
              target="_blank"
              rel="noreferrer"
            >
              Trust model
            </a>
          </div>
        </div>

        {/* The product is the hero: a live screenshot overlapping the fold. */}
        <div className="m-shell m-mock-wrap m-rise" style={{ animationDelay: "320ms" }}>
          <Image
            className="m-mock"
            src="/product-shot.jpg"
            alt="The Wraith order composer: live FTSO chart, sealed orders, and the enclave status bar"
            width={1568}
            height={776}
            priority
          />
        </div>
      </section>

      {/* --- protocol strip ----------------------------------------------- */}
      <section className="m-strip" aria-label="Flare protocols Wraith runs on">
        <div className="m-shell m-strip-row">
          {PROTOCOLS.map((p) => (
            <span className="m-strip-item" key={p.name}>
              <strong>{p.name}</strong>
              <span>{p.note}</span>
            </span>
          ))}
        </div>
      </section>

      {/* --- problem ------------------------------------------------------- */}
      <section className="m-section" id="why">
        <div className="m-shell m-center">
          <h2 className="m-h1">
            Your stop-loss is public right now.
          </h2>
          <p className="m-lede">
            Every onchain automation protocol publishes the trigger price in the clear. It sits there for days,
            telling everyone exactly where you will be forced to sell. Pushing price into a cluster of visible stops
            is profitable arithmetic, not a conspiracy. Wraith removes the advance warning: the condition is
            encrypted in your browser and only a trusted enclave can ever read it.
          </p>
        </div>

        {/* The art is black-field, so it sits on its own ink surface rather than
            on the paper canvas. A card keeps the page's light theme intact: a
            whole section flipping to dark mid-scroll reads as a different site. */}
        <div className="m-shell">
          <figure className="m-art m-art-dark">
            <Image
              src="/art/hunted.png"
              alt="A dense cluster of resting stop orders lit up on a dark field, with a single laser sight converging on it"
              width={1600}
              height={900}
              sizes="(max-width: 900px) 100vw, 1200px"
            />
          </figure>
        </div>
      </section>

      {/* --- constellation ------------------------------------------------- */}
      <section className="m-section m-section-tight">
        <div className="m-shell m-center">
          <h2 className="m-h1">
            One secret, five moving parts.
          </h2>
          <p className="m-lede">
            Everything around your order is public and verifiable. The condition itself exists in plaintext in
            exactly one place.
          </p>
        </div>

        <div className="m-shell">
          <div className="m-graph" role="img" aria-label="How an order flows from your browser through the enclave to settlement">
            {/* Line endpoints share the node coordinates exactly: the SVG spans
                the same box the nodes are positioned in, so an edge always meets
                the centre of its card. */}
            <svg className="m-graph-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <path d="M6 38 L25 8" />
              <path d="M25 8 L44 44" />
              <path d="M44 44 L64 10" />
              <path d="M44 44 L66 66" />
              <path d="M44 44 L84 34" />
            </svg>

            {NODES.map((node) => (
              <div
                className="m-node"
                data-accent={node.accent}
                key={node.title}
                style={{ left: `${node.x}%`, top: `${node.y}%` }}
              >
                <strong>{node.title}</strong>
                <span>{node.meta}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* --- order kinds --------------------------------------------------- */}
      <section className="m-section" id="kinds">
        <div className="m-shell m-center">
          <h2 className="m-h1">
            Six ways to wait in silence.
          </h2>
        </div>

        <div className="m-shell m-kinds">
          {KINDS.map((kind) => (
            <div className={`m-wash m-wash-${kind.wash}`} key={kind.title}>
              <Image className="m-wash-icon" src={kind.icon} alt="" width={40} height={40} />
              <h3>{kind.title}</h3>
              <p>{kind.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* --- how it works -------------------------------------------------- */}
      <section className="m-section" id="how">
        <div className="m-shell m-center">
          <h2 className="m-h1">
            Seal. Watch. Fire.
          </h2>
        </div>

        <div className="m-shell m-steps">
          <div className="m-step-card">
            <span className="m-step-art" data-accent="azure">
              <Image src="/art/step-seal.png" alt="" width={72} height={72} />
              <span className="m-step-dot">1</span>
            </span>
            <h3>Seal</h3>
            <p>
              Your condition is ECIES-encrypted in your own browser and stored onchain as bytes. The chain holds
              ciphertext and escrow. It never holds your trigger price.
            </p>
          </div>

          <div className="m-step-card">
            <span className="m-step-art" data-accent="teal">
              <Image src="/art/step-watch.png" alt="" width={72} height={72} />
              <span className="m-step-dot">2</span>
            </span>
            <h3>Watch</h3>
            <p>
              A keeper pokes the order on a schedule. Inside the enclave the TEE decrypts it and reads FTSO itself,
              so the keeper forwards bytes it cannot read and cannot lie about a price it never supplied.
            </p>
          </div>

          <div className="m-step-card">
            <span className="m-step-art" data-accent="coral">
              <Image src="/art/step-fire.png" alt="" width={72} height={72} />
              <span className="m-step-dot">3</span>
            </span>
            <h3>Fire</h3>
            <p>
              When the condition is met, the enclave signs a settlement. The contract checks that signature against
              Flare&apos;s TEE registry, consumes the action id so it cannot replay, then swaps or redeems FXRP to
              native XRP.
            </p>
          </div>
        </div>
      </section>

      {/* --- honesty -------------------------------------------------------- */}
      <section className="m-section m-section-tight">
        <div className="m-shell">
          <div className="m-honest">
            <h2 className="m-h2">Wraith hides intent, not execution.</h2>
            <p>
              Once a trigger fires, the resulting trade is an ordinary public transaction, as exposed to
              execution-moment MEV as any other. The narrower claim is the one that holds: the condition was never
              public, so it could never be hunted. Every assumption behind that is written down rather than glossed
              over.
            </p>
            <a
              className="m-inline-link"
              href="https://github.com/LSUDOKO/Wraith/blob/main/docs/TRUST.md"
              target="_blank"
              rel="noreferrer"
            >
              Read every assumption <span aria-hidden="true">→</span>
            </a>
          </div>
        </div>
      </section>

      {/* --- CTA ------------------------------------------------------------ */}
      <section className="m-section">
        <div className="m-shell">
          <div className="m-cta">
            <h2 className="m-cta-title">Set a stop nobody can see.</h2>
            <p className="m-cta-sub">
              Running on Coston2 against live FTSO feeds. Testnet only: Flare Confidential Compute is itself
              pre-release, so do not put real funds behind it.
            </p>
            <Link className="m-btn m-btn-white" href="/app">
              Open the app
            </Link>
            {CONTRACT && (
              <p className="m-cta-contract">
                <a
                  href={`https://coston2.testnet.flarescan.com/address/${CONTRACT}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {CONTRACT.slice(0, 10)}…{CONTRACT.slice(-8)}
                </a>
              </p>
            )}
          </div>
        </div>
      </section>

      {/* --- footer --------------------------------------------------------- */}
      <footer className="m-footer">
        <div className="m-shell m-footer-inner">
          <span className="m-mark m-mark-footer">
            <Image src="/wraith-logo.svg" alt="" width={20} height={25} />
            <span>Wraith</span>
          </span>
          <nav className="m-footer-links" aria-label="Footer">
            <a href="https://github.com/LSUDOKO/Wraith" target="_blank" rel="noreferrer">
              Source
            </a>
            <a
              href="https://github.com/LSUDOKO/Wraith/blob/main/docs/TRUST.md"
              target="_blank"
              rel="noreferrer"
            >
              Trust assumptions
            </a>
            <a href="https://dev.flare.network/fcc/overview" target="_blank" rel="noreferrer">
              Flare Confidential Compute
            </a>
          </nav>
          <span className="m-footer-note">Coston2 testnet</span>
        </div>
      </footer>
    </main>
  );
}
