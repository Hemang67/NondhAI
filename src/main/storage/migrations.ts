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
  // 2: meetings, people/voiceprints, notes/folders, search embeddings
  `
  CREATE TABLE meetings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('call', 'room', 'import')),
    status TEXT NOT NULL CHECK (status IN ('recording', 'processing', 'ready', 'failed')),
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    dir TEXT NOT NULL,
    audio_file TEXT,
    audio_encrypted INTEGER NOT NULL DEFAULT 0,
    audio_expires_at INTEGER,
    source_app TEXT,
    summary_json TEXT,
    attendees_json TEXT,
    calendar_event_id TEXT,
    error TEXT,
    recovered INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX meetings_started ON meetings(started_at);

  CREATE TABLE meeting_lines (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    speaker_key TEXT NOT NULL,
    channel TEXT NOT NULL,
    text TEXT NOT NULL,
    conf REAL NOT NULL DEFAULT 1,
    overlap INTEGER NOT NULL DEFAULT 0,
    uncertain INTEGER NOT NULL DEFAULT 0,
    is_final INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX meeting_lines_meeting ON meeting_lines(meeting_id, start_ms);
  CREATE VIRTUAL TABLE meeting_lines_fts USING fts5(
    text, content='meeting_lines', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER meeting_lines_ai AFTER INSERT ON meeting_lines BEGIN
    INSERT INTO meeting_lines_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER meeting_lines_ad AFTER DELETE ON meeting_lines BEGIN
    INSERT INTO meeting_lines_fts(meeting_lines_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;
  CREATE TRIGGER meeting_lines_au AFTER UPDATE OF text ON meeting_lines BEGIN
    INSERT INTO meeting_lines_fts(meeting_lines_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO meeting_lines_fts(rowid, text) VALUES (new.rowid, new.text);
  END;

  CREATE TABLE people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_me INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );

  CREATE TABLE voiceprints (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    embedding BLOB NOT NULL,
    model TEXT NOT NULL,
    source TEXT NOT NULL,
    source_meeting_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX voiceprints_person ON voiceprints(person_id);

  CREATE TABLE meeting_speakers (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    speaker_key TEXT NOT NULL,
    name TEXT NOT NULL,
    person_id TEXT,
    score REAL,
    confidence TEXT NOT NULL,
    confirmed INTEGER NOT NULL DEFAULT 0,
    embedding BLOB,
    PRIMARY KEY (meeting_id, speaker_key)
  );

  CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );

  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    folder_id TEXT,
    title TEXT NOT NULL,
    body_json TEXT NOT NULL,
    body_text TEXT NOT NULL,
    source_type TEXT,
    source_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX notes_folder ON notes(folder_id);
  CREATE VIRTUAL TABLE notes_fts USING fts5(
    title, body_text, content='notes', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, body_text) VALUES (new.rowid, new.title, new.body_text);
  END;
  CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body_text) VALUES ('delete', old.rowid, old.title, old.body_text);
  END;
  CREATE TRIGGER notes_au AFTER UPDATE OF title, body_text ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body_text) VALUES ('delete', old.rowid, old.title, old.body_text);
    INSERT INTO notes_fts(rowid, title, body_text) VALUES (new.rowid, new.title, new.body_text);
  END;

  CREATE TABLE embeddings (
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    chunk INTEGER NOT NULL,
    text TEXT NOT NULL,
    vector BLOB NOT NULL,
    model TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_type, owner_id, chunk)
  );
  `,
  // 3: screen recordings attached to a meeting (any number of start/stop clips)
  `
  CREATE TABLE meeting_clips (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    file TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('screen', 'window', 'region')),
    label TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER,
    width INTEGER,
    height INTEGER,
    encrypted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX meeting_clips_meeting ON meeting_clips(meeting_id, start_ms);
  `,
  // 4: video edits made from a meeting's screen clips (one clip, or several merged)
  `
  CREATE TABLE video_projects (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    export_file TEXT,
    export_status TEXT NOT NULL DEFAULT 'none' CHECK (export_status IN ('none', 'rendering', 'done', 'error')),
    export_error TEXT,
    exported_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX video_projects_meeting ON video_projects(meeting_id);
  `,
];
