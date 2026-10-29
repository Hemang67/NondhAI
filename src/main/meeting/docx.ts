import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { clock, type ExportInput } from "@shared/meeting/export";

/** Word export: title, summary sections, then the transcript with bold speaker names. */
export async function toDocx(i: ExportInput): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ text: i.title, heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: `${new Date(i.startedAt).toLocaleString()} · ${clock(i.durationMs)}`, italics: true })] }),
  ];
  const section = (title: string, items: string[]) => {
    children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_2 }));
    for (const it of items.length ? items : ["None"]) children.push(new Paragraph({ text: it, bullet: { level: 0 } }));
  };
  if (i.summary) {
    if (i.summary.topics?.length) {
      for (const t of i.summary.topics) {
        children.push(new Paragraph({ text: t.heading, heading: HeadingLevel.HEADING_2 }));
        for (const sec of t.sections) {
          children.push(new Paragraph({ text: sec.heading, heading: HeadingLevel.HEADING_3 }));
          for (const p of sec.points) children.push(new Paragraph({ text: p, bullet: { level: 0 } }));
        }
      }
    } else {
      section("Key points", i.summary.keyPoints);
      section("Decisions", i.summary.decisions);
    }
    section(
      "Action items",
      i.summary.actionItems.map((a) => `${a.task}${a.owner ? ` — ${a.owner}` : ""}${a.due ? ` (due ${a.due})` : ""}`),
    );
    section("Open questions", i.summary.openQuestions);
  }
  children.push(new Paragraph({ text: "Transcript", heading: HeadingLevel.HEADING_2 }));
  for (const l of i.lines) {
    const name = i.speakers[l.speakerKey]?.name ?? "Unknown";
    const flags = [l.overlap ? "overlapping speech" : "", l.uncertainSpeaker ? "speaker uncertain" : ""].filter(Boolean).join(", ");
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `${name} `, bold: true }),
          new TextRun({ text: `[${clock(l.start)}]${flags ? ` (${flags})` : ""} `, color: "777777" }),
          new TextRun(l.text),
        ],
      }),
    );
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}
