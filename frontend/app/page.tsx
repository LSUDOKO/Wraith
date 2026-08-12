import Link from "next/link";
import { Ticker } from "@/app/components/Ticker";
import { Reveal } from "@/app/components/Reveal";
import { SealedVisual } from "@/app/components/SealedVisual";

const CONTRACT = process.env.NEXT_PUBLIC_WRAITH_ADDRESS ?? "";

export default function Landing() {
  return (
    <main>
      <div id="nav-sentinel" aria-hidden="true" />

      {/* Hero — asymmetric by design: the argument sits left, the artifact right. */}
      <section className="hero">
        <div className="shell hero-inner">
          <div className="hero-copy">
            <p className="eyebrow">Flare Coston2 · Confidential Compute</p>
            <h1 className="hero-title">
              Your stop-loss is
              <br />
              <span className="hero-strike">public</span> right now.
            </h1>
            <p className="hero-body">
              Every onchain automation protocol publishes your trigger price in the clear. It sits there for days,
              telling everyone exactly where you will be forced to sell. Wraith encrypts the condition to a trusted
              enclave, so there is nothing to hunt.
            </p>
            <div className="hero-actions">
              <Link className="btn btn-primary" href="/app">
                Seal an order
              </Link>
              <a
                className="btn btn-ghost"
                href="https://github.com/LSUDOKO/Wraith/blob/main/docs/TRUST.md"
                target="_blank"
                rel="noreferrer"
              >
                Read the trust model
              </a>
            </div>
          </div>

          <SealedVisual />
        </div>
      </section>

      <Ticker />

      {/* The problem — one long-form column against deliberate empty space. */}
      <section className="band" id="problem">
        <div className="shell band-inner">
          <Reveal className="band-label">
            <span className="rule" aria-hidden="true" />
            <span>The problem</span>
          </Reveal>

          <div className="band-body">
            <Reveal as="div">
              <h2 className="band-title">Stop-loss hunting is not a conspiracy. It is arithmetic.</h2>
            </Reveal>
            <Reveal as="div" delay={80}>
              <p className="band-text">
                A resting stop order is a public commitment to sell at a known price. Anyone reading the chain can
                see the level, the size, and who owns it. Pushing price into a cluster of stops is profitable
                precisely because the cluster is visible.
              </p>
            </Reveal>
            <Reveal as="div" delay={160}>
              <p className="band-text">
                Traders have exactly two defences today. Keep the stop on a centralised exchange and accept custody
                risk, or keep it in your head and accept that you will be asleep when it matters. Neither is a good
                trade.
              </p>
            </Reveal>
          </div>
        </div>
      </section>

      {/* Mechanism — offset stagger, deliberately not three equal cards. */}
      <section className="band band-alt" id="mechanism">
        <div className="shell">
          <Reveal className="band-label">
            <span className="rule" aria-hidden="true" />
            <span>How it works</span>
          </Reveal>

          <ol className="steps">
            <Reveal as="li" className="step">
              <span className="step-no">01</span>
              <div>
                <h3 className="step-title">Seal</h3>
                <p className="step-text">
                  Your condition is ECIES-encrypted in your own browser and stored onchain as bytes. The chain holds
                  ciphertext and escrow. It never holds your trigger price.
                </p>
              </div>
            </Reveal>

            <Reveal as="li" className="step step-offset" delay={90}>
              <span className="step-no">02</span>
              <div>
                <h3 className="step-title">Watch</h3>
                <p className="step-text">
                  A keeper pokes the order on a schedule. Inside the enclave the TEE decrypts it and reads FTSO
                  itself — so the keeper forwards bytes it cannot read, and cannot lie about the price it did not
                  supply.
                </p>
              </div>
            </Reveal>

            <Reveal as="li" className="step" delay={180}>
              <span className="step-no">03</span>
              <div>
                <h3 className="step-title">Fire</h3>
                <p className="step-text">
                  When the condition is met the enclave signs a settlement. The contract checks that signature
                  against Flare&apos;s TEE registry, consumes the action id so it cannot be replayed, then swaps or
                  redeems FXRP to native XRP.
                </p>
              </div>
            </Reveal>
          </ol>
        </div>
      </section>

      {/* What it does not claim — credibility beats marketing here. */}
      <section className="band">
        <div className="shell band-inner">
          <Reveal className="band-label">
            <span className="rule" aria-hidden="true" />
            <span>What this does not do</span>
          </Reveal>

          <div className="band-body">
            <Reveal as="div">
              <h2 className="band-title">Wraith hides intent, not execution.</h2>
            </Reveal>
            <Reveal as="div" delay={80}>
              <p className="band-text">
                Once a trigger fires, the resulting trade is an ordinary public transaction and is as exposed to
                execution-moment MEV as any other. A TEE does not make a trade invisible, and anyone claiming
                otherwise is selling you something.
              </p>
            </Reveal>
            <Reveal as="div" delay={160}>
              <p className="band-text">
                The narrower claim is the one that holds: the condition was never public, so it could never be
                hunted. Every assumption behind that — onchain ciphertext exposure, simulated attestation on
                testnet, what the registry does and does not guarantee — is written down rather than glossed over.
              </p>
            </Reveal>
            <Reveal as="div" delay={220}>
              <a
                className="inline-link"
                href="https://github.com/LSUDOKO/Wraith/blob/main/docs/TRUST.md"
                target="_blank"
                rel="noreferrer"
              >
                Read every assumption
                <span aria-hidden="true"> →</span>
              </a>
            </Reveal>
          </div>
        </div>
      </section>

      <section className="cta">
        <div className="shell cta-inner">
          <Reveal>
            <h2 className="cta-title">Set a stop nobody can see.</h2>
            <p className="cta-text">
              Running on Coston2 against live FTSO feeds. Testnet only — Flare Confidential Compute is itself
              pre-release, so do not put real funds behind it.
            </p>
            <Link className="btn btn-primary" href="/app">
              Open the app
            </Link>
            {CONTRACT && (
              <p className="cta-contract">
                Contract{" "}
                <a
                  className="tx-link"
                  href={`https://coston2.testnet.flarescan.com/address/${CONTRACT}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {CONTRACT.slice(0, 10)}…{CONTRACT.slice(-8)}
                </a>
              </p>
            )}
          </Reveal>
        </div>
      </section>
    </main>
  );
}
