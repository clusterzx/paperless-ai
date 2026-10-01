/**
 * Paperless-ngx REST client, compatible with Paperless-ngx 2.x and 3.x.
 *
 * - negotiates the API version (prefers v10 on 3.x, v9 on 2.16+, falls back for older servers)
 * - never relies on the `all` field (removed in API v10)
 * - paginates with page numbers instead of following `next` URLs (avoids
 *   http/https mix-ups behind reverse proxies)
 */
import { HttpError, request, type RequestOptions, trimSlash } from '../util/http.js';
import { logger } from '../logger.js';
import type {
  Paginated,
  PaperlessConnectionInfo,
  PaperlessCorrespondent,
  PaperlessCustomField,
  PaperlessCustomFieldType,
  PaperlessDocument,
  PaperlessDocumentType,
  PaperlessTag,
  PaperlessUiSettings,
} from './types.js';

const log = logger.child({ module: 'paperless' });

/** Highest API version this client understands. */
export const MAX_API_VERSION = 10;
/** Version accepted by both Paperless-ngx 2.16+ and 3.x. */
export const PREFERRED_START_VERSION = 9;

export class PaperlessError extends Error {
  constructor(
    message: string,
    readonly status: number,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'PaperlessError';
  }
}

export interface PaperlessClientOptions {
  url: string;
  token: string;
  timeoutMs?: number;
}

export interface DocumentListQuery {
  tagsAny?: number[];
  ids?: number[];
  ordering?: string;
  fields?: string[];
  pageSize?: number;
  extra?: Record<string, string | number | boolean>;
}

export class PaperlessClient {
  readonly baseUrl: string;
  private apiVersion: number | null = null;
  private negotiating: Promise<number> | null = null;
  private info: PaperlessConnectionInfo | null = null;

  constructor(private readonly opts: PaperlessClientOptions) {
    this.baseUrl = trimSlash(opts.url).replace(/\/api$/i, '');
  }

  get negotiatedVersion(): number | null {
    return this.apiVersion;
  }

  private headers(version: number | null): Record<string, string> {
    return {
      Authorization: `Token ${this.opts.token}`,
      Accept: version ? `application/json; version=${version}` : 'application/json',
    };
  }

  /** Determine the API version to use (once per client). */
  private async version(): Promise<number> {
    if (this.apiVersion) return this.apiVersion;
    this.negotiating ??= this.negotiate().finally(() => {
      this.negotiating = null;
    });
    return this.negotiating;
  }

