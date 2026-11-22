/**
 * Workflows: when something happens (trigger), if the document matches (conditions), then do
 * something (actions). Shared by the server and the web interface. See docs/standalone/workflows.md.
 */
import type { PromptRuleOverrides } from './promptRules.js';
import type { EventKind } from './api.js';

export const INTAKE_CHANNELS = ['upload', 'api', 'folder', 'mail', 'webdav', 'import', 'share', 'scan', 'webhook'] as const;
export type IntakeChannelName = (typeof INTAKE_CHANNELS)[number];

export type Trigger =
  | { type: 'document.added'; channels?: IntakeChannelName[] }
  | { type: 'analysis.before' }
  | { type: 'document.processed' }
  /** Fields: title, tags, correspondent, document_type, created, custom_fields, library_id … (empty = any). */
  | { type: 'document.updated'; fields?: string[] }
  | { type: 'document.version_added' }
  /** Cron expression; the documents matching the filter (at most `limit`) get a run each time. */
  | { type: 'schedule'; cron: string; query?: string; tags?: string[]; limit?: number }
  /** A date of the document plus `offsetDays` is today. */
  | { type: 'date.reached'; source: 'created' | 'custom_field' | 'calendar'; field?: string; offsetDays: number }
  | { type: 'manual' };

export type TriggerType = Trigger['type'];

export type Condition =
  | { type: 'tags'; mode: 'any' | 'all' | 'none'; names: string[] }
  | { type: 'correspondent'; names: string[] }
  | { type: 'document_type'; names: string[] }
  | { type: 'storage_path'; names: string[] }
  | { type: 'owner'; names: string[] }
  | { type: 'custom_field'; name: string; op: 'set' | 'equals' | 'gte' | 'lte'; value?: string }
  | { type: 'library'; ids: number[] }
  | { type: 'channel'; channels: IntakeChannelName[] }
  | { type: 'mail_from'; contains: string }
  | { type: 'mail_subject'; contains: string }
  | { type: 'folder_path'; contains: string }
  /** Glob pattern (`*`, `?`), case-insensitive. */
  | { type: 'filename'; pattern: string }
  | { type: 'mime_type'; types: string[] }
  | { type: 'page_count'; min?: number; max?: number }
  | { type: 'text'; contains?: string; regex?: string }
  | { type: 'created'; from?: string; to?: string }
  | { type: 'added_within'; days: number }
  | { type: 'processed'; value: boolean }
  | { type: 'analysis_failed'; value: boolean }
  /** One short AI call: the answer must be `expect`. */
  | { type: 'ai_question'; question: string; expect: boolean };

export type ConditionType = Condition['type'];

export interface ConditionGroup {
  op: 'all' | 'any';
  items: (Condition | ConditionGroup)[];
}

export type Action =
  | { type: 'set_title'; template: string }
  | { type: 'add_tags'; names: string[] }
  | { type: 'remove_tags'; names: string[] }
  | { type: 'set_correspondent'; name: string | null }
  | { type: 'set_document_type'; name: string | null }
  | { type: 'set_storage_path'; name: string | null }
  | { type: 'set_custom_field'; name: string; value: string }
  | { type: 'assign_asn' }
  | { type: 'set_owner'; username: string | null }
  | { type: 'move_to_library'; libraryId: number }
  /** The prompt rule action: a library prompt (null = the system prompt) and processing overrides. */
  | { type: 'analyze'; prompt: number | string | null; overrides: PromptRuleOverrides }
  | { type: 'skip_analysis' }
  | { type: 'run_ocr' }
  | { type: 'ai_extract'; question: string; field: string }
  | { type: 'add_calendar_event'; source: 'created' | 'custom_field'; field?: string; offsetDays: number; title: string; kind: EventKind }
  | { type: 'notify_email'; to: string[]; users: number[]; groups: number[]; subject: string; body: string }
  | { type: 'notify_webhook'; url: string; preset: 'generic' | 'ntfy' | 'gotify'; secret?: string; /** Dry runs only: the host of the real address (the action gets an inert one). */ previewHost?: string }
  | { type: 'notify_inapp'; users: number[]; groups: number[]; title: string; body: string }
  /** Needs `confirm: true` – set explicitly in the editor. */
  | { type: 'move_to_trash'; confirm: boolean };

export type ActionType = Action['type'];

export interface WorkflowDefinition {
  name: string;
  enabled: boolean;
  /** null = global (administrators only). */
  libraryId: number | null;
  trigger: Trigger;
  conditions: ConditionGroup;
  actions: Action[];
  /** Do not evaluate later workflows of the same trigger for this document (prompt rule semantics). */
  stopAfterMatch: boolean;
  /** Libraries `move_to_library` may target. */
  allowedLibraries: number[];
}

export interface Workflow extends WorkflowDefinition {
  id: number;
  position: number;
  revision: number;
  suspendedReason: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  /** Read-only (prompt rules from the environment variable). */
  locked?: boolean;
  stats?: { runs7d: number; failed7d: number; lastRun: { status: RunStatus; at: number } | null; rateLimited: boolean };
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'not_matched';

export interface RunStep {
  idx: number;
  kind: 'condition' | 'action';
  name: string;
  status: 'matched' | 'not_matched' | 'done' | 'failed' | 'skipped' | 'planned';
  details: Record<string, unknown>;
  durationMs: number | null;
}

export interface WorkflowRun {
  id: number;
  workflowId: number;
  workflowName: string;
  revision: number;
  documentId: number | null;
  documentTitle?: string | null;
  trigger: TriggerType;
  status: RunStatus;
  dryRun: boolean;
  error: string | null;
  queuedAt: number;
  finishedAt: number | null;
  steps?: RunStep[];
}

/** POST /api/workflows/dry-run */
export interface DryRunResult {
  matched: boolean;
  steps: RunStep[];
  /** Field changes the actions would make (before → after). */
  changes: { field: string; before: unknown; after: unknown }[];
  tokens: number;
}

export function emptyGroup(op: 'all' | 'any' = 'all'): ConditionGroup {
  return { op, items: [] };
}

export function isGroup(c: Condition | ConditionGroup): c is ConditionGroup {
  return 'items' in c && 'op' in c;
}

/** Triggers that exist only with the built-in archive. */
export const BUILTIN_ONLY_TRIGGERS: TriggerType[] = ['document.version_added'];
export const BUILTIN_ONLY_ACTIONS: ActionType[] = ['move_to_library'];

/** Actions that shape the analysis – the only ones allowed for `analysis.before`. */
export const ANALYSIS_ACTIONS: ActionType[] = ['analyze', 'skip_analysis'];

export const TEMPLATE_FIELDS = ['title', 'correspondent', 'document_type', 'created', 'created_year', 'created_month', 'added', 'library', 'asn', 'mail_from', 'mail_subject', 'filename'] as const;
