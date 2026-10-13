import { DOCS, loadDoc } from "./docs";
import { HelpView } from "./HelpView";

export const metadata = { title: "Help — Looksee" };

export default function HelpPage() {
  const doc = loadDoc("")!;
  return <HelpView docs={DOCS.map(({ slug, title }) => ({ slug, title }))} current="" title={doc.title} intro={doc.intro} sections={doc.sections} />;
}
