import posthog from "posthog-js";
import * as Sentry from "@sentry/nextjs";
import { scrub } from "./scrub";

const IS_POSTHOG_ACTIVE = typeof window !== "undefined" && Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY);
const IS_SENTRY_ACTIVE = Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);

export interface AnalyticsProperties {
  wallet_connected?: boolean;
  [key: string]: any;
}

/**
 * Capture a PostHog named funnel event safely, scrubbing all properties.
 * No trigger terms, ciphertext, or form field values are allowed here.
 */
export function trackEvent(name: string, properties: AnalyticsProperties = {}) {
  if (!IS_POSTHOG_ACTIVE) return;

  try {
    // 1. Enforce privacy: remove any forbidden fields from the properties payload, just in case
    const safeProps = { ...properties };
    delete safeProps.threshold;
    delete safeProps.thresholdE18;
    delete safeProps.amount;
    delete safeProps.minOut;
    delete safeProps.minOutOrLots;
    delete safeProps.xrplAddress;
    delete safeProps.underlyingAddress;
    delete safeProps.encrypted;
    delete safeProps.ciphertext;

    // 2. Recursively scrub any remaining property values of addresses/hex patterns
    const scrubbedProps = scrub(safeProps);

    // 3. Send to PostHog
    posthog.capture(name, scrubbedProps);
  } catch (error) {
    trackError(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Set user/person properties in PostHog safely.
 */
export function setPersonProperties(properties: AnalyticsProperties) {
  if (!IS_POSTHOG_ACTIVE) return;

  try {
    const scrubbedProps = scrub(properties);
    posthog.register(scrubbedProps);
  } catch (error) {
    trackError(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Capture client-side errors via Sentry, scrubbing any details before sending.
 */
export function trackError(error: unknown, context: Record<string, any> = {}) {
  if (!IS_SENTRY_ACTIVE) return;

  try {
    const scrubbedContext = scrub(context);
    Sentry.withScope((scope) => {
      scope.setExtras(scrubbedContext);
      Sentry.captureException(error);
    });
  } catch {
    // Fail silently to keep the user experience completely clean
  }
}
