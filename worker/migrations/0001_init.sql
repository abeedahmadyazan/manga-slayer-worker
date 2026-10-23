CREATE TABLE IF NOT EXISTS documents (
  path TEXT PRIMARY KEY NOT NULL,
  fields TEXT NOT NULL CHECK (json_valid(fields)),
  updated_at INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS documents_path_prefix ON documents(path);

CREATE TABLE IF NOT EXISTS write_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
