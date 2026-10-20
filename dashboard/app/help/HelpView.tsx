"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { inputClass } from "../components/ui";
import type { DocSection } from "./docs";

// The help reader: the guide's sections with a contents sidebar and a
// search that narrows to matching sections.
export function HelpView({ docs, current, title, intro, sections }: { docs: { slug: string; title: string }[]; current: string; title: string; intro: string; sections: DocSection[] }) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const shown = useMemo(() => (query ? sections.filter((s) => s.text.includes(query) || s.title.toLowerCase().includes(query)) : sections), [sections, query]);

  // Land on the anchor after the content renders (it isn't there on the
  // first paint of a client page).
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap gap-1.5">
        {docs.map((d) => (
          <Link key={d.slug} href={`/help${d.slug ? `/${d.slug}` : ""}`} className={`rounded-full border px-3 py-1 text-sm ${d.slug === current ? "border-[var(--accent)] bg-[var(--accent)]/15" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]"}`}>
            {d.title}
          </Link>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <aside className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${title.toLowerCase()}…`} className={`${inputClass} mb-3`} aria-label="Search help" />
          <nav aria-label="Contents" className="text-sm">
            <ul className="space-y-1">
              {shown.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} className="text-[var(--text)] hover:underline">
                    {s.title}
                  </a>
                  {!query && s.sub.length > 0 && s.sub.length <= 14 && (
                    <ul className="ml-3 mt-0.5 space-y-0.5 border-l border-[var(--border)] pl-2 text-xs">
                      {s.sub.map((x) => (
                        <li key={x.id}>
                          <a href={`#${x.id}`} className="text-[var(--muted)] hover:text-[var(--text)]">
                            {x.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            {query && !shown.length && <p className="text-xs text-[var(--muted)]">Nothing matches “{q}”.</p>}
          </nav>
        </aside>
        <article className="help-prose surface min-w-0 rounded-xl p-4 sm:p-6">
          <h1>{title}</h1>
          {!query && <div dangerouslySetInnerHTML={{ __html: intro }} />}
          {shown.map((s) => (
            <section key={s.id} dangerouslySetInnerHTML={{ __html: s.html }} />
          ))}
        </article>
      </div>
    </main>
  );
}
