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
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary:
    'border border-transparent bg-accent bg-linear-to-b from-white/14 to-transparent text-on-accent shadow-[var(--highlight),0_1px_2px_rgb(0_0_0/0.18),0_4px_12px_-4px_color-mix(in_srgb,var(--accent)_55%,transparent)] hover:bg-accent-strong active:translate-y-px',
  secondary: 'border border-border bg-surface text-fg shadow-xs hover:border-border-strong hover:bg-surface-2 active:translate-y-px',
  ghost: 'border border-transparent text-muted hover:bg-surface-3/70 hover:text-fg',
  danger:
    'border border-transparent bg-danger bg-linear-to-b from-white/12 to-transparent text-white shadow-[var(--highlight),0_1px_2px_rgb(0_0_0/0.18)] hover:brightness-110 active:translate-y-px dark:text-[#2a0509]',
  subtle: 'border border-transparent bg-accent-soft text-accent-text hover:bg-accent/15',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 rounded-lg px-3 text-[13px]',
  md: 'h-9 rounded-[10px] px-3.5 text-sm',
  lg: 'h-11 rounded-xl px-5 text-[15px]',
};

/** Button styles – also for links that look like buttons (a <button> must not be nested in an <a>). */
export function buttonClass({ variant = 'secondary', size = 'md', className }: { variant?: Variant; size?: Size; className?: string } = {}): string {
  return cn(
    'inline-flex shrink-0 items-center justify-center gap-2 font-medium whitespace-nowrap transition duration-150 select-none disabled:pointer-events-none disabled:opacity-50',
    sizes[size],
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
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: Size; icon?: ReactNode }) {
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
      className={cn('inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface-3/70 hover:text-fg', className)}
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
    <section className={cn('rounded-2xl border border-border bg-surface shadow-card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-5 pt-4">
          <div className="flex min-w-0 items-center gap-3">
            {icon && <IconChip>{icon}</IconChip>}
            <div className="min-w-0">
              {title && <h2 className="text-[15px] leading-tight font-semibold text-fg">{title}</h2>}
              {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
            </div>
          </div>
          {/* Actions wrap below the title on narrow screens instead of overflowing. */}
          {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {/* bodyClassName replaces the default padding (class order cannot override it reliably). */}
      <div className={bodyClassName ?? cn('p-5', (title || actions) && 'pt-4')}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 text-xs font-medium tracking-wide text-accent-text">{eyebrow}</div>}
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.025em] text-fg sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1.5 max-w-3xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Small rounded square holding an icon (card headers, list items). */
export function IconChip({ children, tone = 'neutral', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] [&_svg]:size-4',
        tone === 'neutral' ? 'bg-surface-2 text-muted ring-1 ring-border' : chipTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Round initials avatar with an accent gradient. */
export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-accent to-accent-2 text-[12px] font-semibold text-white shadow-[var(--highlight)]',
        className,
      )}
    >
      {initials || '?'}
    </span>
  );
}

type Tone = 'neutral' | 'accent' | 'danger' | 'warn' | 'info' | 'success';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted border-border',
  accent: 'bg-accent-soft text-accent-text border-accent/15',
  danger: 'bg-danger-soft text-danger border-danger/15',
  warn: 'bg-warn-soft text-warn border-warn/15',
  info: 'bg-info-soft text-info border-info/15',
  success: 'bg-success-soft text-success border-success/15',
};
const chipTones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  accent: 'bg-accent-soft text-accent-text',
  danger: 'bg-danger-soft text-danger',
  warn: 'bg-warn-soft text-warn',
  info: 'bg-info-soft text-info',
  success: 'bg-success-soft text-success',
};

export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn('inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[11.5px] leading-[1.35] font-medium', tones[tone], className)}
    >
      {children}
    </span>
  );
}

