/**
 * In-memory fake of the Paperless-ngx REST API (the subset used by the client).
 *
 * - token authentication (`Authorization: Token …`)
 * - API version negotiation via the Accept header (406 outside [minVersion, maxVersion])
 * - paginated lists without the `all` field for API ≥ 10
 * - document PATCH with `created` (API ≥ 9) vs `created_date` (API < 9)
 * - 400 on duplicate names when creating tags/correspondents/document types/custom fields
 * - every request is recorded for assertions
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockPaperlessOptions {
  token?: string;
  /** Highest API version the server accepts (3.x: 10, 2.16–2.20: 9, 2.14: 7). */
  maxVersion?: number;
  /** Lowest API version the server accepts (3.x: 9). */
  minVersion?: number;
  /** Version used when the client does not ask for one. Defaults to minVersion. */
  defaultVersion?: number;
  /** Value of the X-Version response header. */
  serverVersion?: string;
  user?: { id: number; username: string; is_superuser?: boolean };
}

export interface MockDoc {
  id: number;
  title: string;
  content: string;
  tags: number[];
  correspondent: number | null;
  document_type: number | null;
  /** Date part (YYYY-MM-DD). */
  created: string;
  modified: string;
  added: string;
  custom_fields: { field: number; value: unknown }[];
  user_can_change: boolean;
  original_file_name: string | null;
  owner: number | null;
}

export interface MockNamed {
  id: number;
  name: string;
  matching_algorithm?: number;
  color?: string;
}

export interface MockCustomField {
  id: number;
  name: string;
  data_type: string;
  extra_data?: Record<string, unknown> | null;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  version: number;
}

export interface InterceptResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Collection = 'tags' | 'correspondents' | 'document_types' | 'custom_fields';

const BASE_TIME = Date.UTC(2024, 0, 1, 12, 0, 0);

export class MockPaperless {
  readonly token: string;
  maxVersion: number;
  minVersion: number;
  defaultVersion: number;
  serverVersion: string;
  user: { id: number; username: string; is_superuser?: boolean };

  readonly docs = new Map<number, MockDoc>();
  readonly tags = new Map<number, MockNamed>();
  readonly correspondents = new Map<number, MockNamed>();
  readonly documentTypes = new Map<number, MockNamed>();
  readonly customFields = new Map<number, MockCustomField>();
  readonly requests: RecordedRequest[] = [];
  /** Optional hook to fake errors / slow responses for specific requests. */
  intercept: ((req: RecordedRequest) => InterceptResult | undefined | Promise<InterceptResult | undefined>) | null = null;

  private server: http.Server | null = null;
  private nextId = 1000;
  private clock = 0;

  constructor(opts: MockPaperlessOptions = {}) {
    this.token = opts.token ?? 'test-token';
    this.maxVersion = opts.maxVersion ?? 10;
    this.minVersion = opts.minVersion ?? 1;
    this.defaultVersion = opts.defaultVersion ?? this.minVersion;
    this.serverVersion = opts.serverVersion ?? (this.maxVersion >= 10 ? '3.0.0' : this.maxVersion >= 9 ? '2.20.0' : '2.14.7');
    this.user = opts.user ?? { id: 3, username: 'paperless-ai', is_superuser: false };
  }

  // ------------------------------------------------------------------ lifecycle

