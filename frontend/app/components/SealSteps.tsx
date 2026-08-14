"use client";

import { explorerTx } from "@/lib/wraith";

export type StepState = "idle" | "active" | "done" | "failed";

export type SealStep = {
  label: string;
  detail: string;
  state: StepState;
  tx?: string;
  error?: string;
};

/** The pipeline before anything has happened. */
export function idleSteps(): SealStep[] {
  return [
    { label: "Approve", detail: "Allowing WraithOrders to hold your escrow", state: "idle" },
    { label: "Encrypt", detail: "Sealing your condition in this browser", state: "idle" },
    { label: "Seal", detail: "Submitting ciphertext to Coston2", state: "idle" },
  ];
}

/**
 * The three stages of sealing an order.
 *
 * Two of them are wallet transactions and one is local, and before this the
 * only signal that any of them was happening was a single line of replacing
 * text. A user who saw "Sealing the order on Coston2…" had no way to tell
 * whether the approval had already landed, which matters when a failure means
 * deciding whether to retry the whole flow or only the part that broke.
 *
 * Completed steps keep their transaction hash so the evidence stays on screen
 * rather than being overwritten by the next status message.
 */
export function SealSteps({ steps }: { steps: SealStep[] }) {
  const active = steps.findIndex((s) => s.state === "active");
  const done = steps.filter((s) => s.state === "done").length;
  const failed = steps.find((s) => s.state === "failed");

  if (steps.every((s) => s.state === "idle")) return null;

  return (
    <div
      className="steps"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={steps.length}
      aria-valuenow={done}
      aria-valuetext={
        failed
          ? `${failed.label} failed: ${failed.error ?? "unknown error"}`
          : active >= 0
            ? `Step ${active + 1} of ${steps.length}: ${steps[active].detail}`
            : `${done} of ${steps.length} complete`
      }
    >
      <ol className="steps-list">
        {steps.map((step, i) => (
          <li className="step" data-state={step.state} key={step.label}>
            <span className="step-mark" aria-hidden="true">
              {step.state === "done" ? "✓" : step.state === "failed" ? "×" : i + 1}
            </span>

            <span className="step-body">
              <span className="step-label">{step.label}</span>
              <span className="step-detail">
                {step.state === "failed" ? step.error : step.detail}
                {step.tx && (
                  <>
                    {" "}
                    <a className="tx-link" href={explorerTx(step.tx)} target="_blank" rel="noreferrer">
                      tx ↗
                    </a>
                  </>
                )}
              </span>
            </span>
          </li>
        ))}
      </ol>

      {/* Announced separately so a screen reader hears each transition once,
          rather than re-reading the whole list every time a step changes. */}
      <p className="sr-only" aria-live="polite">
        {failed
          ? `${failed.label} failed. ${failed.error ?? ""}`
          : active >= 0
            ? `${steps[active].label}. ${steps[active].detail}`
            : done === steps.length
              ? "Order sealed."
              : ""}
      </p>
    </div>
  );
}
