import { useEffect, useState } from "react";
import type { DictionaryRow } from "@shared/types";
import { Button, Card, Input, Select } from "../components/ui";

export function DictionaryPage() {
  const [rows, setRows] = useState<DictionaryRow[]>([]);
  const [term, setTerm] = useState("");
  const [match, setMatch] = useState("");
  const [kind, setKind] = useState<DictionaryRow["kind"]>("name");

  const load = () => void window.vd.invoke("dictionary:list").then(setRows);
  useEffect(load, []);

  const add = async () => {
    if (!term.trim()) return;
    await window.vd.invoke("dictionary:upsert", {
      term: term.trim(),
      kind,
      match: kind === "replace" ? match.trim() || null : null,
      replacement: kind === "replace" ? term.trim() : null,
    });
    setTerm("");
    setMatch("");
    load();
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Dictionary</h1>
      <Card
        title="Add a word"
        description="Names and jargon are spelled exactly as you enter them. A replacement swaps what you say for what you want typed."
      >
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label className="flex w-32 flex-col gap-1 text-xs text-fg-muted">
            Type
            <Select value={kind} onChange={(e) => setKind(e.target.value as DictionaryRow["kind"])}>
              <option value="name">Name</option>
              <option value="jargon">Jargon</option>
              <option value="replace">Replacement</option>
            </Select>
          </label>
          {kind === "replace" && (
            <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-fg-muted">
              When I say
              <Input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="nondh ai" />
            </label>
          )}
          <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-fg-muted">
            {kind === "replace" ? "Type" : "Spelling"}
            <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder={kind === "replace" ? "Nondh AI" : "Priya"} />
          </label>
          <Button variant="primary" type="submit">
            Add
          </Button>
        </form>
      </Card>
      <Card title={`${rows.length} entries`}>
        {rows.length === 0 ? (
          <p className="text-sm text-fg-muted">No entries yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="w-24 text-xs uppercase tracking-wide text-fg-muted">{r.kind}</span>
                <span className="flex-1">
                  {r.kind === "replace" ? (
                    <>
                      <span className="text-fg-muted">“{r.match}” →</span> {r.term}
                    </>
                  ) : (
                    r.term
                  )}
                </span>
                <Button variant="ghost" className="h-7 px-2" onClick={() => void window.vd.invoke("dictionary:delete", r.id).then(load)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
