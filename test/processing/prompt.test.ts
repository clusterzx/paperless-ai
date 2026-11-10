import { describe, expect, it } from 'vitest';
import { configSchema, type AppConfig } from '../../src/server/config/schema.js';
import { deepMerge } from '../../src/server/config/store.js';
import { estimateTokens } from '../../src/server/ai/tokens.js';
import {
  buildAnalysisPrompt,
  buildJsonSchema,
  buildOutputInstructions,
  buildSystemPrompt,
  enabledFields,
  type PromptContext,
} from '../../src/server/processing/prompt.js';

function config(patch: Record<string, unknown> = {}): AppConfig {
  return configSchema.parse(deepMerge({}, patch));
}

const ctx: PromptContext = {
  tags: ['Invoice', 'Insurance', 'Tax'],
  correspondents: ['ACME', 'City Utilities'],
  documentTypes: ['Invoice', 'Contract'],
  customFields: [],
};

type Schema = { properties: Record<string, Record<string, unknown>>; required: string[] };

describe('enabledFields / buildJsonSchema', () => {
  it('only includes enabled fields (plus language)', () => {
    const cfg = config({
      processing: { functions: { title: true, correspondent: false, tags: false, documentType: false, documentDate: true, customFields: true } },
    });
    const schema = buildJsonSchema(cfg.processing, ctx) as unknown as Schema;
    expect(Object.keys(schema.properties).sort()).toEqual(['document_date', 'language', 'title']);
    expect(schema.required.sort()).toEqual(['document_date', 'language', 'title']);
    // custom fields are enabled but none are configured
    expect(enabledFields(cfg.processing).customFields).toBe(false);
  });

  it('includes all fields by default without enums', () => {
    const schema = buildJsonSchema(config().processing, ctx) as unknown as Schema;
    expect(Object.keys(schema.properties).sort()).toEqual(['correspondent', 'document_date', 'document_type', 'language', 'tags', 'title']);
    expect(schema.properties.tags).toEqual({ type: 'array', items: { type: 'string' }, description: 'Thematic tags' });
    expect(schema.properties.correspondent.enum).toBeUndefined();
    expect(schema.properties.document_type.enum).toBeUndefined();
  });

  it('uses enums for restricted tags, correspondents and document types', () => {
    const cfg = config({ processing: { restrict: { tags: true, correspondents: true, documentTypes: true } } });
    const schema = buildJsonSchema(cfg.processing, ctx) as unknown as Schema;
    expect((schema.properties.tags.items as { enum: string[] }).enum).toEqual(ctx.tags);
    expect(schema.properties.correspondent.enum).toEqual([...ctx.correspondents, '']);
    expect(schema.properties.document_type.enum).toEqual([...ctx.documentTypes, '']);
  });

  it('skips enums for very long lists', () => {
    const many = Array.from({ length: 401 }, (_, i) => `tag ${i}`);
    const cfg = config({ processing: { restrict: { tags: true, correspondents: true } } });
    const schema = buildJsonSchema(cfg.processing, { ...ctx, tags: many, correspondents: many }) as unknown as Schema;
    expect(schema.properties.tags.items).toEqual({ type: 'string' });
    expect(schema.properties.correspondent.enum).toBeUndefined();
  });

  it('uses the prompt tags as enum (even when tagging is disabled)', () => {
    const cfg = config({ processing: { usePromptTags: true, promptTags: ['Red', 'Blue'], functions: { tags: false } } });
    const schema = buildJsonSchema(cfg.processing, ctx) as unknown as Schema;
    expect((schema.properties.tags.items as { enum: string[] }).enum).toEqual(['Red', 'Blue']);
  });

  it('describes configured custom fields', () => {
    const cfg = config({
      processing: { customFields: [{ name: 'Amount', type: 'monetary', currency: 'eur' }, { name: 'IBAN', type: 'string' }] },
    });
    const schema = buildJsonSchema(cfg.processing, ctx) as unknown as Schema;
    const cf = schema.properties.custom_fields as { items: { properties: { field_name: { enum: string[] } } } };
    expect(cf.items.properties.field_name.enum).toEqual(['Amount', 'IBAN']);
    expect(schema.required).not.toContain('custom_fields');
    const instructions = buildOutputInstructions(cfg.processing, ctx);
    expect(instructions).toContain('"Amount": amount as decimal number');
    expect(instructions).toContain('(currency EUR)');
    expect(instructions).toContain('"custom_fields"');
  });

  it('lists the options of select fields and explains long text fields', () => {
    const cfg = config({
      processing: { customFields: [{ name: 'Status', type: 'select' }, { name: 'Notes', type: 'longtext' }, { name: 'Ref', type: 'string' }] },
    });
    const instructions = buildOutputInstructions(cfg.processing, { ...ctx, selectOptions: { status: ['Open', 'Paid'] } });
    expect(instructions).toContain('"Status": exactly one of: "Open", "Paid"');
    expect(instructions).toContain('"Notes": text, may span several lines');
    expect(instructions).toContain('"Ref": short text (max. 128 characters)');
  });
});

