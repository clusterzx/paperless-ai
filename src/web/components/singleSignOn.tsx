import { useState } from 'react';
import { KeyRound, Link2, LogIn, Unlink } from 'lucide-react';
import type { AccountInfo } from '@shared/api';
import { Alert, Badge, Button, buttonClass, Card, useConfirm, useToast } from './ui';
import { errorMessage, post } from '../lib/api';
import { cn } from '../lib/format';

/** Start of the sign-in at the OpenID Connect provider (a full page load, not a fetch). */
export function ssoLoginUrl(next: string, link = false): string {
  return `/api/auth/oidc/login?${new URLSearchParams({ next, ...(link ? { link: '1' } : {}) })}`;
}

/** "Sign in with SSO" – a link, because the browser has to leave for the provider. */
export function SsoButton({ label, next, primary, className }: { label: string; next: string; primary?: boolean; className?: string }) {
  return (
    <a href={ssoLoginUrl(next)} className={buttonClass({ variant: primary ? 'primary' : 'secondary', size: 'lg', className: cn('w-full', className) })}>
      <KeyRound className="size-4" />
      {label}
    </a>
  );
}

/** Settings → Account: link the signed-in account with the provider, or remove the link. */
export function SingleSignOnCard({ account, error, onChange }: { account: AccountInfo; error: string | null; onChange: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const { sso, hasPassword } = account;
  const unlink = async () => {
    const ok = await confirm({
      title: 'Unlink single sign-on?',
      message: 'Afterwards you sign in with your user name and password only. You can link the account again at any time.',
      confirmLabel: 'Unlink',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await post('/api/account/sso/unlink');
      toast.success('Single sign-on unlinked');
      onChange();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Single sign-on"
      icon={<LogIn className="size-4" />}
      description="Sign in with your account at the OpenID Connect provider (Authentik, Keycloak, Authelia …)."
      className="max-w-xl"
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {sso.linked ? (
          <>
            <Badge tone="success">
              <Link2 className="size-3" /> Linked
            </Badge>
            {hasPassword && (
              <p className="text-xs text-muted">
                Signing in with single sign-on skips the two-factor code of Paperless-AI – protect the account at your provider with multi-factor authentication.
              </p>
            )}
            {!hasPassword ? (
              <p className="text-sm text-muted">This account was created by single sign-on and has no password – it signs in with single sign-on only.</p>
            ) : sso.passwordLogin ? (
              <Button variant="ghost" icon={<Unlink className="size-4" />} loading={busy} onClick={unlink}>
                Unlink
              </Button>
            ) : (
              <p className="text-sm text-muted">The password login is switched off – the link cannot be removed (you could not sign in any more).</p>
            )}
          </>
        ) : sso.available ? (
          <>
            <p className="text-sm text-muted">
              Link this account once – afterwards you can sign in with single sign-on. You are sent to your provider and come back here.
            </p>
            <a href={ssoLoginUrl('/settings?tab=account', true)} className={buttonClass({ variant: 'primary' })}>
              <Link2 className="size-4" />
              Link with single sign-on
            </a>
          </>
        ) : (
          <p className="text-sm text-muted">Single sign-on is not set up (Settings → Sign-in).</p>
        )}
      </div>
    </Card>
  );
}
