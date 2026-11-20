// The "Notifications" choice in alert settings, shown while no Notifications
// channel exists yet. Ticking it creates that channel (type web_push: every
// browser with push turned on and every phone with the Looksee Android app)
// and selects it, so sending alerts to browsers and phones doesn't need a
// detour through the Channels page first. Once the channel exists it's listed
// like any other channel and this option disappears.
//
// Where this sits: used by the alert-rule form on a check's page
// (AlertRuleManager) and by the alert options wherever checks are created
// (ui.tsx AlertOptions).
//
// "use client" makes this a React component that runs in the browser.

"use client";

import { useState } from "react";
import { api, type Channel } from "../lib/api";

/**
 * The checkbox that creates the Notifications channel.
 *
 * @param channels the channels already offered (hidden if one is a Notifications channel)
 * @param onAdded called with the new channel once created; the caller lists it
 *        and selects it
 * Side effect: creates a notification channel named "Notifications" on the engine.
 */
export function NotificationsChannelOption({ channels, onAdded, accent = "accent-[var(--accent)]" }: { channels: { type: string }[]; onAdded: (channel: Channel) => void; accent?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (channels.some((c) => c.type === "web_push")) return null;
  return (
    <label className="flex items-center gap-1.5">
      <input
        type="checkbox"
        className={accent}
        checked={false}
        disabled={busy}
        onChange={async () => {
          setBusy(true);
          setError(null);
          try {
            onAdded(await api.createChannel({ name: "Notifications", type: "web_push", config: {} }));
          } catch (err) {
            setError(err instanceof Error ? err.message : "Couldn't create the channel");
          } finally {
            setBusy(false);
          }
        }}
      />
      Notifications <span className="text-xs text-[var(--muted)]">{busy ? "(creating…)" : "(browsers and Android app; adds the channel)"}</span>
      {error && <span className="text-xs text-[var(--down)]">{error}</span>}
    </label>
  );
}
