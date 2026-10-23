-- Only after importing the complete compact migration seed into an empty DB.
CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT OR IGNORE INTO d1_migrations(name) VALUES
 ('0001_init.sql'),('0002_comment_indexes.sql'),('0003_source_index.sql'),
 ('0004_translation_index.sql'),('0005_compact_source.sql');
