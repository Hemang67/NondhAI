import { readFileSync } from "node:fs";
import JSZip from "jszip";

/** Transcript files the app can import (see parseTranscript for the shapes it understands). */
export const TRANSCRIPT_EXTENSIONS = ["txt", "md", "vtt", "srt", "docx"];

export const isTranscriptFile = (path: string) => new RegExp(`\\.(${TRANSCRIPT_EXTENSIONS.join("|")})$`, "i").test(path);

/** The file's text; a Word document gives one line per paragraph. */
export async function readTranscriptFile(path: string): Promise<string> {
  if (!/\.docx$/i.test(path)) return readFileSync(path, "utf8");
  const zip = await JSZip.loadAsync(readFileSync(path));
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) throw new Error("This Word file has no document text.");
  return xml
    .split(/<\/w:p>/)
    .map((p) =>
      p
        .replace(/<w:tab\/>/g, "\t")
        .replace(/<w:br\/>/g, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&"),
    )
    .join("\n");
}
