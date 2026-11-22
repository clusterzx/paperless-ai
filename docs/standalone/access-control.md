# Access control: users, roles, libraries

← [Overview](README.md)

## 1. Current state (v4.4.0)

* `users` has no role. Every signed-in user can do everything, including changing settings.
* There is one global API key (`security.apiKey`). `Principal` is
  `{ kind: 'user'; userId; username } | { kind: 'apiKey' }` (`src/server/auth.ts`): an API key is
  not tied to a user.
* Auth levels per route: `public`, `user`, `session`, `setup` (`src/server/http/app.ts`).
* Companion mode uses one Paperless-ngx token. Every Paperless-AI user sees what this token sees,
  including through Ask / chat. Paperless-ngx permissions are not read.

This is fine for one person. For archives shared by several users it is not, and it is the
foundation for the built-in archive. M1 therefore comes before the built-in archive, and it helps
companion installations as well.

## 2. Model

```
instance role (users.role)        admin | member
group                             users ⟷ groups (manual or from the OIDC groups claim)
library membership                (library, user|group) → owner | editor | viewer
document                          belongs to exactly one library
```

### Instance roles

| Action | admin | member |
| --- | --- | --- |
| Settings (AI, processing, OCR, RAG, auth), logs, debug | ✓ | – |
| Users, groups, roles | ✓ | – |
| Create libraries | ✓ | ✓ (setting `archive.membersCreateLibraries`, default on) |
| Manage membership of any library (audited) | ✓ | – |
| Own profile, password, 2FA, own API keys | ✓ | ✓ |
| Prompt library, prompt wizard, playground | ✓ | view / try only |

Admins are **not** implicitly members of every library. They can manage membership, including
adding themselves, and every such change is written to the audit log (§9). A family member's
private library stays private unless the admin visibly takes access.

### Library roles

| Action | viewer | editor | owner |
| --- | --- | --- | --- |
| List, search, view, download, thumbnails | ✓ | ✓ | ✓ |
| Ask your archive / document chat over the library | ✓ | ✓ | ✓ |
| Calendar events of its documents, iCal feed | ✓ | ✓ | ✓ |
| Change log (read) | ✓ | ✓ | ✓ |
| Upload, new version, edit metadata, bulk edit, undo | – | ✓ | ✓ |
| Create tags / correspondents / types / custom fields | – | ✓ | ✓ |
| Rename / delete metadata, delete documents (to trash), restore | – | ✓ | ✓ |
| Run analysis / OCR by hand, review suggestions | – | ✓ | ✓ |
| Members, library settings, retention, intake channels of the library | – | – | ✓ |
| Workflows of the library | – | view | ✓ |
| Purge trash, delete versions, delete the library | – | – | ✓ |

A user's effective role in a library is the highest of their direct membership and their groups'
memberships.

## 3. `AccessContext`

```ts
// src/server/access/context.ts
export type Principal =
  | { kind: 'user'; userId: number; username: string; role: 'admin' | 'member'; via: 'session' | 'apiKey'; apiKeyId?: number }
  | { kind: 'legacyApiKey' }                 // security.apiKey of ≤ 4.x, acts as admin
  | { kind: 'workflow'; workflowId: number; libraryId: number | null }
  | { kind: 'system'; task: string };        // engine, OCR, RAG sync, maintenance

export interface AccessScope {
  principal: Principal;
  /** Libraries and the effective role in each; null = all (system, legacy key in companion mode). */
  libraries: ReadonlyMap<number, 'owner' | 'editor' | 'viewer'> | null;
  /** API key scopes (session = all). */
  scopes: ReadonlySet<ApiScope>;
}

export function can(scope: AccessScope, action: LibraryAction, libraryId: number): boolean;
export function readableLibraries(scope: AccessScope): number[] | null;
```

* The auth hook in `http/app.ts` builds the scope once per request (one query on
  `library_members` + `group_members`, cached per user and invalidated on every membership,
  group or library change) and sets it as `req.access`. It runs in `onRequest`, before the body is
  parsed and validated, so callers without access learn nothing about a route's input.
* Who may call a route at all (admin, API key scope) is decided by one table,
  `src/server/http/policy.ts`. Library roles are checked by the backend per document.
* Services take the scope as an **explicit parameter**. `AsyncLocalStorage` is not used for
  authorization: explicit parameters can be tested and nothing gets forgotten implicitly.
* Background work uses `systemScope(task)`. Workflow runs use the workflow scope (§6).
* Documents the scope cannot read answer **404, not 403**, so their existence does not leak.

## 4. Where access is enforced

The rule: **filters are part of the SQL** (`library_id IN (…)`), in the backend and in the index.
They are never applied to results afterwards in a route.

| Place | How |
| --- | --- |
| `LocalBackend` list / search / count / get / download / thumbnail | `library_id IN (readable)` in every query; by-id lookups include it in the `WHERE` |
| `LocalBackend` writes | `can(scope, 'edit', doc.library_id)` before the transaction; moving between libraries needs edit rights in both |
| Document full text (`lib_fts`) | join with `lib_documents` and the library filter (measured: no extra cost, see search-and-scale.md) |
| RAG (Ask, chat) | `rag_documents.library_id`; BM25 query with the library filter; the vector search gets `allowDocs` **before** ranking (`VectorIndex.search` already supports it). The LLM context never mixes in documents outside the scope. |
| Calendar | events join `lib_documents`; the iCal feed token belongs to a user (`calendar_feeds` table instead of the global `kv: calendar.feedToken`) and is evaluated with that user's scope |
| Dashboard, statistics, metadata counts | computed per scope (from `lib_counters` per readable library) |
| History, change log, OCR page, problems list | join through the document's library |
| Command palette, document picker, playground | backend search with the scope |
| SSE (live log, processing status) | document titles only for readable documents; the full log needs admin |
| Exports, migration assistant | admin, or owner of the exported library |

