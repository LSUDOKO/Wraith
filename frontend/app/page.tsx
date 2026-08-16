import Link from "next/link";
import Image from "next/image";
import { Playfair_Display } from "next/font/google";
import {
  ArtFigure,
  Constellation,
  Headline,
  HeroMock,
  Reveal,
  ScrollProgress,
  Stagger,
  StaggerItem,
} from "@/app/components/LandingMotion";
import {
  ByteMarquee,
  CursorBubble,
  HorizontalCipher,
  PopIn,
  Scribble,
  SmoothScroll,
  TiltCard,
} from "@/app/components/LandingFx";
import {
  IconConsensus,
  IconCrossChain,
  IconFire,
  IconPriceStop,
  IconSeal,
  IconShield,
  IconStealthTwap,
  IconTrailing,
  IconWatch,
} from "@/app/components/LandingIcons";

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

/** Six order kinds. One card treatment for all of them: with a single accent
 *  colour the difference between them has to be carried by the words, which is
 *  the only place it was ever real. */
const KINDS = [
  {
    Icon: IconPriceStop,
    title: "Price stop",
    body: "A stop-loss or take-profit at a level nobody can read. Fires the moment FTSO crosses it.",
  },
  {
    Icon: IconTrailing,
    title: "Trailing stop",
    body: "Follows price up and never back down. The peak is public math; the trail distance is the secret.",
  },
  {
    Icon: IconStealthTwap,
    title: "Stealth TWAP",
    body: "A large order split into tranches at times and sizes derived from a sealed seed. Observers cannot predict the next release.",
  },
  {
    Icon: IconShield,
    title: "FAssets Shield",
    body: "Escape an agent whose collateral is falling, on a threshold nobody can position against.",
  },
  {
    Icon: IconCrossChain,
    title: "Cross-chain trigger",
    body: "Fires on an FDC-attested XRPL payment. The watched address travels only as its hash.",
  },
  {
    Icon: IconConsensus,
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
      <ScrollProgress />
      <SmoothScroll />
      <CursorBubble />

      {/* --- header ------------------------------------------------------- */}
      <header className="m-nav">
        <div className="m-shell m-nav-inner">
          <Link className="m-mark" href="/" aria-label="Wraith home">
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
        <HeroMock className="m-shell m-mock-wrap m-rise">
          <Image
            className="m-mock"
            src="/product-shot.png"
            alt="The Wraith orders view: six sealed orders, each showing its escrow and expiry in the clear and its condition only as raw ciphertext"
            width={1568}
            height={690}
            priority
          />
        </HeroMock>
      </section>

      {/* --- protocol strip ----------------------------------------------- */}
      <section className="m-strip" aria-label="Flare protocols Wraith runs on">
        <div className="m-shell">
          <Reveal as="p" className="m-strip-label">
            Built on <em>five</em> Flare protocols — no bridge, no trusted oracle
          </Reveal>
          <Stagger className="m-strip-row">
            {PROTOCOLS.map((p) => (
              <StaggerItem as="span" className="m-strip-item" key={p.name}>
                <strong>{p.name}</strong>
                <span>{p.note}</span>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </section>

      {/* --- the pinned headline: the claim, letter by letter --------------- */}
      <HorizontalCipher />

      {/* --- problem ------------------------------------------------------- */}
      <section className="m-section" id="why">
        <Stagger className="m-shell m-center">
          <StaggerItem as="p" className="m-eyebrow">The problem</StaggerItem>
          <Headline className="m-h1">Your stop-loss is public right now.</Headline>
          <StaggerItem as="p" className="m-lede">
            Every onchain automation protocol publishes the trigger price in the clear. It sits there for days,
            telling everyone exactly where you will be forced to sell. Pushing price into a cluster of visible stops
            is profitable arithmetic, not a conspiracy. Wraith removes the advance warning: the condition is
            encrypted in your browser and only a trusted enclave can ever read it.
          </StaggerItem>
        </Stagger>

        {/* The same ink surface carries the chart animation: black-field art
            that loops in place, reinforcing that this is a live-market story. */}
        <div className="m-shell">
          <ArtFigure className="m-art m-art-dark">
            <video
              src="/Financial_trading_chart_animating_202608141652.mp4"
              autoPlay
              muted
              loop
              playsInline
              aria-label="Animated financial chart showing a stop cluster forming as price moves"
            />
          </ArtFigure>
        </div>

      </section>

      {/* --- constellation ------------------------------------------------- */}
      <section className="m-section m-section-tight">
        <Stagger className="m-shell m-center">
          <StaggerItem as="p" className="m-eyebrow">The architecture</StaggerItem>
          <Headline className="m-h1">One secret, five moving parts.</Headline>
          <StaggerItem as="p" className="m-lede">
            Everything around your order is public and verifiable. The condition itself exists in plaintext in
            exactly one place.
          </StaggerItem>
        </Stagger>

        <div className="m-shell">
          <Constellation nodes={NODES} />
        </div>
      </section>

      {/* --- order kinds --------------------------------------------------- */}
      <section className="m-section" id="kinds">
        <Stagger className="m-shell m-center">
          <StaggerItem as="p" className="m-eyebrow">Order types</StaggerItem>
          <Headline className="m-h1">Six ways to wait in silence.</Headline>
          <StaggerItem as="p" className="m-lede">
            Every one of them is the same primitive: a condition only the enclave can read, and a settlement anyone
            can verify.
          </StaggerItem>
        </Stagger>

        <div className="m-shell m-kinds-wrap">
          <Stagger className="m-kinds" amount={0.12}>
            {KINDS.map((kind, i) => (
              <TiltCard className="m-wash" index={i} key={kind.title}>
                <PopIn className="m-wash-icon">
                  <kind.Icon />
                </PopIn>
                <h3>{kind.title}</h3>
                <p>{kind.body}</p>
              </TiltCard>
            ))}
          </Stagger>
        </div>
      </section>

      {/* --- what the chain sees, on a loop --------------------------------- */}
      <ByteMarquee />

      {/* --- how it works -------------------------------------------------- */}
      <section className="m-section" id="how">
        <Stagger className="m-shell m-center">
          <StaggerItem as="p" className="m-eyebrow">How it works</StaggerItem>
          <Headline className="m-h1">Seal. Watch. Fire.</Headline>
          <Scribble />
        </Stagger>

        <Stagger className="m-shell m-steps" amount={0.15}>
          <StaggerItem className="m-step-card">
            <PopIn className="m-step-art">
              <IconSeal />
              <span className="m-step-dot">1</span>
            </PopIn>
            <h3>Seal</h3>
            <p>
              Your condition is ECIES-encrypted in your own browser and stored onchain as bytes. The chain holds
              ciphertext and escrow. It never holds your trigger price.
            </p>
          </StaggerItem>

          <StaggerItem className="m-step-card">
            <PopIn className="m-step-art">
              <IconWatch />
              <span className="m-step-dot">2</span>
            </PopIn>
            <h3>Watch</h3>
            <p>
              A keeper pokes the order on a schedule. Inside the enclave the TEE decrypts it and reads FTSO itself,
              so the keeper forwards bytes it cannot read and cannot lie about a price it never supplied.
            </p>
          </StaggerItem>

          <StaggerItem className="m-step-card">
            <PopIn className="m-step-art">
              <IconFire />
              <span className="m-step-dot">3</span>
            </PopIn>
            <h3>Fire</h3>
            <p>
              When the condition is met, the enclave signs a settlement. The contract checks that signature against
              Flare&apos;s TEE registry, consumes the action id so it cannot replay, then swaps or redeems FXRP to
              native XRP.
            </p>
          </StaggerItem>
        </Stagger>

        <div className="m-shell">
          <ArtFigure className="m-art m-art-dark">
            <video
              src="/please_remove_the_aboe_title_f.mp4"
              autoPlay
              muted
              loop
              playsInline
              aria-label="Animated walkthrough of the seal, watch and fire lifecycle"
            />
          </ArtFigure>
        </div>
      </section>

      {/* --- honesty -------------------------------------------------------- */}
      <section className="m-section m-section-tight">
        <div className="m-shell">
          <Stagger className="m-honest" amount={0.3}>
            <StaggerItem as="p" className="m-eyebrow">What we do not claim</StaggerItem>
            <Headline className="m-h2">Wraith hides intent, not execution.</Headline>
            <StaggerItem as="p">
              Once a trigger fires, the resulting trade is an ordinary public transaction, as exposed to
              execution-moment MEV as any other. The narrower claim is the one that holds: the condition was never
              public, so it could never be hunted. Every assumption behind that is written down rather than glossed
              over.
            </StaggerItem>
            <StaggerItem>
              <a
                className="m-inline-link"
                href="https://github.com/LSUDOKO/Wraith/blob/main/docs/TRUST.md"
                target="_blank"
                rel="noreferrer"
              >
                Read every assumption <span aria-hidden="true">→</span>
              </a>
            </StaggerItem>
          </Stagger>
        </div>
      </section>

      {/* --- CTA ------------------------------------------------------------ */}
      <section className="m-section">
        <div className="m-shell">
          <Stagger className="m-cta" amount={0.3}>
            <StaggerItem as="p" className="m-eyebrow">Live on Coston2</StaggerItem>
            <Headline className="m-cta-title">Set a stop nobody can see.</Headline>
            <StaggerItem as="p" className="m-cta-sub">
              Running on Coston2 against live FTSO feeds. Testnet only: Flare Confidential Compute is itself
              pre-release, so do not put real funds behind it.
            </StaggerItem>
            <StaggerItem>
              <Link className="m-btn m-btn-flame" href="/app">
                Open the app
              </Link>
            </StaggerItem>
            {CONTRACT && (
              <StaggerItem as="p" className="m-cta-contract">
                <a
                  href={`https://coston2.testnet.flarescan.com/address/${CONTRACT}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {CONTRACT.slice(0, 10)}…{CONTRACT.slice(-8)}
                </a>
              </StaggerItem>
            )}
          </Stagger>
        </div>
      </section>

      {/* --- footer --------------------------------------------------------- */}
      <footer className="m-footer">
        <div className="m-shell m-footer-inner">
          <span className="m-mark m-mark-footer">
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
