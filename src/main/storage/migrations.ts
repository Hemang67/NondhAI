/** Append-only. Index i upgrades user_version i → i+1. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE dictations (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    raw_text TEXT NOT NULL,
    clean_text TEXT NOT NULL,
    mode TEXT NOT NULL,
    engine TEXT NOT NULL,
    model TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    app_name TEXT,
    cloud_used INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX dictations_created ON dictations(created_at);

  CREATE VIRTUAL TABLE dictations_fts USING fts5(
    raw_text, clean_text, content='dictations', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER dictations_ai AFTER INSERT ON dictations BEGIN
    INSERT INTO dictations_fts(rowid, raw_text, clean_text) VALUES (new.rowid, new.raw_text, new.clean_text);
  END;
  CREATE TRIGGER dictations_ad AFTER DELETE ON dictations BEGIN
    INSERT INTO dictations_fts(dictations_fts, rowid, raw_text, clean_text)
      VALUES ('delete', old.rowid, old.raw_text, old.clean_text);
  END;
  CREATE TRIGGER dictations_au AFTER UPDATE OF raw_text, clean_text ON dictations BEGIN
    INSERT INTO dictations_fts(dictations_fts, rowid, raw_text, clean_text)
      VALUES ('delete', old.rowid, old.raw_text, old.clean_text);
    INSERT INTO dictations_fts(rowid, raw_text, clean_text) VALUES (new.rowid, new.raw_text, new.clean_text);
  END;

  CREATE TABLE dictionary (
    id TEXT PRIMARY KEY,
    term TEXT NOT NULL,
    match TEXT,
    replacement TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('name', 'jargon', 'replace')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  `,
];
