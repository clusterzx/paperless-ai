/**
 * A Paperless-ngx compatible REST API under /ngx/api/ – so that the mobile apps and scanner apps
 * made for Paperless-ngx work with the built-in archive: enter `https://<host>/ngx` as the server.
 *
 * It is a second API next to Paperless-AI's own (/api/), which stays as it is: the same backend,
 * access scopes and change log, only translated into the objects, filters, pagination, version
 * negotiation and error format of Paperless-ngx (API version 9). Libraries do not exist in
 * Paperless-ngx: lists contain the objects of every library the user can read, new objects and
 * uploads go to the user's default library.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import type { Services } from '../http/app.js';
import { LocalBackend } from '../archive/backend.js';
import { canEdit, canRead, isAdmin, userIdOf, type AccessScope } from '../access/scope.js';
import type { ArchiveDocument, ChangeOrigin, CustomFieldType, DocumentFilter, DocumentPatch, MetadataKind } from '../backend/types.js';
import { statusOf } from '../backend/types.js';
import { HttpProblem } from '../http/helpers.js';
import { sendFile } from '../routes/documentOps.js';
import { postDocumentHandler } from './postDocument.js';
import { verifyPassword, hashPassword } from '../auth.js';
import { passwordLoginAllowed } from '../oidc.js';
import { checkSecondFactor, secondFactorError } from '../twoFactor.js';
import { describeError } from '../util/http.js';
import { logger } from '../logger.js';
import {
  apiVersion,
  baseUrl,
  filterFromQuery,
  matchesNothing,
  MAX_API_VERSION,
  MIN_API_VERSION,
  ngxDocument,
  NGX_VERSION,
  pageParams,
  paginate,
  paginateList,
  intakeIdOf,
  requestedVersion,
  slug,
  taskIdOf,
  sortFromOrdering,
  textColor,
} from './format.js';

const log = logger.child({ module: 'ngx-api' });

type Query = Record<string, string | undefined>;
type Body = Record<string, unknown>;
type LabelItem = { id: number; name: string; document_count?: number; color?: string | null; parent?: number | null; data_type?: string; extra_data?: Record<string, unknown> | null };
type LabelEntry = { lib: number | null; item: LabelItem };

/** Errors as Paperless-ngx (Django REST framework) sends them: `{"detail": "…"}`. */
class NgxError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}
const notFoundError = (what = 'Not found.') => new NgxError(404, what);

/** The object kinds of the label endpoints. */
const LABELS: Record<string, MetadataKind> = { tags: 'tag', correspondents: 'correspondent', document_types: 'documentType', custom_fields: 'customField' };

/** Permission names of Paperless-ngx (Django `<action>_<model>`) the apps look at to show or hide functions. */
const MODELS = ['document', 'tag', 'correspondent', 'documenttype', 'customfield', 'storagepath', 'savedview', 'note', 'paperlesstask', 'uisettings', 'sharelink', 'workflow', 'mailaccount', 'mailrule', 'user', 'group', 'history', 'applicationconfiguration'];
/** Largest page of documents the archive reads at once; larger pages are read in parts. */
const CHUNK = 250;

let placeholderPng: Promise<Buffer> | null = null;
/** A grey page as PNG – apps cannot show SVG placeholders. */
const placeholder = () => (placeholderPng ??= sharp({ create: { width: 210, height: 297, channels: 3, background: '#eeeeef' } }).png().toBuffer());

