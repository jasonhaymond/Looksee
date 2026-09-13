"use client";

import { useState } from "react";
import { api } from "../lib/api";

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export function PushEnableButton() {
  const [status, setStatus] = useState<"idle" | "enabling" | "enabled" | "error">("idle");

  async function enable() {
    setStatus("enabling");
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        throw new Error("Push notifications aren't supported in this browser");
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission denied");

      const { publicKey } = await api.vapidPublicKey();
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await api.subscribePush(subscription.toJSON());
      setStatus("enabled");
    } catch (err) {
      console.error("Failed to enable push notifications:", err);
      setStatus("error");
    }
  }

  if (status === "enabled") return <span className="text-xs text-[var(--up)]">Push notifications enabled</span>;

  return (
    <button onClick={enable} disabled={status === "enabling"} className="text-xs text-[var(--muted)] hover:text-[var(--text)]">
      {status === "enabling" ? "Enabling..." : status === "error" ? "Failed — try again" : "Enable push notifications"}
    </button>
  );
}
