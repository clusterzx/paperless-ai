/** Migration assistant Paperless-ngx → built-in archive (docs/standalone/migration.md). */
import type { LibraryRole } from './api.js';

export interface MigrationRule {
  library: string;
  /** Paperless-ngx user name of the owner. */
  owner?: string;
  tag?: string;
  storagePath?: string;
  customField?: { name: string; value: string };
}

export type MigrationStrategy =
  | { kind: 'single'; libraryName: string }
  | { kind: 'owner'; sharedName: string }
  | { kind: 'rules'; rules: MigrationRule[]; defaultLibrary: string };

export interface MigrationOptions {
  /** Also store the archived PDF of Paperless-ngx (more storage; the text is imported anyway). */
  archived: boolean;
  /** Create Paperless-AI accounts (disabled, without password) for Paperless-ngx users without one. */
  createUsers: boolean;
  /** Documents downloaded at the same time. */
  concurrency: number;
  /**
   * Import with new ids (into an archive with documents of its own): analyse the imported documents
   * with the AI (next scan). Off: they keep the metadata from Paperless-ngx and are not analysed.
   */
  analyze?: boolean;
}

export interface MigrationReport {
  serverVersion: string | null;
  /** The token belongs to a superuser – it sees every document. */
  superuser: boolean;
  counts: { documents: number; pages: number; tags: number; correspondents: number; documentTypes: number; customFields: number; storagePaths: number; users: number | null; groups: number | null; notes: number };
  storage: { estimatedBytes: number; sampled: number; freeBytes: number | null };
  /** Not transferred (null: not readable with this token). */
  notTransferred: { workflows: number | null; mailAccounts: number | null; mailRules: number | null; savedViews: number | null; shareLinks: number | null; matchingRules: number; notes: number };
  /** Custom field values that do not fit their type (imported as they are). */
  fieldProblems: { documentId: number; field: string; value: string }[];
  owners: { name: string; documents: number }[];
}

export interface MigrationPlan {
  libraries: { name: string; documents: number; members: { user: string; role: LibraryRole }[] }[];
  users: { ngx: string; local: string | null; action: 'match' | 'create' | 'skip' }[];
  /** Users who would see more than in Paperless-ngx. */
  widened: { user: string; library: string; documents: number }[];
}

export type MigrationState = 'idle' | 'importing' | 'paused' | 'imported' | 'failed' | 'cutover';

export interface MigrationStatus {
  state: MigrationState;
  mode: 'paperless' | 'builtin';
  running: boolean;
  strategy: MigrationStrategy | null;
  options: MigrationOptions | null;
  counts: { total: number; pending: number; imported: number; failed: number; skipped: number; deleted: number };
  errors: { id: number; error: string }[];
  startedAt: number | null;
  finishedAt: number | null;
  lastSyncAt: number | null;
  cutoverAt: number | null;
  libraries: number[];
  /**
   * Documents of the built-in archive that did not come from this migration (added in the built-in
   * archive itself). The migration keeps the ids of Paperless-ngx, so it cannot start next to them.
   */
  ownDocuments: number;
  /**
   * keep: the documents keep their Paperless-ngx ids (moving a companion installation, the AI
   * history stays valid). new: they get new ids (import into an archive with documents of its own).
   */
  ids: 'keep' | 'new';
}

export interface ExportResult {
  format: 'ngx' | 'plain';
  directory: string;
  documents: number;
  files: number;
  bytes: number;
}
