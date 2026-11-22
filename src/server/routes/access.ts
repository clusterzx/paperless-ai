/**
 * User and group management (admins), personal API keys, the audit log and in-app notifications.
 * See docs/standalone/access-control.md.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ApiKeyInfo, AuditEntryInfo, GroupInfo, NotificationInfo, UserInfo } from '../../shared/api.js';
import type { Services } from '../http/app.js';
import { badRequest, HttpProblem, notFound } from '../http/helpers.js';
import { hashPassword, validatePassword } from '../auth.js';
import { API_SCOPES, canEdit, isAdmin, type AccessScope } from '../access/scope.js';
import { allowedScopes, audit } from '../access/context.js';
import type { ApiKeyRow } from '../db/accessRepo.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'access' });

const id = z.object({ id: z.coerce.number().int().positive() });
const username = z.string().trim().min(1).max(100);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

function keyInfo(k: ApiKeyRow, user?: { id: number; username: string }): ApiKeyInfo {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    libraryIds: k.library_ids,
    createdAt: k.created_at,
    lastUsedAt: k.last_used_at,
    expiresAt: k.expires_at,
    revoked: Boolean(k.revoked_at),
    ...(user ? { user } : {}),
  };
}

export const accessRoutes =
  ({ ctx }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();
    const users = ctx.repos.users;
    const groups = ctx.repos.groups;

    const me = (req: FastifyRequest) => {
      const p = req.principal;
      if (p?.kind !== 'user') throw new HttpProblem(403, 'Only signed-in users have this');
      return p;
    };

    const userInfo = (): UserInfo[] => {
      const memberships = new Map<number, { id: number; name: string }[]>();
      for (const g of groups.list()) for (const u of groups.members(g.id)) memberships.set(u, [...(memberships.get(u) ?? []), { id: g.id, name: g.name }]);
      return users.list().map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        displayName: u.display_name,
        email: u.email,
        disabled: Boolean(u.disabled_at),
        createdAt: u.created_at,
        sso: u.sso,
        password: u.password,
        twoFactor: u.two_factor,
        groups: memberships.get(u.id) ?? [],
      }));
    };

    /** Admins that can still sign in, without `exceptId`. */
    const otherActiveAdmins = (exceptId: number) => users.list().filter((u) => u.role === 'admin' && !u.disabled_at && u.id !== exceptId).length;

    // ---------------------------------------------------------------- users (admins)

    app.get('/api/users', async (): Promise<UserInfo[]> => userInfo());

    app.post(
      '/api/users',
      {
        schema: {
          body: z.object({
            username,
            password: z.string().max(200).optional(),
            role: z.enum(['admin', 'member']).default('member'),
            displayName: optionalText(200),
            email: optionalText(200),
          }),
        },
      },
      async (req): Promise<UserInfo> => {
        const b = req.body;
        if (users.byUsername(b.username)) throw badRequest('This username is already taken');
        let hash = '';
        if (b.password) {
          const problem = validatePassword(b.password);
          if (problem) throw badRequest(problem);
          hash = await hashPassword(b.password);
        }
        const newId = users.create(b.username, hash, b.role);
        users.setProfile(newId, { displayName: b.displayName ?? null, email: b.email ?? null });
        audit(ctx, req.access, 'user.created', `user:${newId}`, { username: b.username, role: b.role });
        log.info(`User "${b.username}" created (${b.role})`);
        return userInfo().find((u) => u.id === newId)!;
      },
    );

    app.patch(
      '/api/users/:id',
      {
        schema: {
          params: id,
          body: z.object({
            username: username.optional(),
            role: z.enum(['admin', 'member']).optional(),
            disabled: z.boolean().optional(),
            displayName: optionalText(200),
            email: optionalText(200),
            /** Set a new password (admins resetting a forgotten one). */
            password: z.string().max(200).optional(),
          }),
        },
      },
      async (req): Promise<UserInfo> => {
        const user = users.byId(req.params.id);
        if (!user) throw notFound('User not found');
        const b = req.body;
        const self = req.principal?.kind === 'user' && req.principal.userId === user.id;
        if (b.role === 'member' && user.role === 'admin' && !otherActiveAdmins(user.id)) throw badRequest('The last administrator cannot become a member');
        if (b.disabled && self) throw badRequest('You cannot disable your own account');
        if (b.disabled && user.role === 'admin' && !otherActiveAdmins(user.id)) throw badRequest('The last administrator cannot be disabled');
        if (b.username && b.username !== user.username) {
          if (users.byUsername(b.username)) throw badRequest('This username is already taken');
          users.rename(user.id, b.username);
        }
        if (b.role && b.role !== user.role) {
          users.setRole(user.id, b.role);
          audit(ctx, req.access, 'user.role_changed', `user:${user.id}`, { username: user.username, role: b.role });
        }
        if (b.disabled !== undefined && Boolean(user.disabled_at) !== b.disabled) {
          users.setDisabled(user.id, b.disabled);
          audit(ctx, req.access, b.disabled ? 'user.disabled' : 'user.enabled', `user:${user.id}`, { username: user.username });
        }
        if (b.displayName !== undefined || b.email !== undefined) users.setProfile(user.id, { displayName: b.displayName, email: b.email });
        if (b.password) {
          const problem = validatePassword(b.password);
          if (problem) throw badRequest(problem);
          users.updatePassword(user.id, await hashPassword(b.password));
          audit(ctx, req.access, 'user.password_reset', `user:${user.id}`, { username: user.username });
        }
        ctx.repos.libraries.invalidate();
        return userInfo().find((u) => u.id === user.id)!;
      },
    );

    app.delete('/api/users/:id', { schema: { params: id } }, async (req) => {
      const user = users.byId(req.params.id);
      if (!user) throw notFound('User not found');
      if (req.principal?.kind === 'user' && req.principal.userId === user.id) throw badRequest('You cannot delete your own account');
      if (user.role === 'admin' && !otherActiveAdmins(user.id)) throw badRequest('The last administrator cannot be deleted');
      const orphaned = ctx.repos.libraries.orphanedWithout({ type: 'user', id: user.id });
      if (orphaned.length) {
        throw badRequest(`${user.username} is the only owner of ${orphaned.map((l) => `“${l.name}”`).join(', ')} – give ${orphaned.length > 1 ? 'these libraries' : 'this library'} another owner first (Libraries → Members)`);
      }
      ctx.db.transaction(() => {
        ctx.db.prepare("DELETE FROM library_members WHERE principal_type = 'user' AND principal_id = ?").run(user.id);
        users.delete(user.id);
      })();
      ctx.repos.libraries.invalidate();
      audit(ctx, req.access, 'user.deleted', `user:${user.id}`, { username: user.username });
      log.info(`User "${user.username}" deleted`);
      return { ok: true };
    });

    // ---------------------------------------------------------------- groups (admins)

    const groupInfo = (): GroupInfo[] =>
      groups.list().map((g) => ({ id: g.id, name: g.name, sso: g.oidc_name !== null, members: groups.members(g.id), createdAt: g.created_at }));

    app.get('/api/groups', async (): Promise<GroupInfo[]> => groupInfo());

    app.post(
      '/api/groups',
      { schema: { body: z.object({ name: z.string().trim().min(1).max(100), members: z.array(z.number().int().positive()).max(10_000).default([]) }) } },
      async (req): Promise<GroupInfo> => {
        if (groups.byName(req.body.name)) throw badRequest('A group with this name exists already');
        const gid = groups.create(req.body.name);
        groups.setMembers(gid, req.body.members.filter((u) => users.byId(u)));
        ctx.repos.libraries.invalidate();
        audit(ctx, req.access, 'group.created', `group:${gid}`, { name: req.body.name, members: req.body.members.length });
        return groupInfo().find((g) => g.id === gid)!;
      },
    );

    app.patch(
      '/api/groups/:id',
      {
        schema: {
          params: id,
          body: z.object({ name: z.string().trim().min(1).max(100).optional(), members: z.array(z.number().int().positive()).max(10_000).optional() }),
        },
      },
      async (req): Promise<GroupInfo> => {
        const g = groups.get(req.params.id);
        if (!g) throw notFound('Group not found');
        if (g.oidc_name) throw badRequest('This group is synchronised from single sign-on – change it at the provider');
        if (req.body.name && req.body.name !== g.name) {
          const other = groups.byName(req.body.name);
          if (other && other.id !== g.id) throw badRequest('A group with this name exists already');
          groups.rename(g.id, req.body.name);
        }
        if (req.body.members) groups.setMembers(g.id, req.body.members.filter((u) => users.byId(u)));
        ctx.repos.libraries.invalidate();
        audit(ctx, req.access, 'group.changed', `group:${g.id}`, { name: req.body.name ?? g.name, members: req.body.members?.length });
        return groupInfo().find((x) => x.id === g.id)!;
      },
    );

    app.delete('/api/groups/:id', { schema: { params: id } }, async (req) => {
      const g = groups.get(req.params.id);
      if (!g) throw notFound('Group not found');
      const orphaned = ctx.repos.libraries.orphanedWithout({ type: 'group', id: g.id });
      if (orphaned.length) {
        throw badRequest(`The group “${g.name}” is the only owner of ${orphaned.map((l) => `“${l.name}”`).join(', ')} – give ${orphaned.length > 1 ? 'these libraries' : 'this library'} another owner first (Libraries → Members)`);
      }
      groups.delete(g.id);
      ctx.repos.libraries.invalidate();
      audit(ctx, req.access, 'group.deleted', `group:${g.id}`, { name: g.name });
      return { ok: true };
    });

    // ---------------------------------------------------------------- personal API keys

    app.get('/api/me/api-keys', { config: { auth: 'session' } }, async (req): Promise<ApiKeyInfo[]> => {
      return ctx.repos.apiKeys.list(me(req).userId).map((k) => keyInfo(k));
    });

    app.post(
      '/api/me/api-keys',
      {
        config: { auth: 'session' },
        schema: {
          body: z.object({
            name: z.string().trim().min(1).max(100),
            scopes: z.array(z.enum(API_SCOPES)).min(1),
            libraryIds: z.array(z.number().int().positive()).max(1000).nullable().optional(),
            expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
          }),
        },
      },
      async (req): Promise<{ key: string; info: ApiKeyInfo }> => {
        const p = me(req);
        const permitted = new Set(allowedScopes(p.role));
        const refused = req.body.scopes.filter((s) => !permitted.has(s));
        if (refused.length) throw badRequest(`Only administrators can create keys with the scope ${refused.join(', ')}`);
        const libraryIds = req.body.libraryIds?.length ? req.body.libraryIds : null;
        if (libraryIds && req.access?.libraries) {
          const outside = libraryIds.filter((l) => !req.access!.libraries!.has(l));
          if (outside.length) throw badRequest('A key can only be limited to libraries you belong to');
        }
        const { id: keyId, key } = ctx.repos.apiKeys.create(p.userId, {
          name: req.body.name,
          scopes: req.body.scopes,
          libraryIds,
          expiresAt: req.body.expiresInDays ? Date.now() + req.body.expiresInDays * 86_400_000 : null,
        });
        audit(ctx, req.access, 'apikey.created', `apikey:${keyId}`, { name: req.body.name, scopes: req.body.scopes });
        return { key, info: keyInfo(ctx.repos.apiKeys.get(keyId)!) };
      },
    );

    const revoke = (scope: AccessScope | null, keyId: number, ownerId?: number) => {
      const k = ctx.repos.apiKeys.get(keyId);
      if (!k || (ownerId !== undefined && k.user_id !== ownerId)) throw notFound('API key not found');
      ctx.repos.apiKeys.revoke(k.id);
      audit(ctx, scope, 'apikey.revoked', `apikey:${k.id}`, { name: k.name, user: k.user_id });
    };

    app.delete('/api/me/api-keys/:id', { config: { auth: 'session' }, schema: { params: id } }, async (req) => {
      revoke(req.access, req.params.id, me(req).userId);
      return { ok: true };
    });

    // Admins: all keys of all users.
    app.get('/api/api-keys', async (): Promise<ApiKeyInfo[]> => {
      const names = new Map(users.list().map((u) => [u.id, u.username]));
      return ctx.repos.apiKeys.list().map((k) => keyInfo(k, { id: k.user_id, username: names.get(k.user_id) ?? `#${k.user_id}` }));
    });

    app.delete('/api/api-keys/:id', { schema: { params: id } }, async (req) => {
      if (!req.access || !isAdmin(req.access)) throw new HttpProblem(403, 'Only administrators can do this');
      revoke(req.access, req.params.id);
      return { ok: true };
    });

    // ---------------------------------------------------------------- profile

    app.patch(
      '/api/account/profile',
      {
        config: { auth: 'session' },
        schema: { body: z.object({ displayName: optionalText(200), email: optionalText(200), defaultLibraryId: z.number().int().positive().nullable().optional() }) },
      },
      async (req) => {
        const userId = me(req).userId;
        users.setProfile(userId, { displayName: req.body.displayName, email: req.body.email });
        if (req.body.defaultLibraryId !== undefined) {
          const libId = req.body.defaultLibraryId;
          if (libId !== null) {
            const lib = ctx.repos.libraries.get(libId);
            if (!lib || lib.deleted_at || !canEdit(req.access!, libId)) throw badRequest('Choose a library you can add documents to');
          }
          users.setDefaultLibrary(userId, libId);
        }
        return { ok: true };
      },
    );

    // ---------------------------------------------------------------- audit log

    app.get(
      '/api/audit-log',
      { schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().positive().optional() }) } },
      async (req): Promise<AuditEntryInfo[]> => {
        const scope = req.access!;
        let libraryIds: number[] | null = null;
        if (!isAdmin(scope)) {
          // Library owners see the entries of their libraries.
          libraryIds = [...(scope.libraries ?? new Map()).entries()].filter(([, role]) => role === 'owner').map(([lib]) => lib);
          if (!libraryIds.length) throw new HttpProblem(403, 'Only administrators and library owners can see the audit log');
        }
        return ctx.repos.audit.list({ libraryIds, limit: req.query.limit, before: req.query.before }).map((e) => ({
          id: e.id,
          at: e.at,
          actor: e.actor_name ?? e.actor_type,
          actorType: e.actor_type,
          action: e.action,
          target: e.target,
          libraryId: e.library_id,
          details: e.details,
        }));
      },
    );

    // ---------------------------------------------------------------- notifications

    app.get('/api/notifications', async (req): Promise<{ items: NotificationInfo[]; unread: number }> => {
      if (req.principal?.kind !== 'user') return { items: [], unread: 0 };
      const userId = req.principal.userId;
      return {
        items: ctx.repos.notifications.list(userId).map((n) => ({ id: n.id, at: n.at, title: n.title, body: n.body, link: n.link, read: n.read_at !== null })),
        unread: ctx.repos.notifications.unread(userId),
      };
    });

    app.post(
      '/api/notifications/read',
      { schema: { body: z.object({ ids: z.array(z.number().int().positive()).max(1000).optional() }).nullish() } },
      async (req) => {
        if (req.principal?.kind === 'user') ctx.repos.notifications.markRead(req.principal.userId, req.body?.ids);
        return { ok: true };
      },
    );
  };
