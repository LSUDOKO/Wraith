"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Telegram alerts for your own orders.
 *
 * A browser notification only arrives if the tab is open, which is precisely
 * the wrong moment: an order fires while you are asleep, or away, or have moved
 * on. Telegram reaches you either way, and the keeper — which is awake when a
 * trigger fires — is what sends it.
 *
 * Only the order id, the action and the transaction go out. The condition never
 * leaves the enclave, so an alert cannot leak it even if the chat is later
 * compromised.
 */
export function Alerts({ address }: { address?: string }) {
  const [chatId, setChatId] = useState("");
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!address) {
      setSubscribed(false);
      return;
    }
    fetch(`/api/alerts?address=${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setSubscribed(Boolean(data?.subscribed)))
      .catch(() => {});
  }, [address]);

  const save = useCallback(
    async (nextChatId: string) => {
      if (!address) return;
      setBusy(true);
      setNote("");
      try {
        const response = await fetch("/api/alerts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address, chatId: nextChatId }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error ?? "could not save");
        setSubscribed(Boolean(data.subscribed));
        setNote(data.subscribed ? "Alerts on. Test it by cancelling an order." : "Alerts off.");
        if (!data.subscribed) setChatId("");
      } catch (error) {
        setNote(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [address],
  );

  if (!address) return null;

  return (
    <section className="alerts" aria-labelledby="alerts-title">
      <h2 className="panel-title" id="alerts-title">
        Alerts
      </h2>

      {subscribed ? (
        <>
          <p className="alerts-state">
            <span className="alerts-dot" aria-hidden="true" />
            Telegram alerts are on for this wallet.
          </p>
          <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => save("")}>
            Turn off
          </button>
        </>
      ) : (
        <form
          className="alerts-form"
          onSubmit={(e) => {
            e.preventDefault();
            save(chatId);
          }}
        >
          <label className="field">
            <span className="field-label">
              Telegram chat ID <span className="field-hint">message @userinfobot to find yours</span>
            </span>
            <input
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              inputMode="numeric"
              placeholder="123456789"
              required
            />
          </label>
          <button className="btn btn-ghost" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Alert me when my orders fire"}
          </button>
        </form>
      )}

      {note && (
        <p className="alerts-note" role="status">
          {note}
        </p>
      )}

      <p className="secret-note">
        Start a chat with the bot first, or Telegram will refuse to deliver. Alerts carry the order id, the action
        and the transaction — never the condition, which never leaves the enclave.
      </p>
    </section>
  );
}