export function Alert({ tone = 'info', title, children, className, action }: { tone?: Exclude<Tone, 'neutral'>; title?: ReactNode; children?: ReactNode; className?: string; action?: ReactNode }) {
  const Icon = tone === 'danger' ? XCircle : tone === 'warn' ? AlertTriangle : tone === 'accent' ? CheckCircle2 : Info;
  return (
    <div className={cn('flex gap-3 rounded-xl border px-4 py-3 text-sm', tones[tone], className)} role={tone === 'danger' ? 'alert' : 'status'}>
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
      {icon && (
        <div className="relative mb-4 flex size-12 items-center justify-center rounded-2xl bg-linear-to-b from-surface to-surface-2 text-accent-text shadow-card ring-1 ring-border [&_svg]:size-5">
          {icon}
        </div>
      )}
      <div className="text-[15px] font-semibold text-fg">{title}</div>
      {children && <div className="mt-1.5 max-w-md text-sm leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-surface-3/80', className)} />;
}

export function Stat({
  label,
  value,
  hint,
  icon,
  onClick,
  children,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
  /** Extra content below the value, e.g. a sparkline. */
  children?: ReactNode;
  className?: string;
}) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      className={cn(
        'group flex min-w-0 flex-col rounded-2xl border border-border bg-surface p-5 text-left shadow-card',
        onClick && 'transition hover:-translate-y-0.5 hover:border-border-strong hover:shadow-pop',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[13px] font-medium text-muted">{label}</span>
        {icon && <IconChip className="size-7 rounded-lg [&_svg]:size-3.5">{icon}</IconChip>}
      </div>
      <div className="mt-3 truncate text-[28px] leading-none font-semibold tracking-[-0.03em] text-fg tabular-nums">{value}</div>
      {hint && <div className="mt-2 truncate text-xs text-muted">{hint}</div>}
      {children}
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
const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238d8d9d' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m7 10 5 5 5-5'/%3E%3C/svg%3E")`;

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
          'relative mt-0.5 inline-flex h-[22px] w-10 shrink-0 items-center rounded-full shadow-[inset_0_1px_2px_rgb(0_0_0/0.12)] transition-colors duration-200 disabled:cursor-not-allowed',
          checked ? 'bg-accent' : 'bg-surface-3 ring-1 ring-border-strong ring-inset',
        )}
      >
        <span
          className={cn(
            'inline-block size-[18px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-transform duration-200',
            checked ? 'translate-x-[20px]' : 'translate-x-0.5',
          )}
        />
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
      className="inline-flex rounded-[10px] bg-surface-3/70 p-[3px]"
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
            'rounded-[8px] px-3 py-1 text-[13px] font-medium transition',
            value === o.value ? 'bg-surface text-fg shadow-xs ring-1 ring-border' : 'text-muted hover:text-fg',
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
    <div className={cn('input flex h-auto min-h-10 flex-wrap items-center gap-1.5 py-1.5 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15', disabled && 'opacity-60')}>
      {value.map((t) => (
        <Badge key={t} tone={tone} className="gap-1 py-1 pr-1">
          <span className="truncate">{t}</span>
          {!disabled && (
            <button type="button" aria-label={`Remove ${t}`} className="rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10" onClick={() => onChange(value.filter((v) => v !== t))}>
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

export function Tabs<T extends string>({
  id,
  value,
  onChange,
  tabs,
  vertical,
}: {
  id: string;
  value: T;
  onChange: (v: T) => void;
  tabs: { id: T; label: ReactNode; icon?: ReactNode }[];
  /** A vertical list on large screens (settings navigation). */
  vertical?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex max-w-full gap-1 overflow-x-auto',
        vertical ? 'rounded-xl bg-surface-3/60 p-1 lg:flex-col lg:overflow-visible lg:bg-transparent lg:p-0' : 'w-fit rounded-xl bg-surface-3/60 p-1',
      )}
      role="tablist"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      onKeyDown={(e) => rovingKeyDown(e, tabs.map((t) => t.id), value, onChange, vertical)}
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
            'flex items-center gap-2 rounded-[9px] px-3 py-1.5 text-[13px] font-medium whitespace-nowrap transition [&_svg]:size-4',
            vertical && 'lg:py-2 lg:text-sm',
            value === t.id
              ? cn('bg-surface text-fg shadow-xs ring-1 ring-border', vertical && 'lg:[&_svg]:text-accent')
              : cn('text-muted hover:text-fg', vertical && 'lg:hover:bg-surface-3/60'),
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
      <div className="animate-backdrop absolute inset-0 bg-[rgb(10_10_20/0.35)] backdrop-blur-[3px] dark:bg-black/60" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cn('animate-pop relative flex max-h-[90vh] w-full flex-col rounded-t-3xl border border-border bg-surface shadow-pop outline-none sm:rounded-3xl', width)}
      >
        {title && (
          <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-1">
            <h3 id={titleId} className="text-base font-semibold tracking-tight text-fg">
              {title}
            </h3>
            <IconButton label="Close" onClick={onClose} className="-mr-2">
              <X className="size-4" />
            </IconButton>
          </div>
        )}
        <div className="overflow-y-auto px-6 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 rounded-b-3xl border-t border-border bg-surface-2/70 px-6 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Panel sliding in from the right (secondary content such as filters). */
export function SlideOver({ open, onClose, title, description, children }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(ref, open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="animate-backdrop absolute inset-0 bg-[rgb(10_10_20/0.25)] backdrop-blur-[2px] dark:bg-black/50" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="animate-slide-in absolute inset-y-2 right-2 flex w-[min(25rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-3xl border border-border bg-surface shadow-pop outline-none"
      >
        <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-3">
          <div>
            <h3 id={titleId} className="text-base font-semibold tracking-tight text-fg">
              {title}
            </h3>
            {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
          </div>
          <IconButton label="Close" onClick={onClose} className="-mr-2">
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
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
              className="animate-pop pointer-events-auto flex items-start gap-2.5 rounded-2xl border border-border bg-surface/95 px-4 py-3 text-sm shadow-pop backdrop-blur-md"
            >
              {t.tone === 'success' ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
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
