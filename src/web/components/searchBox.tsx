/**
 * Search box of the document list with the search syntax (src/shared/searchSyntax.ts): autocomplete
 * of keys and names (tag:, correspondent: …), a help panel, and what the server understood.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CircleHelp, Search } from 'lucide-react';
import type { SearchInterpretation } from '@shared/api';
import { SEARCH_KEYS, searchValue, tokenAt, type SearchKey } from '@shared/searchSyntax';
import { get } from '../lib/api';
import { cn } from '../lib/format';
import type { MetadataLookup } from '../lib/metadata';
import { IconButton, Input } from './ui';

interface Suggestion {
  label: string;
  hint?: string;
  insert: string;
}

const KEY_LABEL: Record<SearchKey, string> = {
  title: 'title',
  text: 'text',
  correspondent: 'correspondent',
  tag: 'tag',
  type: 'type',
  created: 'created',
  added: 'added',
  asn: 'ASN',
  id: 'id',
  library: 'library',
};

function dateSuggestions(prefix: string): Suggestion[] {
  const now = new Date();
  const y = now.getFullYear();
  const month = `${y}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return [
    { label: String(y), hint: 'this year', insert: `${prefix}${y} ` },
    { label: String(y - 1), hint: 'last year', insert: `${prefix}${y - 1} ` },
    { label: month, hint: 'this month', insert: `${prefix}${month} ` },
    { label: `>=${y}-01-01`, hint: 'from a day on', insert: `${prefix}>=${y}-01-01` },
    { label: `${y - 1}..${y}`, hint: 'a range', insert: `${prefix}${y - 1}..${y} ` },
  ];
}

export function DocumentSearchBox({
  value,
  onChange,
  meta,
  interpretation,
  libraries: withLibraries,
}: {
  value: string;
  onChange: (v: string) => void;
  meta: MetadataLookup;
  interpretation: SearchInterpretation[];
  /** The built-in archive: library: names are suggested. */
  libraries: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [cursor, setCursor] = useState(0);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [help, setHelp] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [libraryNames, setLibraryNames] = useState<string[] | null>(null);
  const token = useMemo(() => tokenAt(value, cursor), [value, cursor]);

  useEffect(() => {
    if (withLibraries && token?.key === 'library' && libraryNames === null) {
      get<{ name: string }[]>('/api/libraries')
        .then((l) => setLibraryNames(l.map((x) => x.name)))
        .catch(() => setLibraryNames([]));
    }
  }, [withLibraries, token?.key, libraryNames]);

  const suggestions = useMemo((): Suggestion[] => {
    if (!token) return [];
    const neg = token.negate ? '-' : '';
    const info = token.key ? SEARCH_KEYS.find((k) => k.key === token.key) : undefined;
    if (info && token.keyText) {
      const prefix = `${neg}${token.keyText}:`;
      if (info.key === 'created' || info.key === 'added') return token.value ? [] : dateSuggestions(prefix);
      if (!info.values) return [];
      const items =
        info.values === 'libraries'
          ? (libraryNames ?? []).map((name) => ({ name, document_count: 0 }))
          : info.values === 'tags'
            ? meta.tags
            : info.values === 'correspondents'
              ? meta.correspondents
              : meta.documentTypes;
      const want = token.value.toLowerCase();
      return [...items]
        .filter((i) => i.name.toLowerCase().includes(want) && i.name.toLowerCase() !== want)
        .sort(
          (a, b) =>
            Number(!a.name.toLowerCase().startsWith(want)) - Number(!b.name.toLowerCase().startsWith(want)) ||
            (b.document_count ?? 0) - (a.document_count ?? 0),
        )
        .slice(0, 8)
        .map((i) => ({
          label: i.name,
          hint: i.document_count ? `${i.document_count}` : undefined,
          insert: `${prefix}${searchValue(i.name)} `,
        }));
    }
    // A word that starts a key: offer the key.
    const word = token.value.toLowerCase();
    if (token.keyText || word.length < 2 || word.startsWith('"')) return [];
    return SEARCH_KEYS.filter((k) => (k.key !== 'library' || withLibraries) && (!token.negate || k.negatable))
      .map((k) => ({ k, alias: k.aliases.find((a) => a.startsWith(word) && a !== word) }))
      .filter((x): x is { k: (typeof SEARCH_KEYS)[number]; alias: string } => Boolean(x.alias))
      .map(({ k, alias }) => ({ label: `${alias}:`, hint: k.description, insert: `${neg}${alias}:` }));
  }, [token, meta, libraryNames, withLibraries]);

  useEffect(() => {
    setActive(0);
    setDismissed(false);
  }, [value]);

  const open = focused && !dismissed && suggestions.length > 0;

  const choose = (s: Suggestion) => {
    if (!token) return;
    const next = value.slice(0, token.start) + s.insert + value.slice(token.end);
    const pos = token.start + s.insert.length;
    onChange(next);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
      setCursor(pos);
    });
  };
  const insertExample = (example: string) => {
    const next = `${value.trim() ? `${value.trimEnd()} ` : ''}${example} `;
    onChange(next);
    setHelp(false);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.length, next.length);
      setCursor(next.length);
    });
  };

  return (
    <div className="relative min-w-[200px] flex-1">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
        <Input
          ref={ref}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setCursor(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (!open) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
            } else if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              choose(suggestions[active]);
            } else if (e.key === 'Escape') {
              setDismissed(true);
            }
          }}
          placeholder="Search… e.g. tag:steuer from:adac created:2024"
          className="pr-10 pl-9"
          aria-label="Search documents"
          role="combobox"
          aria-expanded={open}
          aria-controls="document-search-suggestions"
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
        />
        <IconButton
          label="Search help"
          onClick={() => setHelp((h) => !h)}
          className="absolute top-1/2 right-1 -translate-y-1/2"
          aria-expanded={help}
        >
          <CircleHelp className="size-4" />
        </IconButton>
      </div>

      {open && (
        <ul
          id="document-search-suggestions"
          role="listbox"
          className="absolute top-full right-0 left-0 z-30 mt-1 max-h-72 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-pop"
        >
          {suggestions.map((s, i) => (
            <li
              key={`${s.label}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(s);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                'flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-1.5 text-sm',
                i === active && 'bg-surface-2',
              )}
            >
              <span className="truncate font-medium">{s.label}</span>
              {s.hint && <span className="shrink-0 truncate text-xs text-muted">{s.hint}</span>}
            </li>
          ))}
        </ul>
      )}

      {help && (
        <div
          className="absolute top-full right-0 z-30 mt-1 w-[min(34rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-4 shadow-pop"
          role="dialog"
          aria-label="Search help"
        >
          <div className="mb-2 text-sm font-semibold">Search syntax</div>
          <p className="mb-3 text-xs text-muted">
            Words search title and text. Combine them with filters below; <code>-</code> leaves out (<code>-tag:erledigt</code>,{' '}
            <code>-werbung</code>), quotes keep words together. Parts of names are enough.
          </p>
          <ul className="space-y-1.5 text-sm">
            {SEARCH_KEYS.filter((k) => k.key !== 'library' || withLibraries).map((k) => (
              <li key={k.key} className="flex flex-wrap items-baseline gap-x-3">
                <button
                  type="button"
                  className="font-mono text-[13px] text-accent hover:underline"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertExample(k.example)}
                >
                  {k.example}
                </button>
                <span className="text-xs text-muted">{k.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {interpretation.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Search understood as">
          {interpretation.map((t, i) => (
            <span
              key={`${t.key}-${i}`}
              title={t.problem ?? t.matched.join(', ')}
              className={cn(
                'inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-xs ring-1',
                t.problem ? 'bg-warn/10 text-warn ring-warn/30' : 'bg-surface-2 text-muted ring-border',
              )}
            >
              {t.problem && <AlertTriangle className="size-3 shrink-0" />}
              <span className="font-medium">
                {t.negate ? 'not ' : ''}
                {KEY_LABEL[t.key]}:
              </span>
              <span className="truncate">
                {t.problem ??
                  (t.matched.length > 3 ? `${t.matched.slice(0, 3).join(', ')} +${t.matched.length - 3}` : t.matched.join(', '))}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
