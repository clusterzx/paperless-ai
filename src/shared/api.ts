/**
 * Types shared between the server and the web UI (API contract).
 * Only types live here so the browser bundle does not pull in server code.
 */

export interface CustomFieldValue {
  field: number;
  value: unknown;
}

/** State of a document before the AI changed it (used for undo). */
export interface DocumentSnapshot {
  title?: string;
  tags?: number[];
  correspondent?: number | null;
  document_type?: number | null;
  created?: string | null;
  custom_fields?: CustomFieldValue[];
}

export interface HistoryItem {
  id: number;
  documentId: number;
  createdAt: number;
  source: string;
  provider: string | null;
  model: string | null;
  title: string | null;
  correspondent: string | null;
  documentType: string | null;
  tags: number[];
  totalTokens: number;
  revertedAt: number | null;
  canRevert: boolean;
  before: DocumentSnapshot;
  after: Record<string, unknown>;
  suggestion: unknown;
}

export interface HistoryQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  tag?: number;
  correspondent?: string;
  source?: string;
  documentId?: number;
  sort?: 'createdAt' | 'documentId' | 'title' | 'correspondent';
  order?: 'asc' | 'desc';
  includeReverted?: boolean;
}

export interface HistoryPage {
  items: (HistoryItem & { tagNames: string[]; url: string })[];
  total: number;
  filtered: number;
  page: number;
  pageSize: number;
}

export interface UsageStats {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  analyses: number;
  avgPromptTokens: number;
  avgCompletionTokens: number;
  avgTotalTokens: number;
  avgDurationMs: number;
  distribution: { range: string; count: number }[];
  byFeature: { feature: string; calls: number; tokens: number }[];
}

/** Result of an AI analysis of one document. */
export interface DocumentSuggestion {
  title: string | null;
  correspondent: string | null;
  tags: string[];
  document_type: string | null;
  document_date: string | null;
  language: string | null;
  custom_fields: { field_name: string; value: string }[];
}

export interface AnalysisResult {
  suggestion: DocumentSuggestion;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  model: string;
  provider: string;
  durationMs: number;
  truncated: boolean;
}

export interface NamedItem {
  id: number;
  name: string;
  document_count?: number;
  color?: string;
}

export interface DocumentSummary {
  id: number;
  title: string;
  created: string | null;
  correspondent: number | null;
  document_type: number | null;
  tags: number[];
}

export interface DocumentDetail extends DocumentSummary {
  content: string;
  original_file_name?: string | null;
  custom_fields: CustomFieldValue[];
  user_can_change?: boolean;
  modified?: string;
  added?: string;
  url: string;
}

export interface ProcessingJob {
  documentId: number;
  title: string | null;
  source: string;
  startedAt: number;
  stage: string;
}

export interface ProcessingStatus {
  running: boolean;
  paused: boolean;
  automatic: boolean;
  scanning: boolean;
  current: ProcessingJob[];
  queued: number;
  lastScanAt: number | null;
  nextScanAt: number | null;
  lastError: string | null;
  lastProcessed: { documentId: number; title: string | null; processedAt: number } | null;
  processedToday: number;
  counts: { processed: number; failed: number; skipped: number };
}

export interface DashboardData {
  version: string;
  paperless: {
    connected: boolean;
    error?: string;
    version?: string | null;
    apiVersion?: number | null;
    documents: number;
    tags: number;
    correspondents: number;
    documentTypes: number;
  };
  processing: ProcessingStatus;
  usage: UsageStats;
  timeline: { date: string; count: number }[];
  documentTypes: { name: string; count: number }[];
  ai: { provider: string; model: string };
  rag: { enabled: boolean };
}

export interface RagStatus {
  enabled: boolean;
  state: 'disabled' | 'idle' | 'indexing' | 'error';
  documents: number;
  chunks: number;
  embedded: number;
  embeddingProvider: string;
  embeddingModel: string | null;
  lastSyncAt: number | null;
  lastError: string | null;
  progress: { phase: string; done: number; total: number } | null;
  vectorSearch: boolean;
}

export interface RagSource {
  /** Citation number used in the answer, e.g. [1]. */
  n: number;
  documentId: number;
  title: string;
  correspondent: string | null;
  documentType: string | null;
  created: string | null;
  tags: string[];
  snippet: string;
  score: number;
  url: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Events sent over the RAG/document chat SSE streams. */
export type ChatStreamEvent =
  | { type: 'sources'; sources: RagSource[] }
  | { type: 'status'; message: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; model?: string }
  | { type: 'error'; message: string };

export interface SessionInfo {
  authenticated: boolean;
  setupRequired: boolean;
  /** No user account exists yet (first start). */
  needsUser: boolean;
  user?: { id: number; username: string };
  version: string;
  features: { rag: boolean };
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface LogEntryDto {
  id: number;
  time: number;
  level: string;
  module?: string;
  msg: string;
  data?: Record<string, unknown>;
}
