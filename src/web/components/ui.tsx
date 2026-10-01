import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, Loader2, Lock, X, XCircle } from 'lucide-react';
import { cn } from '../lib/format';

// ------------------------------------------------------------------ buttons

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-strong shadow-card border border-transparent dark:text-[#04140e]',
  secondary: 'bg-surface text-fg border border-border hover:bg-surface-2 shadow-card',
  ghost: 'text-muted hover:text-fg hover:bg-surface-2 border border-transparent',
  danger: 'bg-danger text-white hover:opacity-90 border border-transparent shadow-card dark:text-[#1f0707]',
  subtle: 'bg-accent-soft text-accent-text hover:brightness-95 border border-transparent',
};

/** Button styles – also for links that look like buttons (a <button> must not be nested in an <a>). */
export function buttonClass({ variant = 'secondary', size = 'md', className }: { variant?: Variant; size?: 'sm' | 'md'; className?: string } = {}): string {
  return cn(
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition select-none disabled:cursor-not-allowed disabled:opacity-55',
    size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
    variants[variant],
    className,
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} className={buttonClass({ variant, size, className })} {...rest}>
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

/** External link styled as a button. */
export function LinkButton({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: 'sm' | 'md'; icon?: ReactNode }) {
  return (
    <a target="_blank" rel="noreferrer" className={buttonClass({ variant, size, className })} {...rest}>
      {icon}
      {children}
    </a>
  );
}

export function IconButton({ label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn('inline-flex size-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-fg', className)}
      {...rest}
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-muted', className)} />;
}

// ------------------------------------------------------------------ layout primitives

export function Card({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  icon,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  icon?: ReactNode;
}) {
  return (
    <section className={cn('rounded-xl border border-border bg-surface shadow-card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-border px-5 py-3.5">
          <div className="flex min-w-0 items-start gap-2.5">
            {icon && <span className="mt-0.5 text-accent">{icon}</span>}
            <div className="min-w-0">
              {title && <h2 className="text-[0.95rem] font-semibold text-fg">{title}</h2>}
              {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
            </div>
          </div>
          {/* Actions wrap below the title on narrow screens instead of overflowing. */}
          {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn('p-5', bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

type Tone = 'neutral' | 'accent' | 'danger' | 'warn' | 'info';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted border-border',
  accent: 'bg-accent-soft text-accent-text border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  info: 'bg-info-soft text-info border-transparent',
};

export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex max-w-full items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-xs font-medium', tones[tone], className)}>
      {children}
    </span>
  );
}

export function Alert({ tone = 'info', title, children, className, action }: { tone?: Exclude<Tone, 'neutral'>; title?: ReactNode; children?: ReactNode; className?: string; action?: ReactNode }) {
  const Icon = tone === 'danger' ? XCircle : tone === 'warn' ? AlertTriangle : tone === 'accent' ? CheckCircle2 : Info;
  return (
    <div className={cn('flex gap-3 rounded-lg px-3.5 py-3 text-sm', tones[tone], className)} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 break-words text-fg/90">
        {title && <div className="font-medium text-fg">{title}</div>}
        {children && <div className={cn(title && 'mt-0.5', 'text-[0.83rem] leading-relaxed')}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-surface-2 text-muted">{icon}</div>}
      <div className="font-medium text-fg">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-surface-3', className)} />;
}

export function Stat({ label, value, hint, icon, onClick }: { label: ReactNode; value: ReactNode; hint?: ReactNode; icon?: ReactNode; onClick?: () => void }) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      className={cn(
        'flex min-w-0 flex-col rounded-xl border border-border bg-surface p-4 text-left shadow-card',
        onClick && 'transition hover:border-border-strong hover:bg-surface-2',
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs font-medium text-muted">
        <span className="truncate">{label}</span>
        {icon && <span className="text-faint">{icon}</span>}
      </div>
      <div className="mt-2 truncate text-2xl font-semibold tracking-tight text-fg tabular-nums">{value}</div>
      {hint && <div className="mt-1 truncate text-xs text-muted">{hint}</div>}
    </Comp>
  );
}

// ------------------------------------------------------------------ form controls

/** Lets inputs inside a Field pick up the id its <label> points to (accessible names). */
const FieldIdContext = createContext<string | undefined>(undefined);

export function Field({
  label,
  hint,
  error,
  locked,
  children,
  className,
  htmlFor,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  locked?: string;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  return (
    <div className={className}>
      {label && (
        <label className="label flex items-center gap-1.5" htmlFor={id}>
          {label}
          {locked && (
            <span title={`Set by the environment variable ${locked}`} className="inline-flex items-center gap-1 text-xs font-normal text-warn">
              <Lock className="size-3" /> {locked}
            </span>
          )}
        </label>
      )}
      <FieldIdContext.Provider value={id}>{children}</FieldIdContext.Provider>
      {error ? <p className="mt-1.5 text-xs text-danger">{error}</p> : hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

/** The id the surrounding Field's label points to – unless the control names itself (e.g. a preset picker next to the field's input). */
function useFieldId(id: string | undefined, ariaLabel: string | undefined): string | undefined {
  const fieldId = useContext(FieldIdContext);
  return id ?? (ariaLabel ? undefined : fieldId);
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, id, ...rest }, ref) {
  const fieldId = useFieldId(id, rest['aria-label']);
  return <input ref={ref} id={fieldId} className={cn('input', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, id, ...rest }, ref) {
  const fieldId = useFieldId(id, rest['aria-label']);
  return <textarea ref={ref} id={fieldId} className={cn('input', className)} {...rest} />;
});

/** Number input that keeps the typed text while editing – an emptied field does not turn into 0. */
export function NumberInput({
  value,
  onChange,
  onBlur,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  const [shown, setShown] = useState(value);
  // Follow changes from outside (discard, save) unless they are what is being typed.
  if (!Object.is(value, shown)) {
    setShown(value);
    if (text.trim() === '' || Number(text) !== value) setText(String(value));
  }
  return (
    <Input
      type="number"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(e.target.valueAsNumber)) onChange(e.target.valueAsNumber);
      }}
      onBlur={(e) => {
        // Nothing (valid) entered → show the value that is actually kept.
        if (text.trim() === '' || !Number.isFinite(Number(text))) setText(String(value));
        onBlur?.(e);
      }}
      {...rest}
    />
  );
}

export function Select({ className, children, id, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  const fieldId = useFieldId(id, rest['aria-label']);
  return (
    <select
      id={fieldId}
      className={cn('input appearance-none bg-[length:16px] bg-[right_0.6rem_center] bg-no-repeat pr-8', className)}
      style={{ backgroundImage: CHEVRON }}
      {...rest}
    >
      {children}
    </select>
  );
}
const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238a93a3' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`;

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  locked,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  locked?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex items-start justify-between gap-4', (disabled || locked) && 'opacity-70')}>
      {(label || description) && (
        <label htmlFor={id} className="min-w-0 cursor-pointer">
          {label && (
            <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
              {label}
              {locked && (
                <span title={`Set by the environment variable ${locked}`} className="inline-flex items-center gap-1 text-xs font-normal text-warn">
                  <Lock className="size-3" /> {locked}
                </span>
              )}
            </span>
          )}
          {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
        </label>
      )}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled || Boolean(locked)}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed',
          checked ? 'bg-accent' : 'bg-border-strong',
        )}
      >
        <span className={cn('inline-block size-4 rounded-full bg-white shadow transition', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
    </div>
  );
}

/**
 * Arrow-key navigation for a group of options where only the selected one is tabbable (tabs, radio groups):
 * moves the selection and the focus. Attach to the group element; `vertical` also handles ArrowUp/ArrowDown.
 */
export function rovingKeyDown<T>(e: ReactKeyboardEvent<HTMLElement>, values: T[], current: T, select: (v: T) => void, vertical = false) {
  const steps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ...(vertical ? { ArrowDown: 1, ArrowUp: -1 } : {}) };
  const i = values.indexOf(current);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? values.length - 1 : e.key in steps ? (i + steps[e.key] + values.length) % values.length : null;
  if (next === null || !values.length) return;
  e.preventDefault();
  select(values[next]);
  e.currentTarget.querySelectorAll<HTMLElement>('button')[next]?.focus();
}

/** Single choice between a few options (radio group). */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; label?: string }) {
  return (
    <div
      className="inline-flex rounded-lg border border-border bg-surface-2 p-0.5"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => rovingKeyDown(e, options.map((o) => o.value), value, onChange, true)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md px-3 py-1 text-xs font-medium transition',
            value === o.value ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Chips input for lists of names (tags). */
export function TagInput({
  value,
  onChange,
  suggestions = [],
  placeholder = 'Add…',
  disabled,
  tone = 'neutral',
}: {
  value: string[];
  onChange: (v: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  disabled?: boolean;
  tone?: Tone;
}) {
  const [text, setText] = useState('');
  const listId = useId();
  const fieldId = useContext(FieldIdContext);
  const add = (raw: string) => {
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const next = [...value];
    for (const p of parts) if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(next);
    setText('');
  };
  return (
    <div className={cn('input flex min-h-[2.5rem] flex-wrap items-center gap-1.5 py-1.5', disabled && 'opacity-60')}>
      {value.map((t) => (
        <Badge key={t} tone={tone} className="gap-1 py-1 pr-1">
          <span className="truncate">{t}</span>
          {!disabled && (
            <button type="button" aria-label={`Remove ${t}`} className="rounded p-0.5 hover:bg-black/10" onClick={() => onChange(value.filter((v) => v !== t))}>
              <X className="size-3" />
            </button>
          )}
        </Badge>
      ))}
      <input
        id={fieldId}
        list={suggestions.length ? listId : undefined}
        className="min-w-[8rem] flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        value={text}
        disabled={disabled}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(',')) add(v);
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim()) {
            e.preventDefault();
            add(text);
          } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => text.trim() && add(text)}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.slice(0, 500).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}

/** Ids that connect a tab and its panel (render the panel with `tabPanelProps`). */
const tabIds = (id: string, tab: string) => ({ tab: `${id}-tab-${tab}`, panel: `${id}-panel-${tab}` });

export function tabPanelProps(id: string, tab: string) {
  return { role: 'tabpanel', id: tabIds(id, tab).panel, 'aria-labelledby': tabIds(id, tab).tab } as const;
}

export function Tabs<T extends string>({ id, value, onChange, tabs }: { id: string; value: T; onChange: (v: T) => void; tabs: { id: T; label: ReactNode; icon?: ReactNode }[] }) {
  return (
    <div
      className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1"
      role="tablist"
      onKeyDown={(e) => rovingKeyDown(e, tabs.map((t) => t.id), value, onChange)}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          id={tabIds(id, t.id).tab}
          role="tab"
          aria-selected={value === t.id}
          // Only the selected tab's panel is rendered.
          aria-controls={value === t.id ? tabIds(id, t.id).panel : undefined}
          tabIndex={value === t.id ? 0 : -1}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            '-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition',
            value === t.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
          )}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-muted">
      <span className="tabular-nums">
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <span className="px-2 tabular-nums">
          {page} / {pages}
        </span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ modal & confirm

/** Open dialogs, innermost last – only the topmost one handles Escape and keeps Tab inside. */
const dialogStack: object[] = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Dialog behaviour for modals and drawers: focus moves into the dialog when it opens (unless a child
 * already took it with autoFocus), Tab cycles inside it, Escape closes it and focus returns to the opener.
 */
export function useDialog(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  // Callers pass inline callbacks – a ref keeps the effect from re-running (and stealing focus) on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Read while rendering: by the time effects run, a child's autoFocus has already moved the focus.
  const opener = useMemo(() => (open ? (document.activeElement as HTMLElement | null) : null), [open]);
  useEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const token = {};
    dialogStack.push(token);
    if (!el.contains(document.activeElement)) el.focus();
    const onKey = (e: KeyboardEvent) => {
      if (dialogStack.at(-1) !== token) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === 'Tab') {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.getClientRects().length > 0);
        const [first, last] = [items[0], items[items.length - 1]];
        const active = document.activeElement;
        const outside = !el.contains(active);
        if (!items.length) {
          e.preventDefault();
          el.focus();
        } else if (e.shiftKey ? outside || active === el || active === first : outside || active === last) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      dialogStack.splice(dialogStack.indexOf(token), 1);
      // Only when the dialog really closed (not when StrictMode re-runs the effect).
      if (!el.isConnected) opener?.focus?.();
    };
  }, [open, ref, opener]);
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(ref, open, onClose);
  if (!open) return null;
  const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cn('animate-in relative flex max-h-[90vh] w-full flex-col rounded-t-2xl border border-border bg-surface shadow-pop outline-none sm:rounded-2xl', width)}
      >
        {title && (
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
            <h3 id={titleId} className="font-semibold text-fg">{title}</h3>
            <IconButton label="Close" onClick={onClose}>
              <X className="size-4" />
            </IconButton>
          </div>
        )}
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={Boolean(state)}
        onClose={() => close(false)}
        title={state?.title}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
              {state?.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        <div className="text-sm text-muted">{state?.message}</div>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmContext);

// ------------------------------------------------------------------ toasts

interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info';
  message: ReactNode;
}

const ToastContext = createContext<{ show: (tone: Toast['tone'], message: ReactNode) => void }>({ show: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const show = useCallback((tone: Toast['tone'], message: ReactNode) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Top right: the bottom edge belongs to the chat input and the settings save bar. */}
      {createPortal(
        <div className="pointer-events-none fixed top-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
          {toasts.map((t) => (
            <div
              key={t.id}
              className="animate-in pointer-events-auto flex items-start gap-2.5 rounded-xl border border-border bg-surface px-3.5 py-3 text-sm shadow-pop"
            >
              {t.tone === 'success' ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-accent" />
              ) : t.tone === 'error' ? (
                <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
              ) : (
                <Info className="mt-0.5 size-4 shrink-0 text-info" />
              )}
              <div className="min-w-0 flex-1 break-words text-fg">{t.message}</div>
              <button className="text-faint hover:text-fg" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Dismiss">
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const { show } = useContext(ToastContext);
  return useMemo(
    () => ({
      success: (m: ReactNode) => show('success', m),
      error: (m: ReactNode) => show('error', m),
      info: (m: ReactNode) => show('info', m),
    }),
    [show],
  );
}