**Implemented (M5):** the table above holds, with these notes: history, problems, statistics,
OCR list and processing status filter through `db/scoped.ts` (`document_id IN (documents of the
readable libraries)`); token usage on the dashboard is admin-only (instance-wide); owners pick new
members from `GET /api/libraries/:id/candidates` (names only) without access to the user
administration. `test/integration/isolation.test.ts` is the data part of the permission matrix: a
viewer of one library calls every GET route (session and API key), Ask/chat/ask and the calendar
feed, and neither responses nor AI prompts may contain a marker of the other library.

## 5. API keys

* Per user, several keys, each with a name, **scopes** and optionally a library list (table
  `api_keys`, see [data-model.md](data-model.md#31-users-groups-api-keys-both-modes-m1)).
* Scopes: `read` (list, search, download), `write` (change documents, restore from the trash),
  `delete` (trash, delete for good, delete versions), `metadata` (create, rename, merge, delete
  tags, correspondents, types, custom fields), `upload`, `chat` (Ask / document chat), `mcp` (the MCP
  server at `/mcp`; its tools need the other scopes), `webhook` (enqueue processing), `admin`
  (settings; only for admin users). The table in `http/policy.ts` maps routes to scopes; bulk edits
  and the trash of the Paperless-ngx compatible API check `delete` for their delete actions. Keys
  with `write` from before migration 18 received `delete` and `metadata` (they were part of it).
* Rate limit per key (`rate_limit`, requests per minute, token bucket in memory): `429` with
  `Retry-After` for the whole API.
* An admin's key acts as an administrator only with the `admin` scope: without it, it cannot manage
  libraries it does not own, watch folders (paths on the server) or mail accounts.
* A key limited to libraries (Settings → API keys → Libraries) only sees those, and uploads without
  a library go to one of them – a key per scanner or phone decides where its documents go.
* Format `pai_<prefix8>_<secret>` (256 random bits). Only the SHA-256 of the key is stored: the
  keys are random, so a slow password hash would add nothing. The prefix is used for lookup and
  display, the comparison is constant-time. Keys are accepted in `x-api-key`,
  `Authorization: Bearer …` and – for apps made for Paperless-ngx – `Authorization: Token …`.
* The **legacy global key** (`security.apiKey`) keeps working as `legacyApiKey` with admin rights,
  so the browser extension and existing webhooks keep working. The UI marks it as legacy and offers
  to replace it. A setting can switch it off.
* The Paperless-ngx webhook (`/api/webhook/document`) accepts a key with the `webhook` scope.

### Owners

A library always keeps an owner who can sign in: saving members needs an active user or a group
with active members as owner, and a user or group that is the only owner of a library cannot be
deleted until the library has another one. Library names are unique (case ignored).

## 6. Workflows and access

* A workflow belongs to a library (owners create it) or is global (admins).
* It runs with a `workflow` principal whose scope is its library (global: all libraries). Actions
  that target another library (move) are checked against the library list stored with the
  workflow, which is validated when it is saved.
* If the creator loses the owner role, their workflows of that library are suspended and shown as
  such. They do not keep running with rights nobody holds.

## 7. Companion mode

**v1 (M1): one shared view, stated openly.**

* All Paperless-AI users see what the configured Paperless-ngx token sees. The UI says so (user
  management and Ask page).
* Roles still apply to Paperless-AI functions: only admins change settings, and API keys belong to
  users. Library roles do not exist in this mode (`capabilities.libraries = false`).

**Later: mapping per user.**

1. Each Paperless-AI user is linked to a Paperless-ngx user. Either they store their own ngx token
   in their profile, or the service token is used and the link is made by user name / OIDC subject.
2. The RAG sync stores owner and view permissions per document. The ngx API returns them with
   `full_perms=true` on the document list (verify for API v7–v10). Table
   `ngx_acl(document_id, owner_id, view_users JSON, view_groups JSON)` in `index.db`.
3. Search, chat and calendar filter with `allowDocs` from this table and the user's ngx groups.
4. Writes use the user's own token when one is stored, so Paperless-ngx enforces its permissions
   itself.

## 8. OIDC

* Groups from the existing `groupsClaim` are synchronised into `groups` (`oidc_name`) on every
  sign-in. Synchronised groups cannot be edited by hand.
* New setting `auth.oidc.adminGroups`: members become admins on sign-in, and lose the role when
  they leave the group.
* Library membership can name OIDC groups, so access is managed in the identity provider.

## 9. Audit log (non-document events)

Changes that are not document changes go to a small `audit_log` table in the core database:

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id INTEGER,
  action TEXT NOT NULL,      -- user.created, user.role_changed, library.member_added, apikey.created, settings.saved, …
  target TEXT,               -- 'library:3', 'user:5'
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_at ON audit_log(at);
```

Admins see it under Settings → Audit log. Library owners see the entries of their library.

## 10. Upgrade path

* Migration in M1: all existing users become `admin`. Today everyone can do everything, so no one
  loses rights.
* In the built-in archive, the first library is created during setup with the setup user as owner.
* Moving from companion to built-in (migration assistant): options for mapping Paperless-ngx
  owners and permissions to libraries, see [migration.md](migration.md#4-permissions).

## 11. Tests

* **Permission matrix:** a table-driven test runs every route with every role (admin,
  member-owner, member-editor, member-viewer, non-member, each API key scope, legacy key) against a
  fixture with two libraries. It asserts status codes and that no foreign document id appears in
  any response body, SSE stream or LLM prompt (the mock LLM records prompts).
* New routes must be added to the matrix, otherwise the test fails (route list from
  `app.printRoutes()`).