describe('buildSystemPrompt', () => {
  it('replaces legacy placeholders', () => {
    const cfg = config({
      processing: {
        systemPrompt: 'Tags: %RESTRICTED_TAGS%\nFrom: %RESTRICTED_CORRESPONDENTS%\nTypes: %RESTRICTED_DOCUMENT_TYPES%\nFields: %CUSTOMFIELDS%',
        customFields: [{ name: 'Amount', type: 'float' }],
      },
    });
    const prompt = buildSystemPrompt(cfg.processing, ctx);
    expect(prompt).toContain('Tags: Invoice, Insurance, Tax');
    expect(prompt).toContain('From: ACME, City Utilities');
    expect(prompt).toContain('Types: Invoice, Contract');
    expect(prompt).toContain('Fields: Amount');
    expect(prompt).not.toContain('%');
  });

  it('uses the prompt-tags prompt and restricts tags', () => {
    const cfg = config({ processing: { usePromptTags: true, promptTags: ['Red', 'Blue'], systemPrompt: 'IGNORED SYSTEM PROMPT' } });
    const prompt = buildSystemPrompt(cfg.processing, ctx);
    expect(prompt).not.toContain('IGNORED SYSTEM PROMPT');
    expect(prompt).toContain('Available tags: Red, Blue');
    expect(prompt).toContain('ONLY use tags from this list: Red, Blue');
  });

  it('a custom prompt replaces the system prompt but keeps the output contract', () => {
    const prompt = buildSystemPrompt(config({ processing: { systemPrompt: 'DEFAULT' } }).processing, ctx, { customPrompt: 'Webhook prompt' });
    expect(prompt.startsWith('Webhook prompt')).toBe(true);
    expect(prompt).not.toContain('DEFAULT');
    expect(prompt).toContain('Return the result EXCLUSIVELY as one JSON object');
  });

  it('lists existing data only when enabled and not restricted', () => {
    const plain = buildSystemPrompt(config().processing, ctx);
    expect(plain).not.toContain('Existing tags');
    const existing = buildSystemPrompt(config({ processing: { useExistingData: true } }).processing, ctx);
    expect(existing).toContain('Existing tags (prefer these): Invoice, Insurance, Tax');
    expect(existing).toContain('Existing correspondents (prefer these): ACME, City Utilities');
    expect(existing).toContain('Existing document types (prefer these): Invoice, Contract');
    const restricted = buildSystemPrompt(config({ processing: { useExistingData: true, restrict: { tags: true, correspondents: true } } }).processing, ctx);
    expect(restricted).not.toContain('Existing tags');
    expect(restricted).not.toContain('Existing correspondents');
    expect(restricted).toContain('tags: ONLY use tags from this list: Invoice, Insurance, Tax');
    expect(restricted).toContain('correspondent: ONLY use one of: ACME, City Utilities');
  });

  it('adds external API data', () => {
    const prompt = buildSystemPrompt(config().processing, { ...ctx, externalData: { customers: ['Bob'] } });
    expect(prompt).toContain('Additional context from external API:');
    expect(prompt).toContain('"Bob"');
  });

  it('truncates very long tag lists', () => {
    const many = Array.from({ length: 3000 }, (_, i) => `some-long-tag-name-${i}`);
    const prompt = buildSystemPrompt(config({ processing: { useExistingData: true } }).processing, { ...ctx, tags: many });
    expect(prompt).toMatch(/… \(\+\d+ more\)/);
    expect(estimateTokens(prompt)).toBeLessThan(10_000);
  });
});

