/**
 * The input of a custom field on the document page, by its type: an amount with its currency
 * (shown as "134,89" + EUR, stored as "EUR134.89"), a date, yes / no, a number, a choice.
 * Values stay in the form the API takes; the server converts them like AI values.
 */
import { useState } from 'react';
import { formatMonetaryValue, parseMonetary, parseNumber } from '@shared/numbers';
import type { CustomFieldMeta } from '../lib/metadata';
import { Input, Select, Textarea } from './ui';

const CURRENCIES = ['EUR', 'USD', 'CHF', 'GBP', 'PLN', 'CZK', 'SEK', 'NOK', 'DKK', 'HUF', 'JPY', 'CAD', 'AUD'];

/** The options of a select field (old Paperless-ngx: plain strings, the value is the index). */
export function selectOptions(field: CustomFieldMeta): { value: string; label: string }[] {
  return (field.extra_data?.select_options ?? []).map((o, i) => (typeof o === 'string' ? { value: String(i), label: o } : { value: o.id, label: o.label }));
}

/** The text a stored value is edited as (a select field: the label of the option). */
export function fieldDraftValue(field: CustomFieldMeta | undefined, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (field?.data_type === 'select') return selectOptions(field).find((o) => o.value === String(value))?.label ?? String(value);
  return String(value);
}

/** An amount in the notation of the browser's language ("134,89" or "134.89"). */
export function formatAmount(amount: number): string {
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
}

/** A monetary value for reading: "134,89 €" (a value that cannot be read stays as it is). */
export function formatMonetary(value: string, fallbackCurrency?: string | null): string {
  const { currency, amount } = parseMonetary(value);
  if (amount === null) return value;
  const cur = currency ?? fallbackCurrency;
  try {
    return cur ? new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(amount) : formatAmount(amount);
  } catch {
    return `${formatAmount(amount)} ${cur}`;
  }
}

function MonetaryInput({ field, value, onChange, disabled }: { field: CustomFieldMeta; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const parsed = parseMonetary(value);
  const [chosen, setChosen] = useState(parsed.currency ?? field.extra_data?.default_currency ?? 'EUR');
  const currency = parsed.currency ?? chosen;
  const [text, setText] = useState(parsed.amount === null ? '' : formatAmount(parsed.amount));
  const [seen, setSeen] = useState(value);
  // Follow changes from outside (discard, save) – but not what is being typed.
  if (seen !== value) {
    setSeen(value);
    const typed = parseNumber(text);
    if (typed !== parsed.amount) setText(parsed.amount === null ? '' : formatAmount(parsed.amount));
  }
  const emit = (t: string, cur: string) => {
    if (!t.trim()) return onChange('');
    const n = parseNumber(t);
    onChange(n === null ? t : formatMonetaryValue(cur, n));
  };
  return (
    <div className="flex gap-2">
      <Input
        inputMode="decimal"
        value={text}
        placeholder={formatAmount(0)}
        disabled={disabled}
        className="min-w-0 flex-1 text-right tabular-nums"
        onChange={(e) => {
          setText(e.target.value);
          emit(e.target.value, currency);
        }}
        // "134,8" → "134,80" once the field is left.
        onBlur={() => parsed.amount !== null && setText(formatAmount(parsed.amount))}
      />
      <Select
        aria-label={`Currency of ${field.name}`}
        value={currency}
        disabled={disabled}
        className="w-24 shrink-0"
        onChange={(e) => {
          setChosen(e.target.value);
          emit(text, e.target.value);
        }}
      >
        {[...new Set([currency, ...CURRENCIES])].map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </Select>
    </div>
  );
}

export function CustomFieldInput({ field, value, onChange, disabled }: { field: CustomFieldMeta | undefined; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  switch (field?.data_type) {
    case 'monetary':
      return <MonetaryInput field={field} value={value} onChange={onChange} disabled={disabled} />;
    case 'date':
      return <Input type="date" value={value.slice(0, 10)} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
    case 'boolean':
      return (
        <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">–</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </Select>
      );
    case 'integer':
      return <Input inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="tabular-nums" />;
    case 'float':
      return <Input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="tabular-nums" />;
    case 'select': {
      const options = selectOptions(field);
      return (
        <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">–</option>
          {value && !options.some((o) => o.label === value) && <option value={value}>{value}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.label}>
              {o.label}
            </option>
          ))}
        </Select>
      );
    }
    case 'url':
      return <Input type="url" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder="https://…" />;
    case 'longtext':
      return <Textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
    default:
      return <Input value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
  }
}
