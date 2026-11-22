/**
 * The tools of the MCP server: what an AI agent may do with the archive, each tool behind an API key
 * scope (read, write, delete, metadata, upload, chat). They go through the same code as the web
 * interface – the libraries and roles of the key's user apply to every document.
 */
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { RagService } from '../rag/service.js';
import { canEdit, canRead, hasScope, roleIn, type AccessScope, type ApiScope } from '../access/scope.js';
import type { ArchiveDocument, ChangeOrigin } from '../backend/types.js';
import { applySearchSyntax } from '../http/searchSyntax.js';
import { parseDocumentFilter, documentSort } from '../http/documentQuery.js';
import { applyPlannedUpdate, convertCustomFieldValue, planManualUpdate } from '../processing/applier.js';
import { describeError } from '../util/http.js';
import type { ChatTurn, RagSource } from '../../shared/api.js';

export interface ToolContext {
  ctx: AppContext;
  rag: RagService;
  scope: AccessScope;
  origin: ChangeOrigin;
  signal?: AbortSignal;
}

/** A failure the agent should read (and may correct): returned as a tool result with isError. */
export class ToolError extends Error {}

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  /** The API key scope the tool needs (besides `mcp`). */
  scope: ApiScope;
  /** Also needed for the tool to be offered at all (e.g. the AI chat being switched on). */
  available?: (t: Pick<ToolContext, 'ctx' | 'rag' | 'scope'>) => boolean;
  input: S;
  annotations: Omit<ToolAnnotations, 'title'>;
  run: (args: z.output<S>, t: ToolContext) => Promise<unknown>;
}

const define = <S extends z.ZodType>(def: ToolDef<S>): ToolDef => def as unknown as ToolDef;

// ---------------------------------------------------------------- names of labels and libraries

interface Names {
  tags: Map<number, string>;
  correspondents: Map<number, string>;
  documentTypes: Map<number, string>;
  customFields: Map<number, { name: string; data_type: string; options: Map<string, string> }>;
  libraries: Map<number, string>;
}

async function namesFor(t: Pick<ToolContext, 'ctx' | 'scope'>): Promise<Names> {
  const out: Names = { tags: new Map(), correspondents: new Map(), documentTypes: new Map(), customFields: new Map(), libraries: new Map() };
  for (const lib of await t.ctx.backend(t.scope).metadataScopes()) {
    const meta = await t.ctx.metadata(lib).snapshot();
    for (const x of meta.tags) out.tags.set(x.id, x.name);
    for (const x of meta.correspondents) out.correspondents.set(x.id, x.name);
    for (const x of meta.documentTypes) out.documentTypes.set(x.id, x.name);
    for (const f of meta.customFields) {
      const options = new Map((f.extra_data?.select_options ?? []).map((o) => (typeof o === 'string' ? [o, o] : [String(o.id), o.label]) as [string, string]));
      out.customFields.set(f.id, { name: f.name, data_type: f.data_type, options });
    }
  }
  if (hasLibraries(t.ctx)) for (const l of t.ctx.repos.libraries.list()) if (canRead(t.scope, l.id)) out.libraries.set(l.id, l.name);
  return out;
}

function hasLibraries(ctx: AppContext): boolean {
  try {
    return ctx.archive().capabilities.libraries;
  } catch {
    return false;
  }
}

const day = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : null);
const stripMarks = (s: string) => s.replace(/<\/?mark>/g, '');

function summary(d: ArchiveDocument, n: Names, ctx: AppContext, snippet?: string) {
  return {
    id: d.id,
    title: d.title,
    created: day(d.created_date ?? d.created),
    added: d.added ?? null,
    correspondent: d.correspondent != null ? (n.correspondents.get(d.correspondent) ?? null) : null,
    document_type: d.document_type != null ? (n.documentTypes.get(d.document_type) ?? null) : null,
    tags: (d.tags ?? []).map((id) => n.tags.get(id)).filter((x): x is string => Boolean(x)),
    ...(d.library_id != null ? { library: n.libraries.get(d.library_id) ?? null } : {}),
    archive_serial_number: d.archive_serial_number ?? null,
    url: ctx.documentLink(d.id),
    ...(snippet ? { snippet: stripMarks(snippet) } : {}),
  };
}