export const ngxRoutes =
  ({ ctx, engine }: Services): FastifyPluginAsync =>
  async (app: FastifyInstance) => {
    const auth = { config: { auth: 'user' as const } };
    const local = (): LocalBackend => {
      const b = ctx.archive();
      if (!(b instanceof LocalBackend)) throw new NgxError(404, 'The Paperless-ngx compatible API is part of the built-in archive – with Paperless-ngx, connect the app to Paperless-ngx itself');
      return b;
    };
    const scopeOf = (req: FastifyRequest): AccessScope => req.access!;
    const origin = (req: FastifyRequest, ref = 'ngx-api'): ChangeOrigin => ({ actor: 'user', actorId: userIdOf(scopeOf(req)), ref });

    // Forms (the token request of some apps) besides JSON.
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });

    app.addHook('onRequest', async (req, reply) => {
      const v = requestedVersion(req);
      if (v !== null && (v < MIN_API_VERSION || v > MAX_API_VERSION)) return reply.code(406).send({ detail: 'Invalid version in "Accept" header.' });
    });

    app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
      if (err instanceof NgxError) return reply.code(err.status).send(err.body ?? { detail: err.message });
      const status = err instanceof HttpProblem ? err.statusCode : (statusOf(err) ?? (err.statusCode && err.statusCode < 500 ? err.statusCode : 500));
      if (status >= 500) log.error({ err, url: req.url }, 'Error in the Paperless-ngx compatible API');
      return reply.code(status).send({ detail: status >= 500 ? 'Server error – see the logs of Paperless-AI' : err.message });
    });

    // ---------------------------------------------------------------- sign-in and the user

    /** Paperless-ngx's token login: a personal API key of Paperless-AI for the app. */
    app.post('/ngx/api/token/', { config: { auth: 'public', rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const body = (req.body ?? {}) as Body;
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      const refuse = (msg: string) => new NgxError(400, msg, { non_field_errors: [msg] });
      if (!username || !password) throw refuse('Unable to log in with provided credentials.');
      if (!passwordLoginAllowed(ctx.cfg)) throw refuse('Signing in with a password is switched off – create an API key in Paperless-AI (Settings → API keys) and enter it as the token');
      const user = ctx.repos.users.byUsername(username);
      const ok = await verifyPassword(password, user?.password_hash || (await dummy()));
      if (!user || !user.password_hash || !ok || user.disabled_at) {
        log.warn(`Failed app sign-in for "${username.slice(0, 50)}" from ${req.ip}`);
        throw refuse('Unable to log in with provided credentials.');
      }
      // Two-factor authentication: the apps ask for the code when the answer says so (as Paperless-ngx).
      if (user.totp_enabled_at) {
        const code = String(body.code ?? '').trim();
        if (!code) throw refuse('MFA code is required');
        const second = await checkSecondFactor(ctx, user, code);
        if (!second.ok) throw refuse(secondFactorError(second.reason));
      }
      const agent = String(req.headers['user-agent'] ?? '').split(/[/ (]/)[0].slice(0, 40) || 'app';
      const { key } = ctx.repos.apiKeys.create(user.id, { name: `Paperless-ngx app (${agent})`, scopes: ['read', 'write', 'upload'] });
      log.info(`User "${user.username}" signed in to the Paperless-ngx compatible API (${agent})`);
      return { token: key };
    });
    // Paperless Mobile checks the server with HEAD /api/schema/ (200 without signing in).
    app.get('/ngx/api/schema/', { config: { auth: 'public' } }, async () => ({ openapi: '3.0.3', info: { title: 'Paperless-ngx REST API (Paperless-AI)', version: '6.0.0' }, paths: {} }));
    // Apps check the server address with a GET of the token endpoint: Paperless-ngx answers 405.
    app.get('/ngx/api/token/', { config: { auth: 'public' } }, async (_req, reply) =>
      reply.code(405).header('Allow', 'POST, OPTIONS').send({ detail: 'Method "GET" not allowed.' }),
    );
    let dummyHash: Promise<string> | null = null;
    const dummy = () => (dummyHash ??= hashPassword(`dummy-${randomUUID()}`));

    const me = (req: FastifyRequest) => {
      const id = userIdOf(scopeOf(req));
      return id !== null ? ctx.repos.users.byId(id) : undefined;
    };
    const userJson = (u: { id: number; username: string; email?: string | null; display_name?: string | null; role: string; created_at: number; disabled_at?: number | null }, self?: { id: number; permissions: string[] }) => {
      const [first, ...rest] = (u.display_name ?? '').split(' ');
      return {
        id: u.id,
        username: u.username,
        email: u.email ?? '',
        password: '**********',
        first_name: first ?? '',
        last_name: rest.join(' '),
        date_joined: new Date(u.created_at).toISOString(),
        is_staff: u.role === 'admin',
        is_active: !u.disabled_at,
        is_superuser: u.role === 'admin',
        groups: ctx.repos.groups.groupsOf(u.id).map((g) => g.id),
        user_permissions: [],
        // The permissions of the caller (apps read their own from here); others: none listed.
        inherited_permissions: self && self.id === u.id ? self.permissions : [],
        is_mfa_enabled: Boolean((u as { totp_enabled_at?: number | null }).totp_enabled_at),
        inbox_tags: [],
      };
    };
    /** What the caller may do, as Paperless-ngx permission names. */
    const permissions = (req: FastifyRequest): string[] => {
      const scope = scopeOf(req);
      const writable = local().writableLibraries(scope);
      const canWrite = writable === null || writable.length > 0;
      const out: string[] = [];
      for (const m of MODELS) {
        out.push(`view_${m}`);
        if (canWrite && !['user', 'group', 'mailaccount', 'mailrule', 'workflow', 'history', 'applicationconfiguration'].includes(m)) out.push(`add_${m}`, `change_${m}`, `delete_${m}`);
      }
      if (isAdmin(scope)) for (const m of ['user', 'group']) out.push(`add_${m}`, `change_${m}`, `delete_${m}`);
      return out;
    };

    app.get('/ngx/api/', auth, async (req) => {
      const b = `${baseUrl(req)}/ngx/api`;
      const names = ['correspondents', 'document_types', 'documents', 'saved_views', 'storage_paths', 'tags', 'tasks', 'users', 'groups', 'custom_fields', 'ui_settings', 'profile', 'statistics', 'search'];
      return Object.fromEntries(names.map((n) => [n, `${b}/${n}/`]));
    });

    app.get('/ngx/api/ui_settings/', auth, async (req) => {
      local();
      const u = me(req);
      return {
        user: { id: u?.id ?? 0, username: u?.username ?? 'api', first_name: '', last_name: '', is_staff: u?.role === 'admin', is_superuser: u?.role === 'admin', groups: [] },
        settings: {
          // What the apps stored (their own view settings), under what Paperless-AI says about itself.
          ...(ctx.repos.kv.get<Record<string, unknown>>(uiSettingsKey(req)) ?? {}),
          app_title: 'Paperless-AI',
          app_logo: null,
          update_checking: { backend_setting: 'false' },
          trash_delay: ctx.cfg.archive.builtin.trashDays,
          auditlog_enabled: true,
          email_enabled: false,
          version: NGX_VERSION,
        },
        permissions: permissions(req),
      };
    });
    const uiSettingsKey = (req: FastifyRequest) => `ngx.ui_settings.${userIdOf(scopeOf(req)) ?? 'api'}`;
    app.post('/ngx/api/ui_settings/', auth, async (req) => {
      const settings = ((req.body ?? {}) as Body).settings;
      if (settings && typeof settings === 'object' && JSON.stringify(settings).length < 200_000) ctx.repos.kv.set(uiSettingsKey(req), settings);
      return { success: true };
    });

    // The application configuration of Paperless-ngx (OCR, barcodes …): apps read it; nothing of it applies here.
    app.get('/ngx/api/logs/', auth, async () => []);
    app.get('/ngx/api/config/', auth, async () => [{ id: 1, app_title: 'Paperless-AI', app_logo: null, barcode_asn_prefix: null, barcodes_enabled: false }]);

    app.get('/ngx/api/profile/', auth, async (req) => {
      const u = me(req);
      if (!u) throw notFoundError();
      const [first, ...rest] = (u.display_name ?? '').split(' ');
      return {
        email: u.email ?? '',
        password: '**********',
        first_name: first ?? '',
        last_name: rest.join(' '),
        auth_token: '',
        social_accounts: [],
        has_usable_password: Boolean(u.password_hash),
        is_mfa_enabled: Boolean(u.totp_enabled_at),
      };
    });

    app.get('/ngx/api/users/', auth, async (req) => {
      local();
      const q = req.query as Query;
      const self = { id: userIdOf(scopeOf(req)) ?? 0, permissions: permissions(req) };
      const wanted = (q.username ?? q.username__iexact)?.toLowerCase();
      const users = ctx.repos.users
        .list()
        .filter((u) => !u.disabled_at && (!wanted || u.username.toLowerCase() === wanted))
        .map((u) => userJson(u, self));
      return paginateList(req, users, q);
    });
    app.get('/ngx/api/users/:id/', auth, async (req) => {
      const u = ctx.repos.users.byId(Number((req.params as { id: string }).id));
      if (!u || u.disabled_at) throw notFoundError();
      return userJson(u, { id: userIdOf(scopeOf(req)) ?? 0, permissions: permissions(req) });
    });
    app.get('/ngx/api/groups/', auth, async (req) => paginateList(req, ctx.repos.groups.list().map((g) => ({ id: g.id, name: g.name, permissions: [] })), req.query as Query));
    app.get('/ngx/api/remote_version/', auth, async () => ({ version: `v${NGX_VERSION}`, update_available: false }));

    // ---------------------------------------------------------------- statistics, status

    app.get('/ngx/api/statistics/', auth, async (req) => {
      const b = local();
      const scope = scopeOf(req);
      const view = ctx.backend(scope);
      const total = await view.countDocuments({});
      const libs = b.writableLibraries(scope);
      const readable = scope.libraries ? [...scope.libraries.keys()] : null;
      const where = readable ? `AND library_id IN (SELECT value FROM json_each(?))` : '';
      const args = readable ? [JSON.stringify(readable)] : [];
      const types = ctx.db.prepare(`SELECT mime_type, COUNT(*) AS c FROM lib_documents WHERE deleted_at IS NULL ${where} GROUP BY mime_type`).all(...args) as { mime_type: string; c: number }[];
      const chars = ctx.db
        .prepare(`SELECT COALESCE(SUM(LENGTH(t.text)), 0) AS c FROM lib_documents d JOIN lib_document_text t ON t.document_id = d.id AND t.version = d.current_version WHERE d.deleted_at IS NULL ${where.replace('library_id', 'd.library_id')}`)
        .get(...args) as { c: number } | undefined;
      const labels = await labelLists(scope);
      return {
        documents_total: total,
        documents_inbox: null,
        inbox_tag: null,
        inbox_tags: null,
        document_file_type_counts: types.map((t) => ({ mime_type: t.mime_type, mime_type_count: t.c })),
        character_count: chars?.c ?? 0,
        tag_count: labels.tag.length,
        correspondent_count: labels.correspondent.length,
        document_type_count: labels.documentType.length,
        storage_path_count: 0,
        current_asn: libs?.length ? Math.max(0, (await b.nextAsn(libs[0])) - 1) : null,
      };
    });

    app.get('/ngx/api/status/', auth, async () => ({
      pngx_version: NGX_VERSION,
      server_os: process.platform,
      install_type: 'docker',
      storage: { total: 0, available: 0 },
      database: { type: 'sqlite', url: '', status: 'OK', error: null },
      tasks: { redis_status: 'OK', celery_status: 'OK', index_status: 'OK', classifier_status: 'OK' },
    }));

    // ---------------------------------------------------------------- labels

    /** The label lists of every library the caller can read (ids are unique across libraries). */
    const labelLists = async (scope: AccessScope, fresh = false) => {
      local();
      const libs = (await ctx.backend(scope).metadataScopes()).filter((l) => l === null || canRead(scope, l));
      const out: Record<MetadataKind, LabelEntry[]> = { tag: [], correspondent: [], documentType: [], customField: [] };
      for (const lib of libs) {
        // Fresh for the lists (document counts), cached for lookups.
        const s = await ctx.metadata(lib).snapshot(fresh);
        for (const item of s.tags) out.tag.push({ lib, item: item as LabelItem });
        for (const item of s.correspondents) out.correspondent.push({ lib, item: item as LabelItem });
        for (const item of s.documentTypes) out.documentType.push({ lib, item: item as LabelItem });
        for (const item of s.customFields) out.customField.push({ lib, item: item as LabelItem });
      }
      return out;
    };
    const labelJson = (kind: MetadataKind, scope: AccessScope, entry: LabelEntry) => {
      const { lib, item } = entry;
      const changeable = lib === null || canEdit(scope, lib);
      if (kind === 'customField') {
        const extra = item.extra_data ?? {};
        return {
          id: item.id,
          name: item.name,
          data_type: item.data_type,
          extra_data: { select_options: extra.select_options ?? [], default_currency: extra.default_currency ?? null },
          document_count: item.document_count ?? 0,
        };
      }
      const base = {
        id: item.id,
        slug: slug(item.name),
        name: item.name,
        match: '',
        matching_algorithm: 0,
        is_insensitive: true,
        document_count: item.document_count ?? 0,
        owner: null,
        user_can_change: changeable,
      };
      if (kind === 'tag') {
        // Apps expect #rrggbb.
        const color = /^#[0-9a-f]{6}$/i.test(item.color ?? '') ? item.color!.toLowerCase() : '#a6cee3';
        return { ...base, color, text_color: textColor(color), is_inbox_tag: false, parent: item.parent ?? null, children: [] };
      }
      if (kind === 'correspondent') return { ...base, last_correspondence: null };
      return base;
    };
    const labelFilter = (q: Query) => (i: { item: { id: number; name: string } }) => {
      const idList = q.id__in ?? q.ids__in;
      const ids = idList ? idList.split(',').map(Number) : null;
      if (ids && !ids.includes(i.item.id)) return false;
      if (q.id && Number(q.id) !== i.item.id) return false;
      const name = (q.name__icontains ?? q.name__istartswith ?? '').toLowerCase();
      if (name && !(q.name__istartswith ? i.item.name.toLowerCase().startsWith(name) : i.item.name.toLowerCase().includes(name))) return false;
      if (q.name__iexact && i.item.name.toLowerCase() !== q.name__iexact.toLowerCase()) return false;
      return true;
    };
    /** The label and its library; 404 when the caller cannot see it, 403 when they cannot change it. */
    const labelOf = async (scope: AccessScope, kind: MetadataKind, id: number, forChange: boolean) => {
      const entry = (await labelLists(scope))[kind].find((e) => e.item.id === id);
      if (!entry) throw notFoundError();
      if (forChange && entry.lib !== null && !canEdit(scope, entry.lib)) throw new NgxError(403, 'You do not have permission to perform this action.');
      return entry;
    };

    for (const [path, kind] of Object.entries(LABELS)) {
      app.get(`/ngx/api/${path}/`, auth, async (req) => {
        const scope = scopeOf(req);
        const q = req.query as Query;
        const items = (await labelLists(scope, true))[kind]
          .filter(labelFilter(q))
          .sort((a, b) => (q.ordering?.replace('-', '') === 'document_count' ? (a.item.document_count ?? 0) - (b.item.document_count ?? 0) : a.item.name.localeCompare(b.item.name)) * (q.ordering?.startsWith('-') ? -1 : 1))
          .map((e) => ({ ...labelJson(kind, scope, e), id: e.item.id }));
        return paginateList(req, items, q);
      });

      app.get(`/ngx/api/${path}/:id/`, auth, async (req) => {
        const scope = scopeOf(req);
        return labelJson(kind, scope, await labelOf(scope, kind, Number((req.params as { id: string }).id), false));
      });

      app.post(`/ngx/api/${path}/`, auth, async (req, reply) => {
        const b = local();
        const scope = scopeOf(req);
        const body = (req.body ?? {}) as Body;
        const name = String(body.name ?? '').trim();
        if (!name) throw new NgxError(400, 'This field is required.', { name: ['This field is required.'] });
        const lib = b.targetLibrary(scope);
        const meta = ctx.metadata(lib);
        await meta.snapshot();
        const res =
          kind === 'tag'
            ? await meta.resolveTag(name, true)
            : kind === 'correspondent'
              ? await meta.resolveCorrespondent(name, true)
              : kind === 'documentType'
                ? await meta.resolveDocumentType(name, true)
                : await meta.resolveCustomField(name, true, (String(body.data_type ?? 'string') as CustomFieldType) || 'string', (body.extra_data as { default_currency?: string } | undefined)?.default_currency ?? undefined);
        if (res.id == null) throw new NgxError(400, 'Could not create it');
        if (!res.created) throw new NgxError(400, `${name} exists already`, { name: [`${kind} with this name already exists.`] });
        if (kind === 'tag' && typeof body.color === 'string') await ctx.backend(scope).updateMetadata(kind, res.id, { color: body.color });
        meta.invalidate();
        reply.code(201);
        return labelJson(kind, scope, await labelOf(scope, kind, res.id, false));
      });

      const update = async (req: FastifyRequest) => {
        const scope = scopeOf(req);
        const id = Number((req.params as { id: string }).id);
        const entry = await labelOf(scope, kind, id, true);
        const body = (req.body ?? {}) as Body;
        const patch: { name?: string; color?: string | null; parent?: number | null } = {};
        if (typeof body.name === 'string' && body.name.trim() && body.name.trim() !== entry.item.name) patch.name = body.name.trim();
        if (kind === 'tag' && typeof body.color === 'string') patch.color = body.color;
        if (kind === 'tag' && body.parent !== undefined) patch.parent = body.parent === null ? null : Number(body.parent);
        if (Object.keys(patch).length) await ctx.backend(scope).updateMetadata(kind, id, patch);
        ctx.metadata(entry.lib).invalidate();
        return labelJson(kind, scope, await labelOf(scope, kind, id, false));
      };
      app.patch(`/ngx/api/${path}/:id/`, auth, update);
      app.put(`/ngx/api/${path}/:id/`, auth, update);

      app.delete(`/ngx/api/${path}/:id/`, auth, async (req, reply) => {
        const scope = scopeOf(req);
        const id = Number((req.params as { id: string }).id);
        const entry = await labelOf(scope, kind, id, true);
        await ctx.backend(scope).deleteMetadata(kind, id);
        ctx.metadata(entry.lib).invalidate();
        return reply.code(204).send();
      });
    }

    // Storage paths, saved views, mail, workflows, share links: none here – empty lists, so apps show nothing.
    for (const path of ['storage_paths', 'saved_views', 'mail_accounts', 'mail_rules', 'workflows', 'share_links', 'workflow_triggers', 'workflow_actions', 'processed_mail']) {
      app.get(`/ngx/api/${path}/`, auth, async (req) => {
        local();
        return paginate(req, [], 0, 1, 25, []);
      });
      app.get(`/ngx/api/${path}/:id/`, auth, async () => {
        throw notFoundError();
      });
    }

    // ---------------------------------------------------------------- documents

    const documentJson = (req: FastifyRequest, d: ArchiveDocument) => {
      const q = req.query as Query;
      return ngxDocument(d, apiVersion(req), {
        truncate: q.truncate_content === 'true',
        fields: q.fields ? q.fields.split(',').map((f) => f.trim()).filter(Boolean) : null,
        perms: q.full_perms === 'true',
      });
    };

    /** The document list: Paperless-ngx filters, ordering and pages. */
    app.get('/ngx/api/documents/', auth, async (req) => {
      local();
      const scope = scopeOf(req);
      const q = req.query as Query;
      const { page, pageSize } = pageParams(q, 25, 100_000);
      const filter: DocumentFilter = filterFromQuery(q);
      if (q.more_like_id) {
        // "More like this": documents sharing its words – the title as a full text query.
        const ref = await ctx.backend(scope).getDocument(Number(q.more_like_id)).catch(() => null);
        if (ref) {
          filter.query = ref.title;
          filter.ids = undefined;
        }
      }
      if (matchesNothing(filter)) return paginate(req, [], 0, page, pageSize, []);
      const view = ctx.backend(scope);
      const sort = sortFromOrdering(q.ordering, Boolean(filter.query));
      // Large pages (apps read all ids with page_size=25000) in parts the archive reads at once.
      let chunk = Math.min(CHUNK, pageSize);
      while (pageSize % chunk) chunk--;
      const first = ((page - 1) * pageSize) / chunk + 1;
      const res = await view.queryDocuments({ filter, sort, limit: chunk, page: first, withCount: true });
      const found = [...res.results];
      for (let part = 1; part < pageSize / chunk && found.length === part * chunk; part++) {
        found.push(...(await view.queryDocuments({ filter, sort, limit: chunk, page: first + part })).results);
      }
      let docs = found.filter((d) => !q.more_like_id || d.id !== Number(q.more_like_id));
      const wantsContent = !q.fields || q.fields.split(',').includes('content');
      if (wantsContent && docs.length) {
        const withText = new Map((await view.listDocuments({ ids: docs.map((d) => d.id), fields: ['id', 'content'] })).map((d) => [d.id, d.content ?? '']));
        docs = docs.map((d) => ({ ...d, content: withText.get(d.id) ?? '' }));
      }
      const results = docs.map((d) => {
        const json = documentJson(req, d);
        // Full text matches: their place in the result, as Paperless-ngx sends it with a query.
        if (filter.query) json.__search_hit__ = { score: 1, highlights: res.snippets?.[d.id] ?? '', note_highlights: '', rank: null };
        return json;
      });
      // No `all`: computing every matching id for each page would cost more than it helps.
      return paginate(req, results, res.count ?? results.length, page, pageSize);
    });

    const documentOf = async (req: FastifyRequest) => {
      local();
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) throw notFoundError('No Document matches the given query.');
      try {
        return await ctx.backend(scopeOf(req)).getDocument(id);
      } catch (err) {
        if (statusOf(err) === 404 || statusOf(err) === 403) throw notFoundError('No Document matches the given query.');
        throw err;
      }
    };

    app.get('/ngx/api/documents/:id/', auth, async (req) => documentJson(req, await documentOf(req)));

    /** Changes of a document in Paperless-ngx field names. */
    const updateDocument = async (req: FastifyRequest) => {
      const doc = await documentOf(req);
      const scope = scopeOf(req);
      const body = (req.body ?? {}) as Body;
      const patch: DocumentPatch = {};
      if (typeof body.title === 'string') patch.title = body.title;
      if (body.correspondent !== undefined) patch.correspondent = body.correspondent === null ? null : Number(body.correspondent);
      if (body.document_type !== undefined) patch.document_type = body.document_type === null ? null : Number(body.document_type);
      if (Array.isArray(body.tags)) patch.tags = body.tags.map(Number);
      const created = (body.created_date ?? body.created) as string | null | undefined;
      if (typeof created === 'string' && /^\d{4}-\d{2}-\d{2}/.test(created)) patch.created = created.slice(0, 10);
      if (body.archive_serial_number !== undefined) patch.archive_serial_number = body.archive_serial_number === null || body.archive_serial_number === '' ? null : Number(body.archive_serial_number);
      if (Array.isArray(body.custom_fields)) {
        patch.custom_fields = (body.custom_fields as { field: number; value?: unknown }[]).map((f) => ({ field: Number(f.field), value: f.value ?? null }));
      }
      // The text – unless it is the shortened text of a list (truncate_content) sent back unchanged.
      const text = doc.content ?? '';
      if (typeof body.content === 'string' && !(body.content.length < text.length && text.startsWith(body.content))) patch.content = body.content;
      // Changes the archive does not have here (owner, permissions, storage path) are left out.
      const changed = Object.entries(patch).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((doc as unknown as Record<string, unknown>)[k]));
      if (!changed.length) return documentJson(req, doc);
      const real = Object.fromEntries(changed) as DocumentPatch;
      if (!canEdit(scope, doc.library_id)) throw new NgxError(403, 'You do not have permission to perform this action.');
      const o = origin(req);
      const updated = await ctx.backend(scope).updateDocument(doc.id, real, o);
      ctx.events.emit({ type: 'document.updated', id: doc.id, fields: Object.keys(real), origin: o, libraryId: doc.library_id ?? null });
      return documentJson(req, await ctx.backend(scope).getDocument(updated.id));
    };
    app.patch('/ngx/api/documents/:id/', auth, updateDocument);
    app.put('/ngx/api/documents/:id/', auth, updateDocument);

    app.delete('/ngx/api/documents/:id/', auth, async (req, reply) => {
      const doc = await documentOf(req);
      const o = origin(req);
      await ctx.backend(scopeOf(req)).deleteDocument(doc.id, o);
      ctx.events.emit({ type: 'document.deleted', id: doc.id, origin: o, libraryId: doc.library_id ?? null });
      return reply.code(204).send();
    });

    const file = async (req: FastifyRequest, reply: FastifyReply, opts: { original: boolean; inline: boolean }) => {
      const doc = await documentOf(req);
      const f = await ctx.backend(scopeOf(req)).download(doc.id, { original: opts.original });
      return sendFile(req, reply, f.data, f.contentType, f.filename ?? doc.original_file_name ?? `document-${doc.id}`, opts.inline);
    };
    app.get('/ngx/api/documents/:id/download/', auth, async (req, reply) => file(req, reply, { original: (req.query as Query).original === 'true', inline: false }));
    app.get('/ngx/api/documents/:id/preview/', auth, async (req, reply) => file(req, reply, { original: (req.query as Query).original === 'true', inline: true }));
    app.get('/ngx/api/documents/:id/thumb/', auth, async (req, reply) => {
      const doc = await documentOf(req);
      const t = await ctx.backend(scopeOf(req)).thumbnail(doc.id);
      reply.header('Cache-Control', 'private, max-age=3600');
      if (t.contentType === 'image/svg+xml') return reply.type('image/png').send(await placeholder());
      return reply.type(t.contentType).send(Buffer.from(t.data));
    });

    app.get('/ngx/api/documents/:id/metadata/', auth, async (req) => {
      const doc = await documentOf(req);
      const row = ctx.db
        .prepare("SELECT f.blob_sha256, f.size, f.mime_type, f.original_filename FROM lib_document_files f WHERE f.document_id = ? AND f.kind = 'original' ORDER BY f.version DESC LIMIT 1")
        .get(doc.id) as { blob_sha256: string; size: number; mime_type: string; original_filename: string } | undefined;
      return {
        original_checksum: row?.blob_sha256 ?? '',
        original_size: row?.size ?? 0,
        original_mime_type: row?.mime_type ?? doc.mime_type ?? '',
        media_filename: row?.original_filename ?? doc.original_file_name ?? '',
        has_archive_version: false,
        original_metadata: [],
        archive_checksum: null,
        archive_media_filename: null,
        original_filename: row?.original_filename ?? doc.original_file_name ?? '',
        archive_size: null,
        archive_metadata: null,
        lang: 'de',
      };
    });

    // Notes do not exist in the built-in archive (its change log is shown in Paperless-AI).
    app.get('/ngx/api/documents/:id/notes/', auth, async (req) => {
      await documentOf(req);
      return [];
    });
    app.post('/ngx/api/documents/:id/notes/', auth, async () => {
      throw new NgxError(400, 'Notes are not supported by Paperless-AI');
    });
    app.get('/ngx/api/documents/:id/suggestions/', auth, async (req) => {
      await documentOf(req);
      return { correspondents: [], tags: [], document_types: [], storage_paths: [], dates: [] };
    });
    app.get('/ngx/api/documents/:id/share_links/', auth, async () => []);
    app.get('/ngx/api/documents/:id/logs/', auth, async (req) => {
      await documentOf(req);
      return paginate(req, [], 0, 1, 25, []);
    });
    app.post('/ngx/api/documents/:id/reprocess/', auth, async (req) => {
      const doc = await documentOf(req);
      if (!canEdit(scopeOf(req), doc.library_id)) throw new NgxError(403, 'You do not have permission to perform this action.');
      engine.enqueue(doc.id, { source: 'manual', force: true });
      return { result: 'OK' };
    });
    app.get('/ngx/api/documents/:id/history/', auth, async () => []);

    app.get('/ngx/api/documents/next_asn/', auth, async (req) => {
      const b = local();
      const libs = b.writableLibraries(scopeOf(req));
      return b.nextAsn(libs?.length ? b.targetLibrary(scopeOf(req)) : null);
    });

    app.post('/ngx/api/documents/selection_data/', auth, async (req) => {
      local();
      const ids = (((req.body ?? {}) as Body).documents as unknown[] | undefined)?.map(Number).filter((n) => Number.isInteger(n)) ?? [];
      const f = await ctx.backend(scopeOf(req)).facets({ ids: ids.length ? ids : [-1] });
      const pairs = (list: { id: number; count: number }[]) => list.map((x) => ({ id: x.id, document_count: x.count }));
      return {
        selected_correspondents: pairs(f.correspondents),
        selected_tags: pairs(f.tags),
        selected_document_types: pairs(f.documentTypes),
        selected_storage_paths: [],
        selected_custom_fields: [],
      };
    });

    /** bulk_edit of Paperless-ngx: one method for a list of documents. */
    app.post('/ngx/api/documents/bulk_edit/', auth, async (req) => {
      local();
      const scope = scopeOf(req);
      const body = (req.body ?? {}) as Body;
      const ids = ((body.documents as unknown[]) ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      const method = String(body.method ?? '');
      const p = (body.parameters ?? {}) as Body;
      const o = origin(req, `bulk:${randomUUID()}`);
      const view = ctx.backend(scope);
      const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
      for (const id of ids) {
        const doc = await view.getDocument(id);
        let patch: DocumentPatch;
        switch (method) {
          case 'set_correspondent':
            patch = { correspondent: num(p.correspondent) };
            break;
          case 'set_document_type':
            patch = { document_type: num(p.document_type) };
            break;
          case 'add_tag':
            patch = { tags: [...new Set([...(doc.tags ?? []), Number(p.tag)])] };
            break;
          case 'remove_tag':
            patch = { tags: (doc.tags ?? []).filter((t) => t !== Number(p.tag)) };
            break;
          case 'modify_tags': {
            const add = ((p.add_tags as unknown[]) ?? []).map(Number);
            const remove = ((p.remove_tags as unknown[]) ?? []).map(Number);
            patch = { tags: [...new Set([...(doc.tags ?? []).filter((t) => !remove.includes(t)), ...add])] };
            break;
          }
          case 'modify_custom_fields': {
            const fields = [...(doc.custom_fields ?? [])];
            const add = p.add_custom_fields;
            const remove = ((p.remove_custom_fields as unknown[]) ?? []).map(Number);
            const kept = fields.filter((f) => !remove.includes(f.field));
            const adds: { field: number; value: unknown }[] = Array.isArray(add)
              ? add.map((f) => ({ field: Number(f), value: null }))
              : Object.entries((add as Record<string, unknown>) ?? {}).map(([f, value]) => ({ field: Number(f), value }));
            for (const a of adds) {
              const at = kept.findIndex((f) => f.field === a.field);
              if (at >= 0) kept[at] = Array.isArray(add) ? kept[at] : a;
              else kept.push(a);
            }
            patch = { custom_fields: kept };
            break;
          }
          case 'delete':
            await view.deleteDocument(id, o);
            ctx.events.emit({ type: 'document.deleted', id, origin: o, libraryId: doc.library_id ?? null });
            continue;
          case 'reprocess':
            if (!canEdit(scope, doc.library_id)) throw new NgxError(403, 'You do not have permission to perform this action.');
            engine.enqueue(id, { source: 'manual', force: true });
            continue;
          case 'set_permissions':
          case 'set_storage_path':
            continue; // no owners, permissions per document or storage paths here
          default:
            throw new NgxError(400, `The method ${method || '(none)'} is not supported by Paperless-AI`);
        }
        await view.updateDocument(id, patch, o);
        ctx.events.emit({ type: 'document.updated', id, fields: Object.keys(patch), origin: o, libraryId: doc.library_id ?? null });
      }
      return { result: 'OK' };
    });

    // ---------------------------------------------------------------- upload and tasks

    const postDocument = postDocumentHandler(ctx);
    app.post('/ngx/api/documents/post_document/', { ...auth, schema: { hide: true } }, async (req, reply) => {
      local();
      return postDocument(req, reply);
    });

    /** Intake attempts as Paperless-ngx consumption tasks (task ids: UUIDs made from the attempt id). */
    type IntakeRow = { id: number; filename: string | null; status: string; document_id: number | null; error: string | null; created_at: number; finished_at: number | null; created_by: number | null; library_id: number | null; channel: string };
    const ackKey = (req: FastifyRequest) => `ngx.tasks.acknowledged.${userIdOf(scopeOf(req)) ?? 'api'}`;
    const acknowledged = (req: FastifyRequest) => new Set(ctx.repos.kv.get<number[]>(ackKey(req)) ?? []);
    const taskJson = (r: IntakeRow, acked: Set<number>) => {
      const status = r.status === 'stored' ? 'SUCCESS' : r.status === 'pending' ? 'STARTED' : 'FAILURE';
      const result =
        r.status === 'stored'
          ? `Success. New document id ${r.document_id} created`
          : r.status === 'duplicate'
            ? `Not consuming ${r.filename}: It is a duplicate of document #${r.document_id}`
            : (r.error ?? null);
      return {
        id: r.id,
        task_id: taskIdOf(r.id),
        task_name: 'consume_file',
        task_file_name: r.filename,
        date_created: new Date(r.created_at).toISOString(),
        date_done: r.finished_at ? new Date(r.finished_at).toISOString() : null,
        type: 'auto_task',
        status,
        result,
        acknowledged: acked.has(r.id),
        related_document: r.document_id !== null ? String(r.document_id) : null,
        owner: r.created_by,
      };
    };
    const visibleTask = (scope: AccessScope) => {
      const libs = scope.libraries ? [...scope.libraries.keys()] : null;
      return (r: IntakeRow) => r.created_by === userIdOf(scope) || (r.library_id !== null && (libs === null || libs.includes(r.library_id)));
    };
    app.get('/ngx/api/tasks/', auth, async (req) => {
      local();
      const scope = scopeOf(req);
      const q = req.query as Query;
      const acked = acknowledged(req);
      if (q.task_id) {
        const id = intakeIdOf(q.task_id);
        const row = id ? (ctx.db.prepare('SELECT * FROM lib_intake WHERE id = ?').get(id) as IntakeRow | undefined) : undefined;
        return row && visibleTask(scope)(row) ? [taskJson(row, acked)] : [];
      }
      const limit = Math.min(1000, Math.max(1, Number(q.page_size) || 100));
      let rows = (ctx.db.prepare('SELECT * FROM lib_intake ORDER BY id DESC LIMIT ?').all(limit * 3) as IntakeRow[]).filter(visibleTask(scope));
      if (q.acknowledged === 'false' || q.acknowledged === '0') rows = rows.filter((r) => !acked.has(r.id));
      if (q.acknowledged === 'true' || q.acknowledged === '1') rows = rows.filter((r) => acked.has(r.id));
      const tasks = rows.slice(0, limit).map((r) => taskJson(r, acked));
      // Paperless-ngx sends a plain list; Paperless Mobile (which sends no API version) expects pages.
      return requestedVersion(req) === null ? { count: tasks.length, next: null, previous: null, results: tasks } : tasks;
    });
    app.get('/ngx/api/tasks/:id/', auth, async (req) => {
      local();
      const row = ctx.db.prepare('SELECT * FROM lib_intake WHERE id = ?').get(Number((req.params as { id: string }).id)) as IntakeRow | undefined;
      if (!row || !visibleTask(scopeOf(req))(row)) throw notFoundError();
      return taskJson(row, acknowledged(req));
    });
    const acknowledge = async (req: FastifyRequest) => {
      const ids = ((((req.body ?? {}) as Body).tasks as unknown[] | undefined) ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      const acked = acknowledged(req);
      for (const id of ids) acked.add(id);
      ctx.repos.kv.set(ackKey(req), [...acked].sort((a, b) => b - a).slice(0, 5000));
      return { result: ids.length };
    };
    app.post('/ngx/api/tasks/acknowledge/', auth, acknowledge);
    app.post('/ngx/api/acknowledge_tasks/', auth, acknowledge);

    // ---------------------------------------------------------------- trash

    app.get('/ngx/api/trash/', auth, async (req) => {
      const b = local();
      const scope = scopeOf(req);
      const q = req.query as Query;
      const { page, pageSize } = pageParams(q, 25, 1000);
      const libs = scope.libraries ? [...scope.libraries.keys()] : null;
      const where = 'd.deleted_at IS NOT NULL AND (? IS NULL OR d.library_id IN (SELECT value FROM json_each(?)))';
      const args = [libs ? 1 : null, JSON.stringify(libs ?? [])];
      const count = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM lib_documents d WHERE ${where}`).get(...args) as { c: number }).c;
      const rows = ctx.db.prepare(`SELECT d.* FROM lib_documents d WHERE ${where} ORDER BY d.deleted_at DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize) as (Parameters<LocalBackend['purgeRow']>[0] & { deleted_at: number })[];
      const docs = b.toDocuments(rows, scope, false).map((d, i) => ({ ...documentJson(req, d), deleted_at: new Date(rows[i].deleted_at).toISOString() }));
      return paginate(req, docs, count, page, pageSize, rows.map((r) => r.id));
    });
    /** Restore or delete for good: `{action: "restore" | "empty", documents?: [ids]}` (empty without ids: the whole trash). */
    app.post('/ngx/api/trash/', auth, async (req) => {
      const b = local();
      const scope = scopeOf(req);
      const body = (req.body ?? {}) as Body;
      let ids = ((body.documents as unknown[] | undefined) ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!ids.length && body.action === 'empty') {
        const libs = scope.libraries ? [...scope.libraries.keys()] : null;
        ids = (ctx.db.prepare('SELECT id FROM lib_documents WHERE deleted_at IS NOT NULL AND (? IS NULL OR library_id IN (SELECT value FROM json_each(?)))').all(libs ? 1 : null, JSON.stringify(libs ?? [])) as { id: number }[]).map((r) => r.id);
      }
      const o = origin(req, 'trash');
      for (const id of ids) {
        if (body.action === 'restore') {
          await b.restoreDocument(scope, id, o);
          ctx.events.emit({ type: 'document.restored', id });
        } else if (body.action === 'empty') {
          b.purge(scope, id, o);
          ctx.events.emit({ type: 'document.purged', id });
        } else throw new NgxError(400, 'action must be restore or empty');
      }
      return { result: 'OK', doc_ids: ids };
    });

    // ---------------------------------------------------------------- search

    app.get('/ngx/api/search/autocomplete/', auth, async (req) => {
      local();
      const q = req.query as Query;
      const term = (q.term ?? '').trim().toLowerCase();
      const limit = Math.min(50, Math.max(1, Number(q.limit) || 10));
      if (term.length < 1) return [];
      // Words that start with the term (a prefix search in the full text index): from titles first,
      // then from the text of matching documents.
      const scope = scopeOf(req);
      const word = term.replace(/["*()^:]/g, '').split(/\s+/).pop() ?? '';
      if (!word) return [];
      const libs = scope.libraries ? [...scope.libraries.keys()] : null;
      const idsFor = (col: 'title' | 'body') =>
        (
          ctx.db
            .prepare(
              `SELECT d.id FROM lib_documents d WHERE d.deleted_at IS NULL AND (? IS NULL OR d.library_id IN (SELECT value FROM json_each(?)))
               AND d.id IN (SELECT rowid FROM lib_fts WHERE lib_fts MATCH ?) ORDER BY d.id DESC LIMIT 30`,
            )
            .all(libs ? 1 : null, JSON.stringify(libs ?? []), `${col} : "${word}"*`) as { id: number }[]
        ).map((r) => r.id);
      const words = new Set<string>();
      const collect = (text: string) => {
        for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.startsWith(word) && words.size < limit) words.add(w);
      };
      const view = ctx.backend(scope);
      const titles = idsFor('title');
      if (titles.length) for (const d of await view.listDocuments({ ids: titles, fields: ['id', 'title'] })) collect(d.title);
      if (words.size < limit) {
        const bodies = idsFor('body');
        if (bodies.length) for (const d of await view.listDocuments({ ids: bodies, fields: ['id', 'content'] })) collect(d.content ?? '');
      }
      return [...words].sort().slice(0, limit);
    });

    /** The global search of Paperless-ngx (search box of the apps): documents and labels by name. */
    app.get('/ngx/api/search/', auth, async (req) => {
      local();
      const scope = scopeOf(req);
      const query = String((req.query as Query).query ?? '').trim();
      const empty = { total: 0, documents: [], saved_views: [], tags: [], correspondents: [], document_types: [], storage_paths: [], users: [], groups: [], mail_rules: [], mail_accounts: [], workflows: [], custom_fields: [] };
      if (query.length < 3) return empty;
      const res = await ctx.backend(scope).queryDocuments({ filter: { query }, sort: 'relevance', limit: 3, withCount: false });
      const lists = await labelLists(scope);
      const match = (kind: MetadataKind) =>
        lists[kind]
          .filter((e) => e.item.name.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 3)
          .map((e) => labelJson(kind, scope, e));
      const out = {
        ...empty,
        documents: res.results.map((d) => documentJson(req, d)),
        tags: match('tag'),
        correspondents: match('correspondent'),
        document_types: match('documentType'),
        custom_fields: match('customField'),
      };
      out.total = out.documents.length + out.tags.length + out.correspondents.length + out.document_types.length + out.custom_fields.length;
      return out;
    });

    // Everything else of the Paperless-ngx API: not here (an answer of the API, not the web page).
    app.all('/ngx/*', { config: { auth: 'public' } }, async (req) => {
      log.debug(`Paperless-ngx compatible API: no ${req.method} ${req.url}`);
      throw notFoundError();
    });
    app.all('/ngx', { config: { auth: 'public' } }, async () => {
      throw notFoundError();
    });
  };

/** For logs and tests: describe an error as the API answers it. */
export const ngxErrorText = (err: unknown) => describeError(err);
