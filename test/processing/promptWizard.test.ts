import { afterEach, describe, expect, it } from 'vitest';
import { configSchema, type AppConfig } from '../../src/server/config/schema.js';
import { deepMerge } from '../../src/server/config/store.js';
import { buildJsonSchema, buildOutputInstructions, type PromptContext } from '../../src/server/processing/prompt.js';
import { buildWizardPrompt, wizardLanguage, type PromptWizardAnswers } from '../../src/shared/promptWizard.js';
import { analysisJson, createHarness, type Harness } from '../helpers/appHarness.js';

function answers(patch: Partial<PromptWizardAnswers> = {}): PromptWizardAnswers {
  return configSchema.parse({ processing: { promptWizard: patch } }).processing.promptWizard;
}

function config(patch: Record<string, unknown> = {}): AppConfig {
  return configSchema.parse(deepMerge({}, patch));
}

const ctx: PromptContext = { tags: ['Rechnung'], correspondents: ['ACME'], documentTypes: ['Rechnung'], customFields: [] };

describe('buildWizardPrompt', () => {
  it('turns the defaults into a complete prompt', () => {
    const p = buildWizardPrompt(answers());
    for (const section of ['Language:', 'Title:', 'Tags:', 'Correspondent:', 'Document type:']) expect(p).toContain(section);
    expect(p).toContain('in the language of the document');
    expect(p).toContain('Assign 1 to 4 tags');
    expect(p).toContain('No tags for years or dates.');
    expect(p).not.toContain('Owner of the archive');
    expect(p).not.toContain('Additional rules');
  });

  it('keeps the archive owner out of the correspondent', () => {
    const p = buildWizardPrompt(answers({ owners: ['Max Mustermann', 'Mustermann GmbH'] }));
    expect(p).toContain('The archive belongs to “Max Mustermann”, “Mustermann GmbH”');
    expect(p).toMatch(/never use them as correspondent/);
  });

  it('writes everything in one fixed language', () => {
    const a = answers({ language: 'fixed', fixedLanguage: 'German' });
    expect(buildWizardPrompt(a)).toContain('Write title, tags and document type in German, even when the document is written in another language');
    // Only once the wizard is in use the output contract follows it.
    expect(wizardLanguage(a)).toBeNull();
    expect(wizardLanguage({ ...a, used: true })).toBe('German');
  });

  it('explains only the placeholders used by a title pattern', () => {
    const p = buildWizardPrompt(answers({ titleStyle: 'pattern', titlePattern: '{correspondent} – {subject}' }));
    expect(p).toContain('Build the title exactly like this: {correspondent} – {subject}');
    expect(p).toContain('{correspondent} = sender in short form');
    expect(p).not.toContain('{reference} =');
    expect(p).not.toContain('Include invoice, order');
  });

  it('adds tag style, avoid list, persons and own rules', () => {
    const p = buildWizardPrompt(
      answers({ tagStyle: 'broad', maxTags: 1, tagAvoid: ['generic'], correspondentPersons: false, documentTypes: ['Rechnung', 'Vertrag'], extra: 'Payslips are “Lohnabrechnung”\n\n- Car documents get the tag “Auto”' }),
    );
    expect(p).toContain('Assign exactly 1 tag.');
    expect(p).toContain('broad, reusable categories');
    expect(p).not.toContain('No tags for years');
    expect(p).toContain('leave it empty when the sender is a private person');
    expect(p).toContain('Prefer one of these types: “Rechnung”, “Vertrag”.');
    expect(p).toContain('Additional rules:\n- Payslips are “Lohnabrechnung”\n- Car documents get the tag “Auto”');
  });
});

describe('output contract and the wizard language', () => {
  it('asks for the document language unless the wizard fixed one', () => {
    expect(buildOutputInstructions(config().processing, ctx)).toContain('MUST be written in the language of the document');
    const fixed = config({ processing: { promptWizard: { used: true, language: 'fixed', fixedLanguage: 'German' } } });
    expect(buildOutputInstructions(fixed.processing, ctx)).toContain('MUST be written in German.');
    expect((buildJsonSchema(fixed.processing, ctx) as { properties: { title: { description: string } } }).properties.title.description).toContain('in German');
  });
});

describe('testing the wizard before saving', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  it('analyses with the given processing settings without saving them', async () => {
    h = await createHarness();
    h.paperless.addDocument({ id: 5, title: 'scan.pdf', content: 'Stadtwerke Musterstadt – Rechnung über 106,72 EUR für Oktober 2026' });
    h.llm.reply(analysisJson({ title: 'Stromrechnung Oktober 2026', tags: ['Rechnung'] }));
    const cookie = await h.login();
    const prompt = buildWizardPrompt(answers({ owners: ['Max Mustermann'], language: 'fixed', fixedLanguage: 'German' }));
    const res = await h.inject({
      method: 'POST',
      url: '/api/documents/5/analyze',
      headers: { cookie },
      payload: { prompt, processing: { promptWizard: { used: true, language: 'fixed', fixedLanguage: 'German' }, functions: { tags: false } } },
    });
    expect(res.statusCode).toBe(200);
    const system = JSON.stringify(h.llm.chatRequests()[0].body);
    expect(system).toContain('Max Mustermann');
    expect(system).toContain('MUST be written in German');
    expect(system).not.toContain('\\"tags\\"'); // tags switched off for this test run
    // Nothing was saved and nothing changed in Paperless.
    expect(h.ctx.cfg.processing.promptWizard.used).toBe(false);
    expect(h.ctx.cfg.processing.functions.tags).toBe(true);
    expect(h.paperless.patches(5)).toHaveLength(0);
  });

  it('rejects invalid settings', async () => {
    h = await createHarness();
    h.paperless.addDocument({ id: 5, title: 'scan.pdf', content: 'Some document text that is long enough' });
    const res = await h.inject({
      method: 'POST',
      url: '/api/documents/5/analyze',
      headers: { cookie: await h.login() },
      payload: { processing: { promptWizard: { maxTags: 99 } } },
    });
    expect(res.statusCode).toBe(400);
  });
});