function customFieldValues(d: ArchiveDocument, n: Names) {
  return (d.custom_fields ?? []).flatMap((f) => {
    const def = n.customFields.get(f.field);
    if (!def) return [];
    const value = def.data_type === 'select' && f.value != null ? (def.options.get(String(f.value)) ?? f.value) : f.value;
    return [{ name: def.name, type: def.data_type, value }];
  });
}

/** A value for the search syntax, quoted. */
const term = (key: string, value: string) => `${key}:"${value.replace(/"/g, '')}"`;

async function documentOf(t: ToolContext, id: number): Promise<ArchiveDocument> {
  try {
    return await t.ctx.backend(t.scope).getDocument(id);
  } catch {
    throw new ToolError(`There is no document ${id} (or this key cannot see it)`);
  }
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const id = z.number().int().positive();

// ---------------------------------------------------------------- tools

export const TOOLS: ToolDef[] = [
  define({
    name: 'search_documents',
    title: 'Search documents',
    description:
      'Find documents in the archive. `query` takes words of the title and text and the search syntax of Paperless-AI: ' +
      'tag:steuer, correspondent:adac, type:rechnung, created:2024-03, created:2023..2024, added:>2025-01-01, title:"Strom 2024", text:kündigung, asn:17, library:familie, -word (exclude). ' +
      'The other fields narrow the result the same way. Returns one page; pass `cursor` of the answer for the next one. ' +
      'Use get_document for the full text of a document.',
    scope: 'read',
    input: z.object({
      query: z.string().max(500).optional().describe('Words and search syntax, e.g. "rechnung tag:strom created:2024"'),
      tags: z.array(z.string().max(128)).max(20).optional().describe('Tag names – the documents have all of them'),
      correspondent: z.string().max(256).optional().describe('Correspondent name (part of it is enough)'),
      document_type: z.string().max(256).optional().describe('Document type name'),
      library: z.string().max(256).optional().describe('Library name (built-in archive)'),
      created_from: date.optional().describe('Document date from (YYYY-MM-DD)'),
      created_to: date.optional().describe('Document date up to (YYYY-MM-DD)'),
      added_from: date.optional().describe('Added to the archive from (YYYY-MM-DD)'),
      added_to: date.optional().describe('Added to the archive up to (YYYY-MM-DD)'),
      sort: documentSort.optional().describe('Default: relevance with words, else newest document date first (-created)'),
      limit: z.number().int().min(1).max(50).default(10),
      cursor: z.string().max(500).optional().describe('From the previous answer, for the next page'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a, t) => {
      const parts = [a.query ?? ''];
      for (const tag of a.tags ?? []) parts.push(term('tag', tag));
      if (a.correspondent) parts.push(term('correspondent', a.correspondent));
      if (a.document_type) parts.push(term('type', a.document_type));
      if (a.library) parts.push(term('library', a.library));
      const q = parts.join(' ').trim();
      const parsed = parseDocumentFilter({ q: q || undefined, createdFrom: a.created_from, createdTo: a.created_to, addedFrom: a.added_from, addedTo: a.added_to });
      const { filter, terms } = await applySearchSyntax(t.ctx, t.scope, parsed);
      const res = await t.ctx.backend(t.scope).queryDocuments({ filter, sort: a.sort ?? (filter.query ? 'relevance' : '-created'), limit: a.limit, cursor: a.cursor ?? null, withCount: true });
      const n = await namesFor(t);
      return {
        total: res.count,
        documents: res.results.map((d) => summary(d, n, t.ctx, res.snippets?.[d.id])),
        next_cursor: res.nextCursor,
        // How the search syntax was read: what each term matched (or why nothing).
        ...(terms.length ? { understood_as: terms.map((x) => `${x.negate ? '-' : ''}${x.key}:${x.value} → ${x.problem ?? (x.matched.join(', ') || 'nothing')}`) } : {}),
      };
    },
  }),

  define({
    name: 'get_document',
    title: 'Read a document',
    description:
      'A document with its metadata, custom fields and text (OCR / text layer). Long texts come in parts: ' +
      'call again with `text_offset` = `next_text_offset` of the answer.',
    scope: 'read',
    input: z.object({
      id: id.describe('Document id'),
      include_text: z.boolean().default(true),
      text_offset: z.number().int().min(0).default(0),
      max_chars: z.number().int().min(100).max(100_000).default(20_000),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a, t) => {
      const d = await documentOf(t, a.id);
      const n = await namesFor(t);
      const text = d.content ?? '';
      const part = a.include_text ? text.slice(a.text_offset, a.text_offset + a.max_chars) : '';
      const end = a.text_offset + part.length;
      return {
        ...summary(d, n, t.ctx),
        modified: d.modified ?? null,
        original_file_name: d.original_file_name ?? null,
        mime_type: d.mime_type ?? null,
        page_count: d.page_count ?? null,
        custom_fields: customFieldValues(d, n),
        ...(d.library_id != null && t.scope.libraries ? { your_role: roleIn(t.scope, d.library_id) } : {}),
        text_length: text.length,
        ...(a.include_text ? { text: part, ...(end < text.length ? { next_text_offset: end } : {}) } : {}),
      };
    },
  }),

  define({
    name: 'list_labels',
    title: 'List tags, correspondents, types or fields',
    description: 'The tags, correspondents, document types or custom fields this key can see, with the number of documents (custom fields: type and options).',
    scope: 'read',
    input: z.object({
      kind: z.enum(['tags', 'correspondents', 'document_types', 'custom_fields']),
      name_contains: z.string().max(128).optional(),
      limit: z.number().int().min(1).max(1000).default(200),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a, t) => {
      const kinds: Record<typeof a.kind, 'tags' | 'correspondents' | 'documentTypes' | 'customFields'> = { tags: 'tags', correspondents: 'correspondents', document_types: 'documentTypes', custom_fields: 'customFields' };
      const want = a.name_contains?.toLowerCase();
      const n = await namesFor(t);
      const items: Record<string, unknown>[] = [];
      for (const lib of await t.ctx.backend(t.scope).metadataScopes()) {
        const meta = await t.ctx.metadata(lib).snapshot();
        for (const x of meta[kinds[a.kind]] as { id: number; name: string; document_count?: number; data_type?: string; extra_data?: { select_options?: (string | { id: string; label: string })[]; default_currency?: string | null } | null }[]) {
          if (want && !x.name.toLowerCase().includes(want)) continue;
          items.push({
            id: x.id,
            name: x.name,
            ...(x.document_count !== undefined ? { documents: x.document_count } : {}),
            ...(a.kind === 'custom_fields'
              ? {
                  type: x.data_type,
                  ...(x.extra_data?.select_options?.length ? { options: x.extra_data.select_options.map((o) => (typeof o === 'string' ? o : o.label)) } : {}),
                  ...(x.extra_data?.default_currency ? { currency: x.extra_data.default_currency } : {}),
                }
              : {}),
            ...(lib != null ? { library: n.libraries.get(lib) ?? null } : {}),
          });
        }
      }
      items.sort((x, y) => Number(y.documents ?? 0) - Number(x.documents ?? 0) || String(x.name).localeCompare(String(y.name)));
      return { total: items.length, items: items.slice(0, a.limit) };
    },
  }),

  define({
    name: 'list_libraries',
    title: 'List libraries',
    description: 'The libraries of the built-in archive this key can see, with the role in each (viewer, editor, owner).',
    scope: 'read',
    available: (t) => hasLibraries(t.ctx),
    input: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (_a, t) => ({
      libraries: t.ctx.repos.libraries
        .list()
        .filter((l) => canRead(t.scope, l.id))
        .map((l) => ({ id: l.id, name: l.name, description: l.description || null, role: roleIn(t.scope, l.id) })),
    }),
  }),

  define({
    name: 'ask_documents',
    title: 'Ask the archive',
    description:
      'Answer a question from the documents (the AI chat of Paperless-AI): it finds the relevant passages, answers with citations [1], [2] … and lists its sources. ' +
      'Good for questions across many documents ("When does my car insurance end?", "How much did I pay for electricity in 2024?").',
    scope: 'chat',
    available: (t) => t.rag.enabled,
    input: z.object({
      question: z.string().min(1).max(20_000),
      history: z
        .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(50_000) }))
        .max(20)
        .optional()
        .describe('Earlier turns of this conversation'),
      from: date.optional().describe('Only documents dated from'),
      to: date.optional().describe('Only documents dated up to'),
      correspondent: z.string().max(200).optional(),
      document_type: z.string().max(200).optional(),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (a, t) => {
      let answer = '';
      let sources: RagSource[] = [];
      for await (const e of t.rag.chat(a.question, (a.history ?? []) as ChatTurn[], {
        scope: t.scope,
        signal: t.signal,
        filters: { from: a.from, to: a.to, correspondent: a.correspondent, documentType: a.document_type },
      })) {
        if (e.type === 'delta') answer += e.text;
        else if (e.type === 'sources') sources = e.sources;
        else if (e.type === 'error') throw new ToolError(e.message);
      }
      return {
        answer,
        sources: sources.map((s) => ({ n: s.n, document_id: s.documentId, title: s.title, correspondent: s.correspondent, created: s.created, snippet: s.snippet, url: s.url })),
      };
    },
  }),

  define({
    name: 'find_similar_passages',
    title: 'Search by meaning',
    description: 'Passages of documents that match a description by meaning (semantic search of the AI index), not only by words. Returns the documents with the best passage each.',
    scope: 'chat',
    available: (t) => t.rag.enabled,
    input: z.object({
      query: z.string().min(1).max(2000),
      limit: z.number().int().min(1).max(50).default(10),
      from: date.optional(),
      to: date.optional(),
      correspondent: z.string().max(200).optional(),
      document_type: z.string().max(200).optional(),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a, t) => {
      const result = await t.rag.search(a.query, { limit: a.limit, scope: t.scope, filters: { from: a.from, to: a.to, correspondent: a.correspondent, documentType: a.document_type } });
      return {
        results: t.rag.toSources(result).map((s) => ({ document_id: s.documentId, title: s.title, correspondent: s.correspondent, created: s.created, tags: s.tags, snippet: s.snippet, score: Math.round(s.score * 1000) / 1000, url: s.url })),
      };
    },
  }),

  define({
    name: 'update_document',
    title: 'Change a document',
    description:
      'Change the title, date, correspondent, document type, tags, custom fields or archive serial number of a document. Labels are given by name. ' +
      'Names that do not exist yet are created only when the key may manage labels; otherwise use list_labels to find the existing names. ' +
      'Every change is recorded in the change log of the document and can be undone there.',
    scope: 'write',
    input: z.object({
      id: id,
      title: z.string().min(1).max(512).optional(),
      created: date.optional().describe('Document date (YYYY-MM-DD)'),
      correspondent: z.string().max(256).nullable().optional().describe('Name; null removes it'),
      document_type: z.string().max(256).nullable().optional().describe('Name; null removes it'),
      tags: z.array(z.string().max(128)).max(200).optional().describe('Replaces all tags'),
      add_tags: z.array(z.string().max(128)).max(100).optional(),
      remove_tags: z.array(z.string().max(128)).max(100).optional(),
      custom_fields: z
        .record(z.string().max(128), z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe('Field name → value (select fields: the option; null clears the field)'),
      archive_serial_number: z.number().int().min(0).nullable().optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (a, t) => {
      const doc = await documentOf(t, a.id);
      if (!canEdit(t.scope, doc.library_id)) throw new ToolError('This key can only read this document (viewer of its library)');
      const meta = t.ctx.metadata(doc.library_id ?? null);
      await meta.snapshot();
      let tags: string[] | undefined;
      if (a.tags || a.add_tags?.length || a.remove_tags?.length) {
        const current = a.tags ?? (doc.tags ?? []).map((tid) => meta.tagName(tid)).filter((x): x is string => Boolean(x));
        const removed = new Set((a.remove_tags ?? []).map((x) => x.trim().toLowerCase()));
        tags = [...new Map([...current, ...(a.add_tags ?? [])].filter((x) => !removed.has(x.trim().toLowerCase())).map((x) => [x.trim().toLowerCase(), x.trim()])).values()];
      }
      // New labels only with the right to manage them.
      if (!hasScope(t.scope, 'metadata')) {
        const missing: string[] = [];
        if (tags?.length) missing.push(...(await meta.resolveTags(tags, false)).missing.map((x) => `tag “${x}”`));
        if (a.correspondent?.trim() && (await meta.resolveCorrespondent(a.correspondent, false)).id == null) missing.push(`correspondent “${a.correspondent}”`);
        if (a.document_type?.trim() && (await meta.resolveDocumentType(a.document_type, false)).id == null) missing.push(`document type “${a.document_type}”`);
        if (missing.length) throw new ToolError(`Not found: ${missing.join(', ')}. This key may not create labels – pick existing names (list_labels).`);
      }
      const plan = await planManualUpdate(t.ctx, doc, {
        ...(a.title !== undefined ? { title: a.title } : {}),
        ...(a.created ? { created: a.created } : {}),
        ...(a.correspondent !== undefined ? { correspondent: a.correspondent } : {}),
        ...(a.document_type !== undefined ? { documentType: a.document_type } : {}),
        ...(tags ? { tags } : {}),
      });
      if (a.archive_serial_number !== undefined && a.archive_serial_number !== (doc.archive_serial_number ?? null)) plan.patch.archive_serial_number = a.archive_serial_number;
      if (a.custom_fields && Object.keys(a.custom_fields).length) {
        const fields = new Map((doc.custom_fields ?? []).map((f) => [f.field, f.value]));
        for (const [name, raw] of Object.entries(a.custom_fields)) {
          const field = meta.customFieldByName(name);
          if (!field) throw new ToolError(`The custom field “${name}” does not exist (list_labels with kind custom_fields)`);
          if (raw === null || raw === '') {
            fields.delete(field.id);
            continue;
          }
          let text = String(raw);
          // Select fields: the label of an option (or its id).
          if (field.data_type === 'select') {
            const option = (field.extra_data?.select_options ?? []).find((o) => (typeof o === 'string' ? o : o.label).toLowerCase() === text.toLowerCase() || (typeof o !== 'string' && o.id === text));
            if (!option) throw new ToolError(`“${text}” is not an option of ${field.name}`);
            text = typeof option === 'string' ? option : option.label;
          }
          const value = convertCustomFieldValue(field, text);
          if (value === undefined) throw new ToolError(`“${raw}” is not a valid value for ${field.name} (${field.data_type})`);
          fields.set(field.id, value);
        }
        const next = [...fields.entries()].map(([field, value]) => ({ field, value }));
        if (JSON.stringify(next) !== JSON.stringify((doc.custom_fields ?? []).map((f) => ({ field: f.field, value: f.value })))) plan.patch.custom_fields = next;
      }
      const changed = Object.keys(plan.patch);
      if (!changed.length) return { id: doc.id, changed: [], notes: plan.notes.length ? plan.notes : ['Nothing to change'] };
      const updated = await applyPlannedUpdate(t.ctx, doc, plan, { source: 'edit', origin: t.origin, scope: t.scope });
      const n = await namesFor(t);
      return { changed, ...(plan.notes.length ? { notes: plan.notes } : {}), document: { ...summary(updated, n, t.ctx), custom_fields: customFieldValues(updated, n) } };
    },
  }),

  define({
    name: 'delete_document',
    title: 'Delete a document',
    description: 'Move a document to the trash (built-in archive: it can be restored there until the trash is emptied; with Paperless-ngx: its trash).',
    scope: 'delete',
    input: z.object({ id }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (a, t) => {
      const doc = await documentOf(t, a.id);
      await t.ctx.backend(t.scope).deleteDocument(doc.id, t.origin);
      t.ctx.events.emit({ type: 'document.deleted', id: doc.id, origin: t.origin, libraryId: doc.library_id ?? null });
      return { deleted: doc.id, title: doc.title, in_trash: true };
    },
  }),

  define({
    name: 'upload_document',
    title: 'Add a document',
    description:
      'Add a file (PDF, image, office document …) to the archive, as base64. Paperless-AI stores it, reads its text and – unless switched off – analyses it with the AI (title, tags, correspondent …). ' +
      'Given labels are set as hints.',
    scope: 'upload',
    input: z.object({
      filename: z.string().min(1).max(255).describe('With extension, e.g. "invoice.pdf"'),
      content_base64: z.string().min(4).describe('The file, base64 encoded'),
      title: z.string().max(512).optional(),
      created: date.optional(),
      tags: z.array(z.string().max(128)).max(50).optional(),
      correspondent: z.string().max(256).optional(),
      document_type: z.string().max(256).optional(),
      library: z.string().max(256).optional().describe('Library name (built-in archive); default: your default library'),
      analyse: z.boolean().default(true).describe('Run the AI analysis'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (a, t) => {
      const data = Buffer.from(a.content_base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (!data.length) throw new ToolError('The file is empty (content_base64 is not base64?)');
      const maxMb = t.ctx.cfg.archive.builtin.maxUploadMb;
      if (data.length > maxMb * 1024 * 1024) throw new ToolError(`The file is larger than ${maxMb} MB`);
      let libraryId: number | undefined;
      if (a.library) {
        if (!hasLibraries(t.ctx)) throw new ToolError('Libraries exist in the built-in archive only');
        const lib = t.ctx.repos.libraries.list().find((l) => l.name.toLowerCase() === a.library!.trim().toLowerCase() && canRead(t.scope, l.id));
        if (!lib) throw new ToolError(`No library “${a.library}” (list_libraries)`);
        libraryId = lib.id;
      }
      const name = a.filename.replace(/[/\\]/g, '_');
      const res = await t.ctx.backend(t.scope).ingest({ data: new Uint8Array(data), filename: name }, 'api', {
        ...(libraryId ? { libraryId } : {}),
        ...(a.title ? { title: a.title } : {}),
        ...(a.created ? { created: a.created } : {}),
        ...(a.tags?.length ? { tags: a.tags } : {}),
        ...(a.correspondent ? { correspondent: a.correspondent } : {}),
        ...(a.document_type ? { documentType: a.document_type } : {}),
        ...(a.analyse ? {} : { skipAnalysis: true }),
      });
      if (res.status === 'rejected' || res.status === 'failed') throw new ToolError(`Not added: ${res.reason ?? res.status}`);
      return {
        status: res.status,
        ...(res.documentId ? { document_id: res.documentId, url: t.ctx.documentLink(res.documentId) } : {}),
        ...(res.status === 'duplicate' ? { note: 'The same file is already in the archive' } : {}),
        ...(res.taskId ? { task_id: res.taskId } : {}),
      };
    },
  }),
];

/** The tools the scope may use (and that are available here). */
export function toolsFor(t: Pick<ToolContext, 'ctx' | 'rag' | 'scope'>): ToolDef[] {
  return TOOLS.filter((tool) => hasScope(t.scope, tool.scope) && (!tool.available || tool.available(t)));
}

/** The JSON schema of a tool's input, as MCP lists it. */
export function inputSchema(tool: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** Run a tool: its result as MCP content (text with the JSON, and the JSON as structured content). */
export async function callTool(tool: ToolDef, args: unknown, t: ToolContext): Promise<{ content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }> {
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    return { content: [{ type: 'text', text: `Invalid arguments – ${issues}` }], isError: true };
  }
  try {
    const result = (await tool.run(parsed.data, t)) as Record<string, unknown>;
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
  } catch (err) {
    const message = err instanceof ToolError ? err.message : describeError(err);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

