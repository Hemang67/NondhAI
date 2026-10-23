import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

/** Model output is untrusted: render Markdown, then sanitize before it touches the DOM. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }) as string), [text]);
  return <div className={`prose-vd ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
