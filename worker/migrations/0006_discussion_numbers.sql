-- Only newly discovered discussion numbers; migrated reader snapshots stay frozen.
CREATE TABLE source_discussion_numbers (
  manga_id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
