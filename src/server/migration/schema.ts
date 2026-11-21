/** Progress of the migration from Paperless-ngx, one row per document (docs/standalone/migration.md §2.3). */
export const MIGRATION_SCHEMA = `
CREATE TABLE migration_items (
  ngx_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'imported', 'failed', 'skipped', 'deleted')),
  imported_modified TEXT,
  checksum TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX migration_items_status ON migration_items(status);
`;