  get url(): string {
    const addr = this.server?.address() as AddressInfo | null;
    if (!addr) throw new Error('Mock Paperless server not started');
    return `http://127.0.0.1:${addr.port}`;
  }

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: String(err) }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return this;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  // ------------------------------------------------------------------ seeding & inspection

  private tick(): string {
    this.clock++;
    return new Date(BASE_TIME + this.clock * 1000).toISOString();
  }

  addDocument(d: Partial<MockDoc> & { id?: number }): MockDoc {
    const id = d.id ?? this.nextId++;
    const now = this.tick();
    const doc: MockDoc = {
      id,
      title: d.title ?? `Document ${id}`,
      content: d.content ?? '',
      tags: d.tags ?? [],
      correspondent: d.correspondent ?? null,
      document_type: d.document_type ?? null,
      created: d.created ?? '2024-01-01',
      modified: d.modified ?? now,
      added: d.added ?? now,
      custom_fields: d.custom_fields ?? [],
      user_can_change: d.user_can_change ?? true,
      original_file_name: d.original_file_name ?? `${id}.pdf`,
      owner: d.owner ?? this.user.id,
    };
    this.docs.set(id, doc);
    return doc;
  }

  /** Change a document "from the Paperless UI" (bumps `modified`). */
  editDocument(id: number, patch: Partial<MockDoc>): MockDoc {
    const doc = this.docs.get(id);
    if (!doc) throw new Error(`No document ${id}`);
    Object.assign(doc, patch, { modified: this.tick() });
    return doc;
  }

  deleteDocument(id: number): void {
    this.docs.delete(id);
  }

  private addNamed(map: Map<number, MockNamed>, name: string, id?: number, extra: Partial<MockNamed> = {}): MockNamed {
    const item: MockNamed = { id: id ?? this.nextId++, name, matching_algorithm: 1, ...extra };
    map.set(item.id, item);
    return item;
  }

  addTag(name: string, id?: number): MockNamed {
    return this.addNamed(this.tags, name, id, { color: '#a6cee3' });
  }

  addCorrespondent(name: string, id?: number): MockNamed {
    return this.addNamed(this.correspondents, name, id);
  }

  addDocumentType(name: string, id?: number): MockNamed {
    return this.addNamed(this.documentTypes, name, id);
  }

  addCustomField(name: string, dataType: string, extra: Record<string, unknown> | null = null, id?: number): MockCustomField {
    const f: MockCustomField = { id: id ?? this.nextId++, name, data_type: dataType, extra_data: extra };
    this.customFields.set(f.id, f);
    return f;
  }

  tagByName(name: string): MockNamed | undefined {
    return [...this.tags.values()].find((t) => t.name.toLowerCase() === name.toLowerCase());
  }

  correspondentByName(name: string): MockNamed | undefined {
    return [...this.correspondents.values()].find((t) => t.name.toLowerCase() === name.toLowerCase());
  }

  documentTypeByName(name: string): MockNamed | undefined {
    return [...this.documentTypes.values()].find((t) => t.name.toLowerCase() === name.toLowerCase());
  }

  customFieldByName(name: string): MockCustomField | undefined {
    return [...this.customFields.values()].find((t) => t.name.toLowerCase() === name.toLowerCase());
  }

  /** Recorded requests filtered by method and (exact or regex) path. */
  calls(method: string, path?: string | RegExp): RecordedRequest[] {
    return this.requests.filter(
      (r) => r.method === method && (path === undefined || (typeof path === 'string' ? r.path === path : path.test(r.path))),
    );
  }

  patches(id?: number): RecordedRequest[] {
    return this.calls('PATCH', id === undefined ? /^\/api\/documents\/\d+\/$/ : `/api/documents/${id}/`);
  }

  clearRequests(): void {
    this.requests.length = 0;
  }

  // ------------------------------------------------------------------ request handling

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown = undefined;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const accept = String(req.headers.accept ?? '');
    const vMatch = /version=(\d+)/.exec(accept);
    const requested = vMatch ? Number(vMatch[1]) : null;
    const version = requested ?? this.defaultVersion;
    const record: RecordedRequest = {
      method: req.method ?? 'GET',
      path: u.pathname,
      query: Object.fromEntries(u.searchParams.entries()),
      headers: req.headers,
      body,
      version,
    };
    this.requests.push(record);

    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      const isBuffer = Buffer.isBuffer(payload);
      res.writeHead(status, {
        'Content-Type': isBuffer ? 'image/webp' : 'application/json',
        'X-Api-Version': String(this.maxVersion),
        'X-Version': this.serverVersion,
        ...headers,
      });
      res.end(isBuffer ? payload : payload === undefined ? '' : JSON.stringify(payload));
    };

    if (req.headers.authorization !== `Token ${this.token}`) return send(401, { detail: 'Invalid token.' });
    if (requested !== null && (requested > this.maxVersion || requested < this.minVersion)) {
      return send(406, { detail: 'Invalid version in "Accept" header.' });
    }
    if (this.intercept) {
      const r = await this.intercept(record);
      if (r) return send(r.status, r.body, r.headers);
    }

    const path = u.pathname;
    const q = u.searchParams;
    let m: RegExpExecArray | null;

    if (path === '/api/ui_settings/' && record.method === 'GET') {
      return send(200, { user: this.user, settings: { version: this.serverVersion }, permissions: [] });
    }
    if (path === '/api/statistics/' && record.method === 'GET') {
      return send(200, {
        documents_total: this.docs.size,
        documents_inbox: 0,
        tag_count: this.tags.size,
        correspondent_count: this.correspondents.size,
        document_type_count: this.documentTypes.size,
      });
    }
    if (path === '/api/documents/' && record.method === 'GET') return send(200, this.listDocuments(q, version, u));
    if ((m = /^\/api\/documents\/(\d+)\/$/.exec(path))) {
      const doc = this.docs.get(Number(m[1]));
      if (!doc) return send(404, { detail: 'No Document matches the given query.' });
      if (record.method === 'GET') return send(200, this.serialize(doc, version));
      if (record.method === 'PATCH') return this.patchDocument(doc, body as Record<string, unknown>, version, send);
    }
    if ((m = /^\/api\/documents\/(\d+)\/thumb\/$/.exec(path)) && record.method === 'GET') {
      if (!this.docs.has(Number(m[1]))) return send(404, { detail: 'Not found.' });
      return send(200, Buffer.from(`THUMB-${m[1]}`));
    }
    if ((m = /^\/api\/(tags|correspondents|document_types|custom_fields)\/$/.exec(path))) {
      const collection = m[1] as Collection;
      if (record.method === 'GET') return send(200, this.listCollection(collection, q, version, u));
      if (record.method === 'POST') return this.create(collection, body as Record<string, unknown>, send);
    }
    return send(404, { detail: 'Not found.' });
  }

  private paginate<T>(items: T[], q: URLSearchParams, version: number, u: URL, ids: number[]) {
    const pageSize = Math.max(1, Number(q.get('page_size') ?? 25));
    const page = Math.max(1, Number(q.get('page') ?? 1));
    const start = (page - 1) * pageSize;
    const results = items.slice(start, start + pageSize);
    const link = (p: number) => {
      const next = new URL(u.toString());
      next.searchParams.set('page', String(p));
      return `${this.url}${next.pathname}${next.search}`;
    };
    const out: Record<string, unknown> = {
      count: items.length,
      next: start + pageSize < items.length ? link(page + 1) : null,
      previous: page > 1 ? link(page - 1) : null,
      results,
    };
    if (version < 10) out.all = ids;
    return out;
  }

  private serialize(doc: MockDoc, version: number): Record<string, unknown> {
    const out: Record<string, unknown> = {
      id: doc.id,
      title: doc.title,
      content: doc.content,
      tags: [...doc.tags],
      correspondent: doc.correspondent,
      document_type: doc.document_type,
      storage_path: null,
      created: version >= 9 ? doc.created : `${doc.created}T00:00:00+01:00`,
      modified: doc.modified,
      added: doc.added,
      archive_serial_number: null,
      original_file_name: doc.original_file_name,
      owner: doc.owner,
      user_can_change: doc.user_can_change,
      custom_fields: doc.custom_fields.map((f) => ({ ...f })),
      notes: [],
      mime_type: 'application/pdf',
    };
    if (version < 9) out.created_date = doc.created;
    return out;
  }

  private listDocuments(q: URLSearchParams, version: number, u: URL) {
    let docs = [...this.docs.values()];
    const tagsIn = q.get('tags__id__in');
    if (tagsIn) {
      const wanted = tagsIn.split(',').map(Number);
      docs = docs.filter((d) => d.tags.some((t) => wanted.includes(t)));
    }
    const idIn = q.get('id__in');
    if (idIn) {
      const wanted = idIn.split(',').map(Number);
      docs = docs.filter((d) => wanted.includes(d.id));
    }
    const text = q.get('title_content') ?? q.get('text');
    if (text) {
      const needle = text.toLowerCase();
      docs = docs.filter((d) => d.title.toLowerCase().includes(needle) || d.content.toLowerCase().includes(needle));
    }
    const ordering = q.get('ordering') ?? 'id';
    const desc = ordering.startsWith('-');
    const key = ordering.replace(/^-/, '') as keyof MockDoc;
    docs.sort((a, b) => {
      const av = a[key] as string | number;
      const bv = b[key] as string | number;
      const c = av < bv ? -1 : av > bv ? 1 : a.id - b.id;
      return desc ? -c : c;
    });
    const fields = q.get('fields')?.split(',').filter(Boolean);
    const serialized = docs.map((d) => {
      const full = this.serialize(d, version);
      if (q.get('truncate_content') === 'true') full.content = d.content.slice(0, 300);
      return fields ? Object.fromEntries(fields.filter((f) => f in full).map((f) => [f, full[f]])) : full;
    });
    return this.paginate(serialized, q, version, u, docs.map((d) => d.id));
  }

  private collection(c: Collection): Map<number, MockNamed | MockCustomField> {
    return c === 'tags' ? this.tags : c === 'correspondents' ? this.correspondents : c === 'document_types' ? this.documentTypes : this.customFields;
  }

  private documentCount(c: Collection, id: number): number {
    const docs = [...this.docs.values()];
    switch (c) {
      case 'tags':
        return docs.filter((d) => d.tags.includes(id)).length;
      case 'correspondents':
        return docs.filter((d) => d.correspondent === id).length;
      case 'document_types':
        return docs.filter((d) => d.document_type === id).length;
      default:
        return docs.filter((d) => d.custom_fields.some((f) => f.field === id)).length;
    }
  }

  private listCollection(c: Collection, q: URLSearchParams, version: number, u: URL) {
    const items = [...this.collection(c).values()]
      .map((i) => ({ ...i, document_count: this.documentCount(c, i.id) }))
      .sort((a, b) => (q.get('ordering') === 'name' ? a.name.localeCompare(b.name) : a.id - b.id));
    return this.paginate(items, q, version, u, items.map((i) => i.id));
  }

  private create(c: Collection, body: Record<string, unknown>, send: (s: number, p: unknown) => void): void {
    const name = typeof body?.name === 'string' ? body.name : '';
    if (!name.trim()) return send(400, { name: ['This field may not be blank.'] });
    const map = this.collection(c);
    if ([...map.values()].some((i) => i.name.toLowerCase() === name.toLowerCase())) {
      return send(400, { error: 'Object violates owner / name unique constraint' });
    }
    if (c === 'custom_fields') {
      const f = this.addCustomField(name, String(body.data_type ?? 'string'), (body.extra_data as Record<string, unknown>) ?? null);
      return send(201, { ...f, document_count: 0 });
    }
    const item: MockNamed = { id: this.nextId++, name, matching_algorithm: Number(body.matching_algorithm ?? 1) };
    map.set(item.id, item);
    return send(201, { ...item, document_count: 0 });
  }

  private patchDocument(doc: MockDoc, body: Record<string, unknown>, version: number, send: (s: number, p: unknown) => void): void {
    if (!doc.user_can_change) return send(403, { detail: 'You do not have permission to perform this action.' });
    if (!body || typeof body !== 'object') return send(400, { detail: 'Invalid body' });
    const errors: Record<string, string[]> = {};
    const next = { ...doc };
    if ('title' in body) {
      if (typeof body.title !== 'string' || body.title.length > 128) errors.title = ['Ensure this field has no more than 128 characters.'];
      else next.title = body.title;
    }
    if ('tags' in body) {
      const tags = body.tags as unknown[];
      if (!Array.isArray(tags) || tags.some((t) => !this.tags.has(Number(t)))) errors.tags = ['Invalid pk - object does not exist.'];
      else next.tags = tags.map(Number);
    }
    if ('correspondent' in body) {
      if (body.correspondent !== null && !this.correspondents.has(Number(body.correspondent))) errors.correspondent = ['Invalid pk'];
      else next.correspondent = body.correspondent as number | null;
    }
    if ('document_type' in body) {
      if (body.document_type !== null && !this.documentTypes.has(Number(body.document_type))) errors.document_type = ['Invalid pk'];
      else next.document_type = body.document_type as number | null;
    }
    if ('created' in body) {
      const v = String(body.created);
      if (version >= 9) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.created = ['Date has wrong format. Use one of these formats instead: YYYY-MM-DD.'];
        else next.created = v;
      } else if (!/^\d{4}-\d{2}-\d{2}T/.test(v)) {
        errors.created = ['Datetime has wrong format.'];
      } else next.created = v.slice(0, 10);
    }
    if ('created_date' in body) {
      const v = String(body.created_date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.created_date = ['Date has wrong format.'];
      else next.created = v;
    }
    if ('custom_fields' in body) {
      const cf = body.custom_fields as { field: number; value: unknown }[];
      if (!Array.isArray(cf) || cf.some((f) => !this.customFields.has(Number(f?.field)))) errors.custom_fields = ['Invalid custom field'];
      else next.custom_fields = cf.map((f) => ({ field: Number(f.field), value: f.value }));
    }
    if (Object.keys(errors).length) return send(400, errors);
    Object.assign(doc, next, { modified: this.tick() });
    return send(200, this.serialize(doc, version));
  }
}

export async function startMockPaperless(opts: MockPaperlessOptions = {}): Promise<MockPaperless> {
  return new MockPaperless(opts).start();
}
