/**
 * Lenient normalisation of the JSON returned by the model into a
 * DocumentSuggestion. Accepts the various shapes models (and older prompts)
 * produce, e.g. custom_fields as an index-keyed object.
 */
import type { DocumentSuggestion } from '../../shared/api.js';
import { normalizeDate } from './dates.js';

const EMPTY = /^(|null|none|unknown|unbekannt|n\/a|na|-|nicht angegeben|not specified|undefined)$/i;

function cleanString(v: unknown, max = 256): string | null {
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (EMPTY.test(s)) return null;
  return s.slice(0, max);
}

function cleanTags(v: unknown): string[] {
  let list: unknown[] = [];
  if (Array.isArray(v)) list = v;
  else if (typeof v === 'string') list = v.split(/[,;]/);
  const out = new Map<string, string>();
  for (const item of list) {
    const name = cleanString(typeof item === 'object' && item ? (item as { name?: unknown }).name : item, 128)?.replace(/^#/, '');
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), name);
  }
  return [...out.values()].slice(0, 25);
}

function cleanCustomFields(v: unknown): { field_name: string; value: string }[] {
  const entries: { field_name: unknown; value: unknown }[] = [];
  if (Array.isArray(v)) {
    for (const item of v) if (item && typeof item === 'object') entries.push(item as { field_name: unknown; value: unknown });
  } else if (v && typeof v === 'object') {
    for (const [key, item] of Object.entries(v)) {
      if (item && typeof item === 'object' && 'field_name' in item) entries.push(item as { field_name: unknown; value: unknown });
      else entries.push({ field_name: key, value: item });
    }
  }
  const out: { field_name: string; value: string }[] = [];
  for (const e of entries) {
    const name = cleanString(e.field_name ?? (e as { name?: unknown }).name, 128);
    const raw = typeof e.value === 'boolean' ? String(e.value) : e.value;
    const value = cleanString(raw, 1000);
    if (!name || !value || /fill in the value/i.test(value)) continue;
    if (!out.some((o) => o.field_name.toLowerCase() === name.toLowerCase())) out.push({ field_name: name, value });
  }
  return out;
}

export function normalizeSuggestion(raw: Record<string, unknown>): DocumentSuggestion {
  // Some models nest the result, e.g. {"document": {...}} or {"result": {...}}.
  const inner = ['document', 'result', 'data', 'analysis'].map((k) => raw[k]).find((v) => v && typeof v === 'object' && !Array.isArray(v));
  const r = (inner && !('title' in raw) && !('tags' in raw) ? inner : raw) as Record<string, unknown>;
  const language = cleanString(r.language, 16);
  return {
    title: cleanString(r.title, 512),
    correspondent: cleanString(r.correspondent, 128),
    tags: cleanTags(r.tags),
    document_type: cleanString(r.document_type ?? r.documentType ?? r.type, 128),
    document_date: normalizeDate(r.document_date ?? r.documentDate ?? r.date),
    language: language && language.toLowerCase() !== 'und' ? language.toLowerCase() : null,
    custom_fields: cleanCustomFields(r.custom_fields ?? r.customFields),
  };
}