  private async negotiate(): Promise<number> {
    const url = `${this.baseUrl}/api/ui_settings/`;
    let res: Response;
    try {
      res = await request<Response>(url, {
        headers: this.headers(PREFERRED_START_VERSION),
        timeoutMs: this.opts.timeoutMs ?? 30_000,
        retries: 2,
        responseType: 'response',
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 406) {
        // Paperless-ngx < 2.16 does not know version 9 – ask without a version and read the supported maximum.
        res = await request<Response>(url, {
          headers: this.headers(null),
          timeoutMs: this.opts.timeoutMs ?? 30_000,
          responseType: 'response',
        }).catch((e) => {
          throw this.wrap(e);
        });
      } else throw this.wrap(err);
    }
    const advertised = Number(res.headers.get('x-api-version'));
    const version = Number.isFinite(advertised) && advertised > 0 ? Math.min(advertised, MAX_API_VERSION) : PREFERRED_START_VERSION;
    // Consume body for connection info.
    const body = (await res.json().catch(() => null)) as PaperlessUiSettings | null;
    if (body?.user) {
      this.info = {
        user: { id: body.user.id, username: body.user.username, isSuperuser: !!body.user.is_superuser },
        apiVersion: version,
        serverVersion: res.headers.get('x-version'),
        aiEnabled: !!body.settings?.ai_enabled,
        permissions: body.permissions ?? [],
      };
    }
    this.apiVersion = version;
    log.debug({ version, server: res.headers.get('x-version') }, 'Negotiated Paperless API version');
    return version;
  }

  private wrap(err: unknown): Error {
    if (err instanceof PaperlessError) return err;
    if (err instanceof HttpError) {
      let msg = err.message;
      if (err.status === 401) msg = 'Paperless-ngx rejected the API token (401 Unauthorized)';
      else if (err.status === 403) msg = `Paperless-ngx denied access (403) – check the permissions of the API user. ${detail(err.body)}`;
      else if (err.status === 404) msg = `Not found in Paperless-ngx (404): ${err.url.replace(this.baseUrl, '')}`;
      else if (err.status === 0) msg = `Cannot reach Paperless-ngx at ${this.baseUrl}: ${err.message.replace(/^.*failed: /, '')}`;
      else if (err.status === 400) msg = `Paperless-ngx rejected the request (400): ${detail(err.body)}`;
      return new PaperlessError(msg, err.status, err);
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  async req<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const version = await this.version();
    try {
      return await request<T>(`${this.baseUrl}/api${path}`, {
        timeoutMs: this.opts.timeoutMs ?? 60_000,
        retries: (opts.method ?? 'GET') === 'GET' ? 2 : 0,
        ...opts,
        headers: { ...this.headers(version), ...opts.headers },
      });
    } catch (err) {
      throw this.wrap(err);
    }
  }

  /** Verify URL and token; returns information about the API user. */
  async connect(): Promise<PaperlessConnectionInfo> {
    await this.version();
    if (!this.info) {
      const ui = await this.req<PaperlessUiSettings>('/ui_settings/');
      this.info = {
        user: { id: ui.user.id, username: ui.user.username, isSuperuser: !!ui.user.is_superuser },
        apiVersion: this.apiVersion ?? PREFERRED_START_VERSION,
        serverVersion: null,
        aiEnabled: !!ui.settings?.ai_enabled,
        permissions: ui.permissions ?? [],
      };
    }
    return this.info;
  }

  /** Fetch all pages of a list endpoint. */
  async listAll<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}, pageSize = 500): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page < 10_000; page++) {
      const res = await this.req<Paginated<T>>(path, { query: { ...query, page, page_size: pageSize } });
      out.push(...(res?.results ?? []));
      if (!res?.next || !res.results?.length) break;
    }
    return out;
  }

  async count(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<number> {
    const res = await this.req<Paginated<unknown>>(path, { query: { ...query, page_size: 1, fields: 'id' } });
    return res?.count ?? 0;
  }

  // ------------------------------------------------------------ documents

  async listDocuments(q: DocumentListQuery = {}): Promise<PaperlessDocument[]> {
    const query: Record<string, string | number | boolean | undefined> = {
      fields: (q.fields ?? ['id', 'title', 'created', 'modified', 'added', 'tags', 'correspondent', 'document_type']).join(','),
      ordering: q.ordering ?? '-added',
      ...q.extra,
    };
    if (q.tagsAny?.length) query.tags__id__in = q.tagsAny.join(',');
    if (q.ids?.length) query.id__in = q.ids.join(',');
    return this.listAll<PaperlessDocument>('/documents/', query, q.pageSize ?? 500);
  }

  /** One page of documents, e.g. for pickers in the UI. */
  async searchDocuments(opts: { query?: string; page?: number; pageSize?: number; ordering?: string; fields?: string[] }) {
    const version = await this.version();
    const query: Record<string, string | number | undefined> = {
      page: opts.page ?? 1,
      page_size: opts.pageSize ?? 25,
      ordering: opts.ordering ?? '-added',
      fields: (opts.fields ?? ['id', 'title', 'created', 'tags', 'correspondent', 'document_type']).join(','),
    };
    if (opts.query?.trim()) {
      // `title_content` works on 2.x and 3.x (deprecated in 3.x in favour of `text`).
      query[version >= 10 ? 'text' : 'title_content'] = opts.query.trim();
    }
    return this.req<Paginated<PaperlessDocument>>('/documents/', { query });
  }

  getDocument(id: number): Promise<PaperlessDocument> {
    return this.req<PaperlessDocument>(`/documents/${id}/`);
  }

  async updateDocument(id: number, patch: DocumentPatch): Promise<PaperlessDocument> {
    const body: Record<string, unknown> = { ...patch };
    if (patch.created !== undefined && (this.apiVersion ?? 9) < 9) {
      // API < 9: `created` is a datetime, the date-only variant is `created_date`.
      delete body.created;
      body.created_date = patch.created;
    }
    return this.req<PaperlessDocument>(`/documents/${id}/`, { method: 'PATCH', body });
  }

  async thumbnail(id: number): Promise<{ data: Buffer; contentType: string }> {
    const version = await this.version();
    try {
      const res = await request<Response>(`${this.baseUrl}/api/documents/${id}/thumb/`, {
        headers: { ...this.headers(version), Accept: 'image/*' },
        timeoutMs: 30_000,
        retries: 1,
        responseType: 'response',
      });
      return { data: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'image/webp' };
    } catch (err) {
      throw this.wrap(err);
    }
  }

  // ------------------------------------------------------------ metadata

  tags(): Promise<PaperlessTag[]> {
    return this.listAll<PaperlessTag>('/tags/', { ordering: 'name' }, 1000);
  }

  correspondents(): Promise<PaperlessCorrespondent[]> {
    return this.listAll<PaperlessCorrespondent>('/correspondents/', { ordering: 'name' }, 1000);
  }

  documentTypes(): Promise<PaperlessDocumentType[]> {
    return this.listAll<PaperlessDocumentType>('/document_types/', { ordering: 'name' }, 1000);
  }

  customFields(): Promise<PaperlessCustomField[]> {
    return this.listAll<PaperlessCustomField>('/custom_fields/', {}, 1000);
  }

  createTag(name: string, extra: Partial<PaperlessTag> = {}): Promise<PaperlessTag> {
    // matching_algorithm 0 = none: tags created by the AI must not auto-match other documents.
    return this.req<PaperlessTag>('/tags/', { method: 'POST', body: { name, matching_algorithm: 0, ...extra } });
  }

  createCorrespondent(name: string): Promise<PaperlessCorrespondent> {
    return this.req<PaperlessCorrespondent>('/correspondents/', { method: 'POST', body: { name, matching_algorithm: 0 } });
  }

  createDocumentType(name: string): Promise<PaperlessDocumentType> {
    return this.req<PaperlessDocumentType>('/document_types/', { method: 'POST', body: { name, matching_algorithm: 0 } });
  }

  createCustomField(name: string, dataType: PaperlessCustomFieldType, currency?: string): Promise<PaperlessCustomField> {
    const body: Record<string, unknown> = { name, data_type: dataType };
    if (dataType === 'monetary' && currency) body.extra_data = { default_currency: currency };
    return this.req<PaperlessCustomField>('/custom_fields/', { method: 'POST', body });
  }

  /** Server statistics (document counts etc.). */
  statistics(): Promise<Record<string, unknown>> {
    return this.req<Record<string, unknown>>('/statistics/');
  }
}

export interface DocumentPatch {
  title?: string;
  tags?: number[];
  correspondent?: number | null;
  document_type?: number | null;
  created?: string;
  custom_fields?: { field: number; value: unknown }[];
}

function detail(body: unknown): string {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 300);
  try {
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return '';
  }
}

/** Link to a document in the Paperless web UI. */
export function documentUrl(baseUrl: string, id: number): string {
  return `${trimSlash(baseUrl)}/documents/${id}/details`;
}
