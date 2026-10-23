import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { FolderRecord, NoteRecord } from "@shared/notes";
import type { NoteAction } from "@shared/ipc";
import { Badge, Button, cx, Input } from "../components/ui";
import { Markdown } from "../components/Markdown";
import { useNav } from "../nav";

const ACTIONS: Array<[NoteAction, string]> = [
  ["summarize", "Summarize"],
  ["rewrite", "Rewrite"],
  ["tasks", "Extract tasks"],
  ["email", "Draft follow-up email"],
];

export function NotesPage({ initialId }: { initialId?: string }) {
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [folder, setFolder] = useState<string | null | undefined>(undefined); // undefined = all
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(initialId ?? null);
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    void window.vd.invoke("folders:list").then(setFolders);
    void window.vd.invoke("notes:list", { folderId: folder, query: query || undefined }).then(setNotes);
  }, [folder, query]);
  useEffect(() => {
    const t = setTimeout(load, 100);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => window.vd.on("notes:changed", load), [load]);

  const create = async () => {
    const n = await window.vd.invoke("notes:create", { title: "Untitled", folderId: folder ?? null });
    setSelected(n.id);
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-48 shrink-0 flex-col gap-1 border-r border-line p-2">
        <FolderButton active={folder === undefined} onClick={() => setFolder(undefined)} label="All notes" />
        <FolderButton active={folder === null} onClick={() => setFolder(null)} label="No folder" />
        {folders.map((f) => (
          <div key={f.id} className="group flex items-center">
            <div className="min-w-0 flex-1">
              <FolderButton active={folder === f.id} onClick={() => setFolder(f.id)} label={f.name} />
            </div>
            <button
              className="hidden px-1 text-xs text-fg-muted group-hover:block"
              title="Rename folder"
              onClick={() => {
                const n = prompt("Folder name", f.name);
                if (n) void window.vd.invoke("folders:rename", f.id, n);
              }}
            >
              ✎
            </button>
            <button
              className="hidden px-1 text-xs text-fg-muted group-hover:block"
              title="Delete folder (notes are kept)"
              onClick={() => confirm(`Delete folder “${f.name}”? Its notes are kept.`) && void window.vd.invoke("folders:delete", f.id)}
            >
              ✕
            </button>
          </div>
        ))}
        <Button
          variant="ghost"
          className="mt-1 justify-start"
          onClick={() => {
            const n = prompt("New folder name");
            if (n) void window.vd.invoke("folders:create", n, null);
          }}
        >
          + New folder
        </Button>
      </aside>
      <aside className="flex w-64 shrink-0 flex-col border-r border-line">
        <div className="flex gap-1.5 border-b border-line p-2">
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search notes…" aria-label="Search notes" />
          <Button variant="primary" onClick={() => void create()} aria-label="New note">
            +
          </Button>
        </div>
        <ul className="flex-1 overflow-y-auto p-1">
          {notes.length === 0 && <li className="p-3 text-sm text-fg-muted">No notes.</li>}
          {notes.map((n) => (
            <li key={n.id}>
              <button onClick={() => setSelected(n.id)} className={cx("w-full rounded-md px-3 py-2 text-left", selected === n.id ? "bg-muted" : "hover:bg-muted/60")}>
                <div className="truncate text-sm font-medium">{n.title}</div>
                <div className="truncate text-xs text-fg-muted">{n.bodyText.slice(0, 80) || "Empty"}</div>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="min-w-0 flex-1 overflow-y-auto">
        {selected ? <NoteEditor key={selected} id={selected} folders={folders} onDeleted={() => setSelected(null)} /> : (
          <p className="p-8 text-sm text-fg-muted">Select or create a note. Meetings and dictations can become notes from their pages.</p>
        )}
      </section>
    </div>
  );
}

function FolderButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} className={cx("w-full min-w-0 truncate rounded-md px-2.5 py-1.5 text-left text-sm", active ? "bg-muted font-medium" : "text-fg-muted hover:bg-muted")}>
      {label}
    </button>
  );
}

