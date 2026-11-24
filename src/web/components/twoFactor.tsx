import { useState } from 'react';
import { Copy, Download, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import type { TwoFactorSetup, TwoFactorStatus } from '@shared/api';
import { Alert, Badge, Button, Card, Field, Input, Modal, Skeleton, useToast } from './ui';
import { errorMessage, get, post } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { formatDate } from '../lib/format';
import { localDay } from '@shared/dates';

/** Two-factor authentication of the signed-in user (Settings → Account). */
export function TwoFactorCard() {
  const toast = useToast();
  const status = useAsync((signal) => get<TwoFactorStatus>('/api/account/2fa', signal), []);
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [starting, setStarting] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [action, setAction] = useState<'disable' | 'codes' | null>(null);

  const start = async () => {
    setStarting(true);
    try {
      setSetup(await post<TwoFactorSetup>('/api/account/2fa/setup'));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const s = status.data;
  return (
    <Card
      title="Two-factor authentication"
      icon={<ShieldCheck className="size-4" />}
      description="A code from an authenticator app (Aegis, Google Authenticator, 1Password, Bitwarden …) in addition to your password."
      className="max-w-xl"
    >
      {status.error && <Alert tone="danger">{status.error}</Alert>}
      {!s ? (
        <Skeleton className="h-16" />
      ) : s.enabled ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="success">
              <ShieldCheck className="size-3" /> Enabled
            </Badge>
            {s.enabledAt && <span className="text-xs text-muted">since {formatDate(s.enabledAt)}</span>}
            <Badge tone={s.recoveryCodesLeft <= 3 ? 'warn' : 'neutral'}>
              {s.recoveryCodesLeft} recovery code{s.recoveryCodesLeft === 1 ? '' : 's'} left
            </Badge>
          </div>
          {s.recoveryCodesLeft <= 3 && <Alert tone="warn">Only a few recovery codes are left – create new ones and store them in a safe place.</Alert>}
          <p className="text-xs text-muted">API keys (webhooks, scripts, browser extension) keep working without a code.</p>
          <div className="flex flex-wrap gap-2">
            <Button icon={<KeyRound className="size-4" />} onClick={() => setAction('codes')}>
              New recovery codes
            </Button>
            <Button variant="ghost" icon={<ShieldOff className="size-4" />} onClick={() => setAction('disable')}>
              Switch off
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">Not enabled. Signing in needs only your password.</p>
          <Button variant="primary" icon={<ShieldCheck className="size-4" />} loading={starting} onClick={start}>
            Set up
          </Button>
        </div>
      )}

      <SetupModal
        setup={setup}
        onClose={() => setSetup(null)}
        onEnabled={(c) => {
          setSetup(null);
          setCodes(c);
          void status.reload();
        }}
      />
      <ConfirmModal
        action={action}
        onClose={() => setAction(null)}
        onDone={(c) => {
          setAction(null);
          if (c) setCodes(c);
          else toast.success('Two-factor authentication switched off');
          void status.reload();
        }}
      />
      <RecoveryCodesModal codes={codes} onClose={() => setCodes(null)} />
    </Card>
  );
}

function SetupModal({ setup, onClose, onEnabled }: { setup: TwoFactorSetup | null; onClose: () => void; onEnabled: (codes: string[]) => void }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setCode('');
    setPassword('');
    setError(null);
    onClose();
  };
  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ recoveryCodes: string[] }>('/api/account/2fa/enable', { code, password });
      setCode('');
      setPassword('');
      toast.success('Two-factor authentication enabled – other sessions were signed out');
      onEnabled(res.recoveryCodes);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(setup)}
      onClose={close}
      title="Set up two-factor authentication"
      footer={
        <Button variant="primary" loading={busy} disabled={code.trim().length < 6 || !password} onClick={enable}>
          Enable
        </Button>
      }
    >
      {setup && (
        <div className="space-y-4">
          <p className="text-sm text-muted">1. Scan the QR code with your authenticator app – or enter the key by hand.</p>
          <div className="flex flex-wrap items-center gap-4">
            <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qrSvg)}`} alt="QR code for the authenticator app" className="size-44 rounded-lg border border-border bg-white" />
            <div className="min-w-0 space-y-1">
              <div className="text-xs text-muted">Key</div>
              <code className="block font-mono text-sm break-all" aria-label="Secret key">
                {setup.secret.match(/.{1,4}/g)?.join(' ')}
              </code>
              <Button
                size="sm"
                variant="ghost"
                icon={<Copy className="size-3.5" />}
                onClick={() =>
                  navigator.clipboard.writeText(setup.secret).then(
                    () => toast.success('Key copied'),
                    () => toast.error('Copying failed'),
                  )
                }
              >
                Copy key
              </Button>
            </div>
          </div>
          <p className="text-sm text-muted">2. Enter the 6-digit code the app shows and your password.</p>
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Code from the app">
              <Input autoComplete="one-time-code" inputMode="numeric" placeholder="123456" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Field label="Current password">
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Password and a code (or recovery code) before switching off or replacing the recovery codes. */
function ConfirmModal({ action, onClose, onDone }: { action: 'disable' | 'codes' | null; onClose: () => void; onDone: (codes: string[] | null) => void }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setCode('');
    setPassword('');
    setError(null);
    onClose();
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (action === 'codes') {
        const res = await post<{ recoveryCodes: string[] }>('/api/account/2fa/recovery-codes', { password, code });
        onDone(res.recoveryCodes);
      } else {
        await post('/api/account/2fa/disable', { password, code });
        onDone(null);
      }
      setCode('');
      setPassword('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={action !== null}
      onClose={close}
      title={action === 'codes' ? 'New recovery codes' : 'Switch off two-factor authentication?'}
      footer={
        <Button variant={action === 'disable' ? 'danger' : 'primary'} loading={busy} disabled={code.trim().length < 6 || !password} onClick={submit}>
          {action === 'codes' ? 'Create new codes' : 'Switch off'}
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {action === 'codes' ? 'The old recovery codes stop working.' : 'Signing in will need only your password again.'} Confirm with your password and a code from the app (or a recovery
          code).
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code">
            <Input autoComplete="one-time-code" placeholder="123456" maxLength={40} value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Field label="Current password">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function RecoveryCodesModal({ codes, onClose }: { codes: string[] | null; onClose: () => void }) {
  const toast = useToast();
  const text = codes ? `Paperless-AI recovery codes (${localDay()})\nEach code works once.\n\n${codes.join('\n')}\n` : '';
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'paperless-ai-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Modal
      open={Boolean(codes)}
      onClose={onClose}
      title="Your recovery codes"
      footer={
        <Button variant="primary" onClick={onClose}>
          I have stored them
        </Button>
      }
    >
      <div className="space-y-4">
        <Alert tone="warn">Store these codes in a safe place (password manager, printout). They are shown only now. Each code signs you in once if your phone is not at hand.</Alert>
        <ul className="grid grid-cols-2 gap-2 font-mono text-sm" aria-label="Recovery codes">
          {codes?.map((c) => (
            <li key={c} className="rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-center">
              {c}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            icon={<Copy className="size-3.5" />}
            onClick={() =>
              navigator.clipboard.writeText(text).then(
                () => toast.success('Recovery codes copied'),
                () => toast.error('Copying failed'),
              )
            }
          >
            Copy
          </Button>
          <Button size="sm" icon={<Download className="size-3.5" />} onClick={download}>
            Download
          </Button>
        </div>
      </div>
    </Modal>
  );
}
