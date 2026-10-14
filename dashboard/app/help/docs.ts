import fs from "node:fs";
import path from "node:path";
import { Marked, type Tokens } from "marked";

// The in-app help is the repo's own docs/ folder, rendered at build time —
// one source of truth, so the help inside the app can't drift from the
// markdown guides.

export const DOCS = [
  { slug: "", file: "user-guide.md", title: "User guide" },
  { slug: "checks", file: "check-reference.md", title: "Check reference" },
  { slug: "windows-agent", file: "windows-agent-security.md", title: "Windows agent & security software" },
  { slug: "security", file: "security-guide.md", title: "Security guide" },
  { slug: "vpn", file: "vpn-access.md", title: "VPN-only access" },
] as const;

const REPO = "https://github.com/jasonhaymond/Looksee/blob/main";

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function rewriteHref(href: string): string {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [file, hash] = href.split("#");
  const base = path.basename(file);
  const doc = DOCS.find((d) => d.file === base);
  if (doc) return `/help${doc.slug ? `/${doc.slug}` : ""}${hash ? `#${hash}` : ""}`;
  // Anything else in the repo (README, deployment guide, agent README).
  const clean = file.replace(/^(\.\.\/)+/, "").replace(/^\.\//, "");
  const inDocs = !file.startsWith("../") && !file.includes("/") ? `docs/${clean}` : clean;
  return `${REPO}/${inDocs}${hash ? `#${hash}` : ""}`;
}

export type DocSection = { id: string; title: string; html: string; text: string; sub: { id: string; title: string }[] };

export function loadDoc(slug: string): { title: string; intro: string; sections: DocSection[] } | null {
  const doc = DOCS.find((d) => d.slug === slug);
  if (!doc) return null;
  let src: string;
  try {
    src = fs.readFileSync(path.join(process.cwd(), "..", "docs", doc.file), "utf-8");
  } catch {
    return { title: doc.title, intro: `<p>This guide (docs/${doc.file}) isn't available in this build.</p>`, sections: [] };
  }
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        return `<h${depth} id="${slugify(inner)}">${inner}</h${depth}>\n`;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const target = rewriteHref(href);
        const external = /^https?:/.test(target);
        return `<a href="${target}"${title ? ` title="${title}"` : ""}${external ? ' target="_blank" rel="noreferrer"' : ""}>${inner}</a>`;
      },
    },
  });
  const tokens = marked.lexer(src);
  // Split on level-2 headings; the H1 and anything before the first H2 is
  // the intro. The table of contents a doc writes for GitHub is dropped —
  // the help page builds its own.
  const sections: { heading: Tokens.Heading | null; tokens: typeof tokens }[] = [{ heading: null, tokens: [] as unknown as typeof tokens }];
  for (const t of tokens) {
    if (t.type === "heading" && (t as Tokens.Heading).depth === 2) sections.push({ heading: t as Tokens.Heading, tokens: [] as unknown as typeof tokens });
    else sections[sections.length - 1].tokens.push(t);
  }
  const render = (toks: typeof tokens) => marked.parser(Object.assign(toks, { links: tokens.links }));
  const introTokens = sections[0].tokens.filter((t) => !(t.type === "heading" && (t as Tokens.Heading).depth === 1));
  const out: DocSection[] = sections
    .slice(1)
    .filter((s) => !/^(contents|table of contents)$/i.test(s.heading!.text.trim()))
    .map((s) => {
      const title = s.heading!.text;
      const sub = s.tokens.filter((t) => t.type === "heading" && (t as Tokens.Heading).depth === 3).map((t) => ({ id: slugify((t as Tokens.Heading).text), title: (t as Tokens.Heading).text.replace(/[`*]/g, "") }));
      const html = render([s.heading!, ...s.tokens] as typeof tokens);
      return { id: slugify(title), title: title.replace(/[`*]/g, ""), html, text: s.tokens.map((t) => t.raw).join(" ").toLowerCase(), sub };
    });
  return { title: doc.title, intro: render(introTokens as typeof tokens), sections: out };
}
