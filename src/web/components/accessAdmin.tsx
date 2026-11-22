/**
 * Settings → Users & groups (admins), API keys (everyone), Audit log (admins and library owners).
 */
import { useState } from 'react';
import { Ban, Check, Copy, KeyRound, Plus, ScrollText, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';
import { API_SCOPES, type ApiKeyInfo, type ApiScope, type AuditEntryInfo, type GroupInfo, type LibraryInfo, type UserInfo } from '@shared/api';
import { Alert, Badge, Button, Card, EmptyState, Field, IconButton, Input, Modal, Select, Skeleton, useConfirm, useToast } from './ui';
import { del, errorMessage, get, patch, post } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { formatDate, timeAgo } from '../lib/format';
import { useSession } from '../lib/session';

const SCOPE_LABEL: Record<ApiScope, string> = {
  read: 'Read documents',
  write: 'Change documents',
  upload: 'Upload documents',
  chat: 'Ask & chat',
  webhook: 'Webhook (queue processing)',
  admin: 'Administration',
};

// ---------------------------------------------------------------- users

function UserModal({ user, groups, onClose, onSaved }: { user: UserInfo | null; groups: GroupInfo[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [username, setUsername] = useState(user?.username ?? '');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [role, setRole] = useState<'admin' | 'member'>(user?.role ?? 'member');
  const [password, setPassword] = useState('');
  const [memberOf, setMemberOf] = useState<number[]>(user?.groups.map((g) => g.id) ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { username: username.trim(), displayName: displayName.trim() || null, email: email.trim() || null, role, ...(password ? { password } : {}) };
      const saved = user ? await patch<UserInfo>(`/api/users/${user.id}`, body) : await post<UserInfo>('/api/users', body);
      // Group memberships are stored on the groups.
      for (const g of groups.filter((x) => !x.sso)) {
        const has = g.members.includes(saved.id);
        const wants = memberOf.includes(g.id);
        if (has !== wants) await patch(`/api/groups/${g.id}`, { members: wants ? [...g.members, saved.id] : g.members.filter((m) => m !== saved.id) });
      }
      toast.success(user ? 'User saved' : 'User created');
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={user ? `Edit ${user.username}` : 'New user'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!username.trim()} onClick={save}>
            {user ? 'Save' : 'Create user'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="User name">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Role" hint={role === 'admin' ? 'Settings, users and all administration.' : 'Documents of their libraries, Ask, calendar.'}>
            <Select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'member')}>
              <option value="member">Member</option>
              <option value="admin">Administrator</option>
            </Select>
          </Field>
          <Field label="Display name">
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Field label="E-mail" hint="For notifications from workflows.">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>
        <Field
          label={user ? 'New password' : 'Password'}
          hint={user ? 'Leave empty to keep the password. Setting one signs the user out everywhere.' : 'Leave empty for accounts that only sign in with single sign-on.'}
        >
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        {groups.length > 0 && (
          <Field label="Groups">
            <div className="flex flex-wrap gap-2">
              {groups.map((g) => {
                const on = memberOf.includes(g.id);
                return (
                  <button
                    key={g.id}
                    type="button"
                    disabled={g.sso}
                    title={g.sso ? 'Synchronised from single sign-on' : undefined}
                    onClick={() => setMemberOf((m) => (on ? m.filter((x) => x !== g.id) : [...m, g.id]))}
                    className={`rounded-full border px-3 py-1 text-sm transition ${on ? 'border-accent bg-accent-soft text-accent-text' : 'border-border text-muted hover:text-fg'} disabled:opacity-60`}
                  >
                    {on && <Check className="mr-1 inline size-3.5" />}
                    {g.name}
                  </button>
                );
              })}
            </div>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function GroupModal({ group, users, onClose, onSaved }: { group: GroupInfo | null; users: UserInfo[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(group?.name ?? '');
  const [members, setMembers] = useState<number[]>(group?.members ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    try {
      if (group) await patch(`/api/groups/${group.id}`, { name: name.trim(), members });
      else await post('/api/groups', { name: name.trim(), members });
      toast.success(group ? 'Group saved' : 'Group created');
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={group ? `Edit ${group.name}` : 'New group'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>
            {group ? 'Save' : 'Create group'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Members" hint="Groups can be members of libraries – everyone in the group gets the role.">
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-border p-2">
            {users.map((u) => (
              <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2">
                <input type="checkbox" checked={members.includes(u.id)} onChange={(e) => setMembers((m) => (e.target.checked ? [...m, u.id] : m.filter((x) => x !== u.id)))} />
                {u.displayName || u.username}
                {u.displayName && <span className="text-muted">({u.username})</span>}
              </label>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

export function UsersTab() {
  const toast = useToast();
  const confirm = useConfirm();
  const { session } = useSession();
  const users = useAsync((signal) => get<UserInfo[]>('/api/users', signal), []);
  const groups = useAsync((signal) => get<GroupInfo[]>('/api/groups', signal), []);
  const [editUser, setEditUser] = useState<UserInfo | null | 'new'>(null);
  const [editGroup, setEditGroup] = useState<GroupInfo | null | 'new'>(null);
  const reload = () => {
    void users.reload();
    void groups.reload();
  };
  const toggleDisabled = async (u: UserInfo) => {
    try {
      await patch(`/api/users/${u.id}`, { disabled: !u.disabled });
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const remove = async (u: UserInfo) => {
    if (!(await confirm({ title: `Delete ${u.username}?`, message: 'The account, its API keys and its library memberships are removed.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await del(`/api/users/${u.id}`);
      toast.success('User deleted');
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const removeGroup = async (g: GroupInfo) => {
    if (!(await confirm({ title: `Delete the group ${g.name}?`, message: 'Its library memberships are removed as well.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await del(`/api/groups/${g.id}`);
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  if (users.error) return <Alert tone="danger">{users.error}</Alert>;
  const userList = users.data ?? [];
  const groupList = groups.data ?? [];
  return (
    <div className="space-y-6">
      <Card
        title="Users"
        icon={<Users className="size-4" />}
        description="Administrators manage Paperless-AI; members work with the documents of their libraries."
        actions={
          <Button size="sm" icon={<UserPlus className="size-4" />} onClick={() => setEditUser('new')}>
            Add user
          </Button>
        }
        bodyClassName="p-0"
      >
        {!users.data ? (
          <Skeleton className="m-5 h-32" />
        ) : (
          <ul className="divide-y divide-border">
            {userList.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <button type="button" className="font-medium text-fg hover:underline" onClick={() => setEditUser(u)}>
                    {u.displayName || u.username}
                  </button>
                  {u.displayName && <span className="ml-2 text-sm text-muted">{u.username}</span>}
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {u.role === 'admin' && (
                      <Badge tone="accent">
                        <ShieldCheck className="mr-1 inline size-3" />
                        Administrator
                      </Badge>
                    )}
                    {u.disabled && <Badge tone="danger">Disabled</Badge>}
                    {u.sso && <Badge tone="info">SSO</Badge>}
                    {u.twoFactor && <Badge tone="success">2FA</Badge>}
                    {u.groups.map((g) => (
                      <Badge key={g.id}>{g.name}</Badge>
                    ))}
                  </div>
                </div>
                <span className="text-xs text-muted">since {formatDate(u.createdAt)}</span>
                {session?.user?.id !== u.id && (
                  <>
                    <IconButton label={u.disabled ? 'Enable' : 'Disable'} onClick={() => toggleDisabled(u)}>
                      <Ban className="size-4" />
                    </IconButton>
                    <IconButton label="Delete" onClick={() => remove(u)}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Groups"
        description="Give a group a role in a library and everyone in it gets access. Groups from single sign-on are kept in sync on every sign-in."
        actions={
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditGroup('new')}>
            Add group
          </Button>
        }
        bodyClassName="p-0"
      >
        {groupList.length === 0 ? (
          <div className="p-5 text-sm text-muted">No groups yet.</div>
        ) : (
          <ul className="divide-y divide-border">
            {groupList.map((g) => (
              <li key={g.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <button type="button" className="font-medium text-fg hover:underline disabled:no-underline" disabled={g.sso} onClick={() => setEditGroup(g)}>
                    {g.name}
                  </button>
                  {g.sso && (
                    <Badge tone="info" className="ml-2">
                      SSO
                    </Badge>
                  )}
                  <div className="text-xs text-muted">
                    {g.members.length} member{g.members.length === 1 ? '' : 's'}:{' '}
                    {g.members
                      .map((m) => userList.find((u) => u.id === m)?.username)
                      .filter(Boolean)
                      .join(', ') || '–'}
                  </div>
                </div>
                <IconButton label="Delete" onClick={() => removeGroup(g)}>
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editUser && <UserModal user={editUser === 'new' ? null : editUser} groups={groupList} onClose={() => setEditUser(null)} onSaved={reload} />}
      {editGroup && <GroupModal group={editGroup === 'new' ? null : editGroup} users={userList} onClose={() => setEditGroup(null)} onSaved={reload} />}
    </div>
  );
}

// ---------------------------------------------------------------- API keys

function NewKeyModal({ onClose, onCreated, isAdmin, libraries }: { onClose: () => void; onCreated: () => void; isAdmin: boolean; libraries: LibraryInfo[] }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(['read']);
  const [libraryIds, setLibraryIds] = useState<number[]>([]);
  const [days, setDays] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    try {
      const res = await post<{ key: string }>('/api/me/api-keys', { name: name.trim(), scopes, libraryIds: libraryIds.length ? libraryIds : null, expiresInDays: days ? Number(days) : null });
      setKey(res.key);
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={key ? 'Your new API key' : 'New API key'}
      footer={
        key ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={!name.trim() || !scopes.length} onClick={create}>
              Create key
            </Button>
          </>
        )
      }
    >
      {key ? (
        <div className="space-y-3">
          <Alert tone="warn">Copy the key now – it is shown only once.</Alert>
          <div className="flex gap-2">
            <Input readOnly value={key} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button
              icon={<Copy className="size-4" />}
              onClick={() =>
                navigator.clipboard.writeText(key).then(
                  () => toast.success('Copied'),
                  () => toast.error('Copying failed'),
                )
              }
            >
              Copy
            </Button>
          </div>
          <p className="text-xs text-muted">
            Send it in the <code className="kbd">x-api-key</code> header, as <code className="kbd">Authorization: Bearer …</code> or – for apps made for Paperless-ngx –
            as <code className="kbd">Authorization: Token …</code>.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Name" hint="What uses the key – e.g. “Scanner”, “Browser extension”.">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Permissions" hint="A key can never do more than your own account.">
            <div className="grid gap-1.5 sm:grid-cols-2">
              {API_SCOPES.filter((s) => s !== 'admin' || isAdmin).map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes((x) => (e.target.checked ? [...x, s] : x.filter((y) => y !== s)))} />
                  {SCOPE_LABEL[s]}
                </label>
              ))}
            </div>
          </Field>
          {libraries.length > 1 && (
            <Field
              label="Libraries"
              hint="None ticked: all your libraries. Ticked: the key only sees these – and uploads without a library (scanner, phone, WebDAV root) go to the first of them, or to your default library if it is one of them."
            >
              <div className="grid gap-1.5 sm:grid-cols-2">
                {libraries.map((l) => (
                  <label key={l.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={libraryIds.includes(l.id)} onChange={(e) => setLibraryIds((x) => (e.target.checked ? [...x, l.id] : x.filter((y) => y !== l.id)))} />
                    {l.name}
                  </label>
                ))}
              </div>
            </Field>
          )}
          <Field label="Expires after (days)" hint="Empty: never.">
            <Input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </div>
      )}
    </Modal>
  );
}

export function ApiKeysCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const { session } = useSession();
  const keys = useAsync((signal) => get<ApiKeyInfo[]>('/api/me/api-keys', signal), []);
  // Built-in archive: the libraries the user belongs to (a key can be limited to some of them).
  const withLibraries = Boolean(session?.archive?.capabilities.libraries);
  const libraries = useAsync((signal) => (withLibraries ? get<LibraryInfo[]>('/api/libraries', signal) : Promise.resolve([] as LibraryInfo[])), [withLibraries]);
  const memberOf = (libraries.data ?? []).filter((l) => l.role !== null).sort((a, b) => a.id - b.id);
  const libraryName = (id: number) => memberOf.find((l) => l.id === id)?.name ?? `#${id}`;
  const [creating, setCreating] = useState(false);
  const revoke = async (k: ApiKeyInfo) => {
    if (!(await confirm({ title: `Revoke “${k.name}”?`, message: 'Everything using the key loses access at once.', confirmLabel: 'Revoke', danger: true }))) return;
    try {
      await del(`/api/me/api-keys/${k.id}`);
      void keys.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const active = (keys.data ?? []).filter((k) => !k.revoked);
  return (
    <Card
      title="Your API keys"
      icon={<KeyRound className="size-4" />}
      description="Personal keys for scripts, scanners and apps – each with its own permissions."
      actions={
        <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          New key
        </Button>
      }
      bodyClassName="p-0"
    >
      {keys.error && <Alert tone="danger">{keys.error}</Alert>}
      {!keys.data ? (
        <Skeleton className="m-5 h-16" />
      ) : active.length === 0 ? (
        <div className="p-5 text-sm text-muted">No keys yet.</div>
      ) : (
        <ul className="divide-y divide-border">
          {active.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{k.name}</div>
                <div className="text-xs text-muted">
                  <code>pai_{k.prefix}_…</code> · used {timeAgo(k.lastUsedAt)}
                  {k.expiresAt ? ` · expires ${formatDate(k.expiresAt)}` : ''}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {k.scopes.map((s) => (
                    <Badge key={s} tone={s === 'admin' ? 'warn' : 'neutral'}>
                      {SCOPE_LABEL[s]}
                    </Badge>
                  ))}
                  {k.libraryIds?.map((id) => (
                    <Badge key={`lib-${id}`} tone="info">
                      {libraryName(id)}
                    </Badge>
                  ))}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => revoke(k)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {creating && <NewKeyModal isAdmin={session?.user?.role === 'admin'} libraries={memberOf} onClose={() => setCreating(false)} onCreated={() => void keys.reload()} />}
    </Card>
  );
}

// ---------------------------------------------------------------- audit log

const ACTION_LABEL: Record<string, string> = {
  'user.created': 'created the user',
  'user.deleted': 'deleted the user',
  'user.role_changed': 'changed the role of',
  'user.disabled': 'disabled',
  'user.enabled': 'enabled',
  'user.password_reset': 'set a new password for',
  'group.created': 'created the group',
  'group.changed': 'changed the group',
  'group.deleted': 'deleted the group',
  'apikey.created': 'created the API key',
  'apikey.revoked': 'revoked the API key',
  'apikey.legacy_regenerated': 'generated a new global API key',
  'settings.saved': 'saved the settings',
  'library.created': 'created the library',
  'library.changed': 'changed the library',
  'library.deleted': 'deleted the library',
  'library.members_changed': 'changed the members of',
};

export function AuditLogCard() {
  const [before, setBefore] = useState<number | null>(null);
  const log = useAsync((signal) => get<AuditEntryInfo[]>(`/api/audit-log?limit=100${before ? `&before=${before}` : ''}`, signal), [before]);
  return (
    <Card title="Audit log" icon={<ScrollText className="size-4" />} description="Who changed users, groups, libraries, keys and settings." bodyClassName="p-0">
      {log.error && <div className="p-5"><Alert tone="danger">{log.error}</Alert></div>}
      {!log.data ? (
        <Skeleton className="m-5 h-40" />
      ) : log.data.length === 0 ? (
        <EmptyState title="Nothing recorded yet" />
      ) : (
        <>
          <ul className="divide-y divide-border text-sm">
            {log.data.map((e) => {
              const name = typeof e.details.username === 'string' ? e.details.username : typeof e.details.name === 'string' ? e.details.name : (e.target ?? '');
              return (
                <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 px-5 py-2.5">
                  <span className="text-xs text-muted tabular-nums">{formatDate(e.at, true)}</span>
                  <span className="font-medium">{e.actor}</span>
                  <span className="text-muted">{ACTION_LABEL[e.action] ?? e.action}</span>
                  {name && <span>{name}</span>}
                  {typeof e.details.role === 'string' && <Badge>{e.details.role}</Badge>}
                </li>
              );
            })}
          </ul>
          {log.data.length === 100 && (
            <div className="border-t border-border p-3 text-center">
              <Button size="sm" variant="ghost" onClick={() => setBefore(log.data![log.data!.length - 1].id)}>
                Older entries
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
