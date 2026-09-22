// A short, dismissable-by-scrolling-past intro line at the top of a major
// page — one place this app's non-technical-enough-to-remember-flags users
// land on a short "what is this page" plus a link into the fuller guide,
// distinct from Tooltip's per-field hover help.
export function PageHelp({ children, anchor }: { children: React.ReactNode; anchor: string }) {
  return (
    <p className="mb-4 rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--muted)]">
      {children}{" "}
      <a
        href={`https://github.com/jasonhaymond/Looksee/blob/main/docs/user-guide.md#${anchor}`}
        target="_blank"
        rel="noreferrer"
        className="underline hover:text-[var(--text)]"
      >
        Learn more
      </a>
    </p>
  );
}
