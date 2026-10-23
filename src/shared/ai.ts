import type { ChatMessage } from "./cleanup/llmCleanup";
import type { NoteAction } from "./ipc";

export function noteActionMessages(action: NoteAction, title: string, text: string): ChatMessage[] {
  const tasks: Record<NoteAction, string> = {
    summarize: "Summarize this note in a few short bullet points. Keep names, numbers and decisions.",
    rewrite: "Rewrite this note so it is clear, well organized and concise. Keep every fact. Use short paragraphs or bullets.",
    tasks: "Extract every task or action item as a checklist (\"- [ ] task — owner, due date\" when known). If there are none, say \"No tasks found.\"",
    email: "Draft a short, friendly follow-up email based on this note: a subject line, then the body. Summarize what was agreed and list next steps with owners.",
  };
  return [
    { role: "system", content: `${tasks[action]} Reply with the result only, in Markdown.` },
    { role: "user", content: `<note title="${title.replace(/"/g, "'")}">\n${text}\n</note>` },
  ];
}

export function editSelectionMessages(instruction: string, selection: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You edit text for the user. Apply their spoken instruction to the selected text and reply with the edited text only — " +
        "no quotes, no explanation. Keep the original language and formatting style unless asked to change them.",
    },
    { role: "user", content: `Instruction: ${instruction}\n\n<selected_text>\n${selection}\n</selected_text>` },
  ];
}

export function askMessages(question: string, hasScreenshot: boolean): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a concise desktop assistant. Answer the user's spoken request directly. Prefer short answers; use Markdown lists or code blocks when they help." +
        (hasScreenshot ? " A screenshot of the user's screen is attached for context." : ""),
    },
    { role: "user", content: question },
  ];
}

/** Terminals treat Ctrl+C as "interrupt", so the assistant never sends it there. */
export const TERMINAL_APPS = new Set(["windowsterminal", "wt", "cmd", "powershell", "pwsh", "mintty", "alacritty", "wezterm-gui", "conhost"]);
