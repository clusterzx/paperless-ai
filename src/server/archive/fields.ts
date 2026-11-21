/**
 * Custom field values: the API representation (the same as Paperless-ngx uses) ↔ typed columns
 * (value_text / value_num / value_date / value_json), so that range filters and sorting use indexes.
 */
import { ArchiveError, type CustomFieldType } from '../backend/types.js';

export interface FieldColumns {
  value_text: string | null;
  value_num: number | null;
  value_date: string | null;
  value_json: string | null;
}

export interface SelectOption {
  id: string;
  label: string;
}

const EMPTY: FieldColumns = { value_text: null, value_num: null, value_date: null, value_json: null };

function invalid(name: string, value: unknown): ArchiveError {
  return new ArchiveError(`"${String(value).slice(0, 80)}" is not a valid value for the custom field "${name}"`, 400, 'invalid_custom_field');
}

/** API value → columns; null/undefined = no value. Throws for values that do not fit the type. */
export function toColumns(field: { name: string; data_type: string; options?: SelectOption[] }, value: unknown): FieldColumns | null {
  if (value === null || value === undefined || value === '') return null;
  const t = field.data_type as CustomFieldType;
  switch (t) {
    case 'string':
    case 'longtext':
    case 'url': {
      if (typeof value !== 'string' && typeof value !== 'number') throw invalid(field.name, value);
      const s = String(value);
      if (t === 'string' && s.length > 1000) throw invalid(field.name, value);
      if (t === 'url' && !/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(s)) throw invalid(field.name, value);
      return { ...EMPTY, value_text: s };
    }
    case 'date': {
      const s = String(value).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw invalid(field.name, value);
      return { ...EMPTY, value_date: s };
    }
    case 'boolean':
      if (typeof value === 'boolean') return { ...EMPTY, value_num: value ? 1 : 0 };
      if (value === 'true' || value === 'false') return { ...EMPTY, value_num: value === 'true' ? 1 : 0 };
      throw invalid(field.name, value);
    case 'integer': {
      const n = Number(value);
      if (!Number.isInteger(n)) throw invalid(field.name, value);
      return { ...EMPTY, value_num: n };
    }
    case 'float': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw invalid(field.name, value);
      return { ...EMPTY, value_num: n };
    }
    case 'monetary': {
      // "EUR12.50", "12.50" or a number
      const m = /^([A-Z]{3})?(-?\d+(?:\.\d{1,2})?)$/.exec(String(value).trim());
      if (!m) throw invalid(field.name, value);
      return { ...EMPTY, value_num: Number(m[2]), value_json: m[1] ? JSON.stringify({ currency: m[1] }) : null };
    }
    case 'select': {
      const options = field.options ?? [];
      const v = String(value);
      const opt = options.find((o) => o.id === v) ?? options.find((o) => o.label.toLowerCase() === v.toLowerCase());
      if (!opt) throw invalid(field.name, value);
      return { ...EMPTY, value_text: opt.id };
    }
    case 'documentlink': {
      const ids = (Array.isArray(value) ? value : [value]).map(Number);
      if (ids.some((x) => !Number.isInteger(x) || x <= 0)) throw invalid(field.name, value);
      return { ...EMPTY, value_json: JSON.stringify([...new Set(ids)]) };
    }
    default:
      return { ...EMPTY, value_text: String(value) };
  }
}

/** Columns → API value. */
export function fromColumns(dataType: string, c: FieldColumns): unknown {
  switch (dataType as CustomFieldType) {
    case 'date':
      return c.value_date;
    case 'boolean':
      return c.value_num === null ? null : c.value_num !== 0;
    case 'integer':
    case 'float':
      return c.value_num;
    case 'monetary': {
      if (c.value_num === null) return null;
      const cur = c.value_json ? ((JSON.parse(c.value_json) as { currency?: string }).currency ?? '') : '';
      return `${cur}${c.value_num.toFixed(2)}`;
    }
    case 'documentlink':
      return c.value_json ? (JSON.parse(c.value_json) as number[]) : [];
    default:
      return c.value_text;
  }
}

/** Display text of a value (for the change log and the full text metadata line). */
export function displayValue(dataType: string, value: unknown, options: SelectOption[] = []): string {
  if (value === null || value === undefined) return '';
  if (dataType === 'select') return options.find((o) => o.id === value)?.label ?? String(value);
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

export function parseOptions(extra: string | null | undefined): SelectOption[] {
  try {
    const e = JSON.parse(extra || '{}') as { select_options?: SelectOption[] };
    return Array.isArray(e.select_options) ? e.select_options : [];
  } catch {
    return [];
  }
}
