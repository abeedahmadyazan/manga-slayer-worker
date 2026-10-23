CREATE INDEX IF NOT EXISTS documents_comments_target
ON documents(
  json_extract(fields, '$.kind.stringValue'),
  CAST(json_extract(fields, '$.targetId.integerValue') AS INTEGER),
  CAST(json_extract(fields, '$.parentId.integerValue') AS INTEGER),
  CAST(json_extract(fields, '$.id.integerValue') AS INTEGER)
)
WHERE path GLOB 'comments/[0-9]*';

CREATE INDEX IF NOT EXISTS documents_comments_parent
ON documents(CAST(json_extract(fields, '$.parentId.integerValue') AS INTEGER))
WHERE path GLOB 'comments/[0-9]*';
