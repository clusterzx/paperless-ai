import { useCallback, useEffect, useState } from 'react';
import { Heart } from 'lucide-react';
import { Button, IconChip, Modal } from './ui';

/** Ways to support the project – the badges are the shields.io images, shipped with the app (no request to shields.io). */
export const SUPPORT_LINKS = [
  { name: 'Patreon', href: 'https://www.patreon.com/c/clusterzx', badge: '/support/patreon.svg' },
  { name: 'PayPal', href: 'https://www.paypal.com/paypalme/bech0r', badge: '/support/paypal.svg' },
  { name: 'Buy Me a Coffee', href: 'https://www.buymeacoffee.com/clusterzx', badge: '/support/buymeacoffee.svg' },
  { name: 'Ko-fi', href: 'https://ko-fi.com/clusterzx', badge: '/support/kofi.svg' },
] as const;

const SNOOZE_KEY = 'pai-support-snoozed-until';
const SNOOZE_DAYS = 7;
/** A moment after the dashboard opened – not in the middle of the first click. */
const DELAY_MS = 2500;
const RETRY_MS = 5000;

/** Until when the reminder is hidden. Without storage it is never shown on its own (it could not be hidden again). */
function snoozedUntil(): number {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY)) || 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function snooze(): void {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * 86_400_000));
  } catch {
    // storage blocked – nothing to remember
  }
}

/**
 * The support dialog: opens on its own on the dashboard (`active`) unless it was closed in the
 * last 7 days, and on request (menu).
 */
export function useSupportReminder(active: boolean) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!active || snoozedUntil() > Date.now()) return;
    let timer = setTimeout(function attempt() {
      // Never on top of another dialog or menu – try again a bit later.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        timer = setTimeout(attempt, RETRY_MS);
        return;
      }
      setOpen(true);
    }, DELAY_MS);
    return () => clearTimeout(timer);
  }, [active]);
  const close = useCallback(() => {
    snooze();
    setOpen(false);
  }, []);
  const show = useCallback(() => setOpen(true), []);
  return { open, show, close };
}

export function SupportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Enjoying Paperless-AI?"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Maybe later
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="flex items-start gap-3">
          <IconChip tone="danger">
            <Heart className="fill-current" />
          </IconChip>
          <p className="text-sm text-muted">
            Paperless-AI is free and open source and is developed in my spare time. If it saves you time and keeps your archive tidy, please consider supporting the project –
            every contribution helps to keep it going.
          </p>
        </div>
        <ul className="flex flex-wrap items-center gap-2.5" aria-label="Ways to support the project">
          {SUPPORT_LINKS.map((l) => (
            <li key={l.name}>
              <a href={l.href} target="_blank" rel="noopener noreferrer" onClick={onClose} className="block rounded transition hover:-translate-y-0.5 hover:brightness-110">
                <img src={l.badge} alt={`Support on ${l.name}`} className="h-7" />
              </a>
            </li>
          ))}
        </ul>
        <p className="text-xs text-faint">“Maybe later” hides this for {SNOOZE_DAYS} days. You can find it again in the account menu.</p>
      </div>
    </Modal>
  );
}
