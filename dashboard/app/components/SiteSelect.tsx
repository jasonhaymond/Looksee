"use client";

import { useEffect, useState } from "react";
import { api, type Endpoint } from "../lib/api";
import { inputClass } from "./ui";

// Filters received data by where it came from: "" = everywhere, "local" =
// the Looksee server's own network, or one remote endpoint (collector or
// direct push). Hidden until some endpoint is actually a remote site.
export function SiteSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [sites, setSites] = useState<Endpoint[]>([]);
  useEffect(() => {
    api
      .endpoints()
      .then((all) => setSites(all.filter((e) => e.collectorHostId || e.publicIps.length)))
      .catch(() => setSites([]));
  }, []);
  if (!sites.length) return null;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} aria-label="Site">
      <option value="">All sites</option>
      <option value="local">Looksee server&apos;s network</option>
      {sites.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}
