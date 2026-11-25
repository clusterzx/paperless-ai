/**
 * Models their provider shuts down, with the date and the provider's recommended replacement
 * (OpenAI: developers.openai.com/api/docs/deprecations, as of 2026-11-25). Settings and the log
 * warn about a configured one; nothing is changed without the user.
 */
export const RETIRING_MODELS: Readonly<Record<string, { date: string; replacement: string }>> = {
  'o4-mini': { date: '2026-10-23', replacement: 'gpt-5.6-terra' },
  'gpt-5': { date: '2026-12-11', replacement: 'gpt-6.1-sol' },
  'gpt-5-mini': { date: '2026-12-11', replacement: 'gpt-6.1-terra' },
  'gpt-5-nano': { date: '2026-12-11', replacement: 'gpt-6-luna' },
  'gpt-5-pro': { date: '2026-12-11', replacement: 'gpt-6.1-sol' },
  o3: { date: '2026-12-11', replacement: 'gpt-6.1-sol' },
  'o3-pro': { date: '2026-12-11', replacement: 'gpt-6.1-sol' },
  'gpt-4o': { date: '2027-01-14', replacement: 'gpt-6-luna' },
  'gpt-4o-mini': { date: '2027-01-14', replacement: 'gpt-6-luna' },
  'gpt-4.1': { date: '2027-01-14', replacement: 'gpt-6-luna' },
  'gpt-4.1-mini': { date: '2027-01-14', replacement: 'gpt-6-luna' },
  'gpt-5.1': { date: '2027-04-01', replacement: 'gpt-6-sol' },
  'gpt-5.4-nano': { date: '2027-04-01', replacement: 'gpt-6-luna' },
};

export interface ModelRetirement {
  model: string;
  /** YYYY-MM-DD */
  date: string;
  replacement: string;
  /** The date has passed: requests fail. */
  retired: boolean;
}

/**
 * Whether a model is shut down by its provider – also as a dated snapshot ("gpt-5-mini-2025-08-07")
 * or behind a router ("openai/gpt-5-mini" on OpenRouter).
 */
export function retirementOf(model: string, today: string = new Date().toISOString().slice(0, 10)): ModelRetirement | null {
  const id = model
    .trim()
    .toLowerCase()
    .replace(/^openai\//, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const entry = RETIRING_MODELS[id];
  return entry ? { model: id, ...entry, retired: entry.date <= today } : null;
}
