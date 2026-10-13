import { notFound } from "next/navigation";
import { DOCS, loadDoc } from "../docs";
import { HelpView } from "../HelpView";

export function generateStaticParams() {
  return DOCS.filter((d) => d.slug).map((d) => ({ doc: d.slug }));
}

export const dynamicParams = false;

export default async function HelpDocPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc: slug } = await params;
  const doc = loadDoc(slug);
  if (!doc) notFound();
  return <HelpView docs={DOCS.map(({ slug: s, title }) => ({ slug: s, title }))} current={slug} title={doc.title} intro={doc.intro} sections={doc.sections} />;
}
