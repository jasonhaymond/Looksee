// Generates docs/check-settings.md — every setting of every check type —
// straight from the check form's own definitions (app/lib/checkTypes.ts),
// so the reference can't drift from what the form actually offers.
//
// Run it after changing any check type's fields, from the dashboard folder:
//
//   ../engine/node_modules/.bin/tsx scripts/check-settings-doc.ts
//
// (tsx runs TypeScript directly; it's already installed for the engine.)
// It only reads checkTypes.ts and writes the one markdown file; nothing else
// is touched.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { CATEGORIES, CHECK_TYPES, type Field } from "../app/lib/checkTypes";

/** Makes text safe inside a markdown table cell (no pipes or line breaks). */
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " / ");

/** Human wording for a field's kind of input. */
const KIND: Record<Field["kind"], string> = {
  text: "text",
  number: "number",
  select: "choice",
  checkbox: "on/off",
  textarea: "text (several lines)",
  secret: "secret (write-only)",
  multi: "several choices",
  metric: "metric",
  checkref: "another check",
};

/**
 * Describes a field's default in words: the chosen option's label for
 * choices, on/off for checkboxes, the value itself otherwise.
 */
function defaultOf(f: Field): string {
  if (f.default === undefined || f.default === "") return "—";
  if (f.kind === "checkbox") return f.default ? "on" : "off";
  const option = f.options?.find((o) => o.value === String(f.default));
  return cell(option ? option.label : String(f.default));
}

/** One table row: name (with * if required), kind, default, and help. */
function row(f: Field): string {
  const notes: string[] = [];
  if (f.help) notes.push(f.help);
  // Choices are listed so a reader can see every option without the form.
  if (f.options?.length && f.kind !== "checkbox") notes.push(`Options: ${f.options.map((o) => (o.label === o.value ? o.value : `${o.label} (\`${o.value}\`)`)).join("; ")}.`);
  if (f.placeholder) notes.push(`Example: \`${f.placeholder.replace(/\n/g, " ⏎ ")}\`.`);
  if (f.showIf) notes.push("Shown only for some choices of the settings above.");
  const name = `${f.label.replace(/\s*\*$/, "")}${f.required ? " *" : ""}${f.advanced ? " *(Advanced)*" : ""}`;
  return `| ${cell(name)} | ${KIND[f.kind]} | ${defaultOf(f)} | ${cell(notes.join(" ")) || "—"} |`;
}

const out: string[] = [
  "# Check Settings",
  "",
  "Every setting of every check type, as the check form shows it — generated from the",
  "form's own definitions, so it always matches the app. `*` marks a required setting;",
  "*(Advanced)* settings are in the form's **Advanced** section and can be left alone.",
  "What each check does and how to check the same thing by hand is in the",
  "[check reference](check-reference.md); using checks in general is in the",
  "[user guide](user-guide.md).",
  "",
  "Every check also has the common settings — name, endpoint/site, **Run from** (for",
  "ping, TCP, HTTP, DNS and TLS), **Run by** (custom scripts), interval, retry interval,",
  "tags, **Depends on**, **Recovers together with**, thresholds and alert rules —",
  "described in the user guide.",
  "",
  "This file is generated: edit `dashboard/app/lib/checkTypes.ts`, then run",
  "`../engine/node_modules/.bin/tsx scripts/check-settings-doc.ts` in `dashboard/`.",
  "",
  "## Contents",
  "",
];

// Only types offered in the "add" picker; legacy ones are kept for old checks.
const current = CHECK_TYPES.filter((t) => !t.legacy);
const categories = CATEGORIES.filter((c) => current.some((t) => t.category === c));
categories.forEach((c, i) => out.push(`${i + 1}. ${c}: ${current.filter((t) => t.category === c).map((t) => `[${t.label}](#${t.type.replace(/_/g, "-")})`).join(", ")}`));
out.push("");

for (const category of categories) {
  out.push(`## ${category}`, "");
  for (const t of current.filter((x) => x.category === category)) {
    // A fixed anchor per type (its ID), independent of the label's wording.
    out.push(`<a id="${t.type.replace(/_/g, "-")}"></a>`, "", `### ${t.label}`, "", `Type ID \`${t.type}\`. ${t.description}`, "");
    if (t.value) out.push(`**Value:** ${t.value.hint}${t.value.unit.trim() ? ` (${t.value.unit.trim()})` : ""}. Thresholds apply to it.`, "");
    if (!t.fields.length) {
      out.push("No settings of its own.", "");
      continue;
    }
    out.push("| Setting | Kind | Default | Notes |", "|---|---|---|---|", ...t.fields.map(row), "");
  }
}

const target = path.join(process.cwd(), "..", "docs", "check-settings.md");
writeFileSync(target, out.join("\n"));
console.log(`Wrote ${target} (${current.length} check types)`);