function NoteEditor({ id, folders, onDeleted }: { id: string; folders: FolderRecord[]; onDeleted: () => void }) {
  const [note, setNote] = useState<NoteRecord | null>(null);
  const [saved, setSaved] = useState(true);
  const [ai, setAi] = useState<{ action: string; text: string; cloud: boolean } | null>(null);
  const [busy, setBusy] = useState("");
  const save = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nav = useNav();

  const editor = useEditor({
    extensions: [StarterKit],
    editorProps: { attributes: { class: "prose-vd min-h-[50vh] outline-none", "aria-label": "Note body" } },
    onUpdate: ({ editor: e }) => {
      setSaved(false);
      if (save.current) clearTimeout(save.current);
      save.current = setTimeout(async () => {
        await window.vd.invoke("notes:update", id, { bodyJson: JSON.stringify(e.getJSON()), bodyText: e.getText({ blockSeparator: "\n" }) });
        setSaved(true);
      }, 600);
    },
  });

  useEffect(() => {
    void window.vd.invoke("notes:get", id).then((n) => {
      setNote(n);
      if (n && editor) {
        try {
          editor.commands.setContent(JSON.parse(n.bodyJson), { emitUpdate: false });
        } catch {
          editor.commands.setContent(n.bodyText, { emitUpdate: false });
        }
      }
    });
  }, [id, editor]);

  if (!note) return null;

  const runAction = async (action: NoteAction, label: string) => {
    setBusy(label);
    try {
      const r = await window.vd.invoke("notes:action", id, action);
      setAi({ action: label, text: r.text, cloud: r.cloud });
    } catch (e) {
      setAi({ action: label, text: `⚠ ${(e as Error).message}`, cloud: false });
    } finally {
      setBusy("");
    }
  };
  const insert = (replace: boolean) => {
    if (!ai || !editor) return;
    const html = DOMPurify.sanitize(marked.parse(ai.text, { async: false }) as string);
    if (replace) editor.commands.setContent(html);
    else editor.chain().focus("end").insertContent(`<h2>${ai.action}</h2>${html}`).run();
    setAi(null);
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="min-w-0 flex-1 bg-transparent text-xl font-semibold outline-none focus:underline"
          defaultValue={note.title}
          aria-label="Note title"
          onBlur={(e) => e.target.value !== note.title && void window.vd.invoke("notes:update", id, { title: e.target.value || "Untitled" })}
        />
        <select
          className="h-8 rounded-md border border-line bg-panel px-2 text-sm"
          value={note.folderId ?? ""}
          aria-label="Folder"
          onChange={(e) => void window.vd.invoke("notes:update", id, { folderId: e.target.value || null }).then(setNote)}
        >
          <option value="">No folder</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <span className="text-xs text-fg-muted">{saved ? "Saved" : "Saving…"}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
        {note.sourceType === "meeting" && note.sourceId && (
          <button className="underline" onClick={() => nav({ tab: "meetings", meetingId: note.sourceId! })}>
            From a meeting
          </button>
        )}
        {note.sourceType === "dictation" && <span>From a dictation</span>}
        <span>Edited {new Date(note.updatedAt).toLocaleString()}</span>
      </div>
      <Toolbar editor={editor} />
      <div className="mt-2 rounded-md border border-line bg-panel p-4">
        <EditorContent editor={editor} />
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {ACTIONS.map(([a, label]) => (
          <Button key={a} disabled={!!busy} onClick={() => void runAction(a, label)}>
            {busy === label ? "Working…" : label}
          </Button>
        ))}
        <Button variant="danger" className="ml-auto" onClick={() => confirm("Delete this note?") && void window.vd.invoke("notes:delete", id).then(onDeleted)}>
          Delete
        </Button>
      </div>
      {ai && (
        <div className="mt-4 rounded-md border border-line bg-panel p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-semibold">{ai.action}</span>
            {ai.cloud && <Badge tone="cloud">cloud</Badge>}
          </div>
          <Markdown text={ai.text} className="text-sm" />
          <div className="mt-3 flex gap-1.5">
            <Button onClick={() => insert(false)}>Add to note</Button>
            <Button onClick={() => insert(true)}>Replace note</Button>
            <Button onClick={() => void navigator.clipboard.writeText(ai.text)}>Copy</Button>
            <Button variant="ghost" onClick={() => setAi(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Toolbar({ editor }: { editor: ReturnType<typeof useEditor> }) {
  if (!editor) return null;
  const b = (label: string, active: boolean, run: () => void, title: string) => (
    <button
      key={title}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onMouseDown={(e) => {
        e.preventDefault();
        run();
      }}
      className={cx("h-7 min-w-7 rounded px-1.5 text-sm", active ? "bg-muted font-semibold" : "text-fg-muted hover:bg-muted")}
    >
      {label}
    </button>
  );
  const c = () => editor.chain().focus();
  return (
    <div className="mt-4 flex flex-wrap gap-0.5 border-b border-line pb-1">
      {b("B", editor.isActive("bold"), () => c().toggleBold().run(), "Bold")}
      {b("I", editor.isActive("italic"), () => c().toggleItalic().run(), "Italic")}
      {b("S", editor.isActive("strike"), () => c().toggleStrike().run(), "Strikethrough")}
      {b("H1", editor.isActive("heading", { level: 1 }), () => c().toggleHeading({ level: 1 }).run(), "Heading 1")}
      {b("H2", editor.isActive("heading", { level: 2 }), () => c().toggleHeading({ level: 2 }).run(), "Heading 2")}
      {b("•", editor.isActive("bulletList"), () => c().toggleBulletList().run(), "Bullet list")}
      {b("1.", editor.isActive("orderedList"), () => c().toggleOrderedList().run(), "Numbered list")}
      {b("❝", editor.isActive("blockquote"), () => c().toggleBlockquote().run(), "Quote")}
      {b("</>", editor.isActive("codeBlock"), () => c().toggleCodeBlock().run(), "Code block")}
      {b("↶", false, () => c().undo().run(), "Undo")}
      {b("↷", false, () => c().redo().run(), "Redo")}
    </div>
  );
}
