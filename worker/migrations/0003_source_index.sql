CREATE TABLE IF NOT EXISTS source_sync (
  manga_id INTEGER PRIMARY KEY,
  remote_id TEXT NOT NULL,
  manga_json TEXT,
  chapter_count INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL DEFAULT 0,
  arabic_synced_at INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS source_sync_due ON source_sync(retry_after, synced_at);
CREATE TABLE IF NOT EXISTS source_chapter_index (
  manga_id INTEGER NOT NULL,
  slot TEXT NOT NULL,
  chapter_id INTEGER NOT NULL UNIQUE,
  chapter_number REAL NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (manga_id, slot)
);
CREATE INDEX IF NOT EXISTS source_chapter_order ON source_chapter_index(manga_id, chapter_number DESC);
CREATE TABLE IF NOT EXISTS source_response_cache (
  cache_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