describe('buildAnalysisPrompt', () => {
  const content = Array.from({ length: 20_000 }, (_, i) => `word${i}`).join(' ');

  it('keeps short documents complete', () => {
    const built = buildAnalysisPrompt(config(), 'A short invoice from ACME.', ctx, { filename: 'scan.pdf', today: '2026-10-02' });
    expect(built.truncated).toBe(false);
    expect(built.messages).toHaveLength(2);
    expect(built.messages[0].role).toBe('system');
    expect(built.messages[1].content).toBe(
      "Today's date: 2026-10-02\nOriginal file name: scan.pdf\n\nDocument content:\n\"\"\"\nA short invoice from ACME.\n\"\"\"",
    );
    // the system prompt does not change from day to day (prompt caching)
    expect(built.messages[0].content).toBe(buildAnalysisPrompt(config(), 'Other text', ctx, { today: '2027-01-01' }).messages[0].content);
    expect(built.messages[0].content).toContain('not a due date');
    expect(built.schema).toEqual(buildJsonSchema(config().processing, ctx));
  });

  it('truncates content so that prompt and answer fit into the token limit', () => {
    for (const tokenLimit of [4000, 8000, 32_000]) {
      const cfg = config({ ai: { tokenLimit, responseTokens: 1000 } });
      const built = buildAnalysisPrompt(cfg, content, ctx);
      expect(built.truncated).toBe(true);
      const total = built.messages.reduce((s, m) => s + estimateTokens(m.content), 0);
      expect(total + cfg.ai.responseTokens).toBeLessThanOrEqual(tokenLimit);
      expect(built.promptTokens).toBe(total);
      // the budget is used reasonably (not truncated to almost nothing)
      expect(total).toBeGreaterThan(tokenLimit * 0.6);
    }
  });

  it('throws when the system prompt leaves no room for the document', () => {
    const cfg = config({ ai: { tokenLimit: 1024, responseTokens: 500 }, processing: { systemPrompt: 'x '.repeat(2000) } });
    expect(() => buildAnalysisPrompt(cfg, content, ctx)).toThrow(/does not fit into the context window \(1024 tokens\)/);
  });

  it('plans with the fixed Ollama context size and leaves room for thinking', () => {
    const ollama = (think: 'auto' | 'off') =>
      config({ ai: { provider: 'ollama', tokenLimit: 128_000, responseTokens: 1000, ollama: { contextSize: 8192, think } } });
    const total = (cfg: ReturnType<typeof config>) =>
      buildAnalysisPrompt(cfg, content, ctx).messages.reduce((s, m) => s + estimateTokens(m.content), 0);
    // thinking off: the whole window minus the answer
    expect(total(ollama('off')) + 1000).toBeLessThanOrEqual(8192);
    expect(total(ollama('off'))).toBeGreaterThan(8192 * 0.8);
    // thinking possible: a quarter of the window stays free for it
    expect(total(ollama('auto')) + 1000).toBeLessThanOrEqual(8192 - 2048);
    // other providers keep using the token limit
    expect(total(config({ ai: { tokenLimit: 16_000, responseTokens: 1000 } }))).toBeGreaterThan(8192);
  });
});
