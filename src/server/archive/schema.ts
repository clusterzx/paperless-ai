/**
 * Schema of the built-in archive (docs/standalone/data-model.md). Created complete in one
 * migration: libraries, file versions and the change log are there from the start.
 */
export const ARCHIVE_SCHEMA = `
CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  verified_at INTEGER
) WITHOUT ROWID;

CREATE TABLE lib_correspondents (
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (library_id, name_norm)
);
CREATE TABLE lib_document_types (
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (library_id, name_norm)
);
CREATE TABLE lib_tags (
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  color TEXT,
  parent_id INTEGER REFERENCES lib_tags(id) ON DELETE SET NULL,
  is_inbox INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (library_id, name_norm)
);
CREATE TABLE lib_storage_paths (
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  template TEXT NOT NULL DEFAULT '',
  UNIQUE (library_id, name_norm)
);
CREATE TABLE lib_custom_fields (
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  data_type TEXT NOT NULL,
  extra TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (library_id, name_norm)
);

CREATE TABLE lib_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id),
  title TEXT NOT NULL,
  created TEXT,
  added TEXT NOT NULL,
  modified TEXT NOT NULL,
  correspondent_id INTEGER REFERENCES lib_correspondents(id) ON DELETE SET NULL,
  document_type_id INTEGER REFERENCES lib_document_types(id) ON DELETE SET NULL,
  storage_path_id INTEGER REFERENCES lib_storage_paths(id) ON DELETE SET NULL,
  archive_serial_number INTEGER,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  original_filename TEXT,
  mime_type TEXT NOT NULL,
  page_count INTEGER,
  source TEXT NOT NULL,
  deleted_at INTEGER,
  deleted_by INTEGER
);
CREATE INDEX lib_docs_lib_created ON lib_documents(library_id, created DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX lib_docs_lib_added ON lib_documents(library_id, added DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX lib_docs_created ON lib_documents(created DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX lib_docs_added ON lib_documents(added DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX lib_docs_title ON lib_documents(title COLLATE NOCASE, id) WHERE deleted_at IS NULL;
CREATE INDEX lib_docs_correspondent ON lib_documents(correspondent_id, created DESC);
CREATE INDEX lib_docs_type ON lib_documents(document_type_id, created DESC);
CREATE INDEX lib_docs_modified ON lib_documents(modified);
CREATE UNIQUE INDEX lib_docs_asn ON lib_documents(library_id, archive_serial_number) WHERE archive_serial_number IS NOT NULL;
CREATE INDEX lib_docs_deleted ON lib_documents(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE lib_document_files (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES lib_documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('original', 'archive')),
  blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  original_filename TEXT,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  page_count INTEGER,
  comment TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (document_id, version, kind)
);
CREATE INDEX lib_files_blob ON lib_document_files(blob_sha256);

CREATE TABLE lib_document_text (
  document_id INTEGER NOT NULL REFERENCES lib_documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('text_layer', 'ocr', 'manual', 'import')),
  quality INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, version)
);

CREATE VIRTUAL TABLE lib_fts USING fts5(
  title, body, meta,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '3'
);

CREATE TABLE lib_document_tags (
  tag_id INTEGER NOT NULL REFERENCES lib_tags(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES lib_documents(id) ON DELETE CASCADE,
  library_id INTEGER NOT NULL,
  created TEXT,
  PRIMARY KEY (tag_id, document_id)
) WITHOUT ROWID;
CREATE INDEX lib_doc_tags_doc ON lib_document_tags(document_id, tag_id);
CREATE INDEX lib_doc_tags_sorted ON lib_document_tags(tag_id, library_id, created DESC, document_id DESC);

CREATE TABLE lib_custom_field_values (
  document_id INTEGER NOT NULL REFERENCES lib_documents(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES lib_custom_fields(id) ON DELETE CASCADE,
  value_text TEXT,
  value_num REAL,
  value_date TEXT,
  value_json TEXT,
  PRIMARY KEY (document_id, field_id)
) WITHOUT ROWID;
CREATE INDEX lib_cf_field ON lib_custom_field_values(field_id, document_id);
CREATE INDEX lib_cf_num ON lib_custom_field_values(field_id, value_num) WHERE value_num IS NOT NULL;
CREATE INDEX lib_cf_date ON lib_custom_field_values(field_id, value_date) WHERE value_date IS NOT NULL;
CREATE INDEX lib_cf_text ON lib_custom_field_values(field_id, value_text) WHERE value_text IS NOT NULL;

CREATE TABLE lib_document_events (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL,
  library_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'updated', 'version_added', 'version_switched', 'version_deleted', 'moved', 'deleted', 'restored', 'purged')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'ai', 'workflow', 'system', 'import')),
  actor_id INTEGER,
  ref TEXT,
  changes TEXT NOT NULL DEFAULT '{}',
  reverted_by INTEGER
);
CREATE INDEX lib_events_document ON lib_document_events(document_id, id);
CREATE INDEX lib_events_library_at ON lib_document_events(library_id, at);
CREATE INDEX lib_events_actor ON lib_document_events(actor_type, actor_id, at);
CREATE INDEX lib_events_ref ON lib_document_events(ref) WHERE ref IS NOT NULL;

CREATE TABLE lib_counters (
  library_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (library_id, kind, item_id)
) WITHOUT ROWID;

CREATE TABLE lib_intake (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL,
  channel_ref TEXT,
  filename TEXT,
  sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'stored', 'duplicate', 'failed', 'rejected')),
  document_id INTEGER,
  library_id INTEGER,
  error TEXT,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE UNIQUE INDEX lib_intake_ref ON lib_intake(channel, channel_ref) WHERE channel_ref IS NOT NULL;
CREATE INDEX lib_intake_created ON lib_intake(created_at);

CREATE TABLE intake_folders (
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  hints TEXT NOT NULL DEFAULT '{}',
  subfolders TEXT NOT NULL DEFAULT 'ignore' CHECK (subfolders IN ('ignore', 'tags', 'library')),
  after TEXT NOT NULL DEFAULT 'delete' CHECK (after IN ('delete', 'move')),
  act_as INTEGER REFERENCES users(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE intake_mail_accounts (
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 993,
  security TEXT NOT NULL DEFAULT 'tls' CHECK (security IN ('tls', 'starttls', 'none')),
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  folders TEXT NOT NULL DEFAULT '["INBOX"]',
  rules TEXT NOT NULL DEFAULT '[]',
  after TEXT NOT NULL DEFAULT 'seen' CHECK (after IN ('seen', 'move', 'delete')),
  after_folder TEXT,
  state TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  last_checked_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1
);
`;
