-- One chapter list per title, plus 256 bounded lookup buckets. Numeric chapter
-- IDs stay unchanged, preserving every existing discussion and reading history.
CREATE TABLE IF NOT EXISTS source_title_snapshots (
  manga_id INTEGER NOT NULL,
  part INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY(manga_id, part)
);
CREATE TABLE IF NOT EXISTS source_latest (
  manga_id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE TABLE IF NOT EXISTS source_chapter_buckets (
  bucket INTEGER PRIMARY KEY CHECK(bucket >= 0 AND bucket < 256),
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE TABLE IF NOT EXISTS source_write_budget (
  day TEXT PRIMARY KEY,
  reserved INTEGER NOT NULL DEFAULT 0
);
