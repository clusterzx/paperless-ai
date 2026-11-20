import { afterEach, describe, expect, it } from 'vitest';
import type { HistoryItem, LibraryPrompt, PromptLibrary } from '../../src/shared/api.js';
import type { PromptRulesInfo } from '../../src/shared/promptRules.js';
import { configSchema, promptRuleSchema, type PromptRuleInput } from '../../src/server/config/schema.js';
import { enabledFields } from '../../src/server/processing/prompt.js';
import { matchesConditions, ruleProcessing, type DocumentFacts } from '../../src/server/processing/promptRules.js';
import { emptyConditions } from '../../src/shared/promptRules.js';
import { analysisJson, createHarness, type Harness, type HarnessOptions } from '../helpers/appHarness.js';
import type { ChatRequestInfo } from '../helpers/mockLlm.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const TEACHING = 'You classify teaching material: subject, grade level, school year, material type.';
const HOUSEHOLD = 'You classify household documents.';

async function setup(rules: (ids: { teaching: number; household: number }) => PromptRuleInput[], opts: HarnessOptions = {}) {
  h = await createHarness({
    ...opts,
    config: {
      ...opts.config,
      processing: {
        systemPrompt: HOUSEHOLD,
        customFields: [
          { name: 'Amount', type: 'monetary', currency: 'EUR', description: '' },
          { name: 'Subject', type: 'string', description: '' },
          { name: 'Grade', type: 'string', description: '' },
        ],
        ...opts.config?.processing,
      },
    },
  });
  const teaching = h.ctx.repos.prompts.create({ name: 'Teaching material', useCase: 'School', prompt: TEACHING });
  const household = h.ctx.repos.prompts.create({ name: 'Household', useCase: 'Home', prompt: HOUSEHOLD });
  h.ctx.config.update({ processing: { promptRules: rules({ teaching, household }).map((r) => promptRuleSchema.parse(r)) } });
  const p = h.paperless;
  p.addTag('Unterricht', 50);
  p.addTag('Mathe', 51);
  p.addTag('Rechnung', 52);
  p.addDocumentType('Arbeitsblatt', 60);
  p.addCorrespondent('Schulbuchverlag', 70);
  p.addStoragePath('Schule', 80);
  p.users = [{ id: 7, username: 'lehrerin' }];
  return { hh: h, ids: { teaching, household } };
}

/** The system prompt and JSON schema the AI got for each document. */
function requestsByDocument(hh: Harness) {
  return hh.llm.chatRequests().map((r) => {
    const body = r.body as { model: string; messages: { role: string; content: string }[]; response_format?: { json_schema?: { schema?: { properties?: Record<string, unknown> } } } };
    return {
      model: body.model,
      system: body.messages.find((m) => m.role === 'system')?.content ?? '',
      user: body.messages.find((m) => m.role === 'user')?.content ?? '',
      properties: Object.keys(body.response_format?.json_schema?.schema?.properties ?? {}),
    };
  });
}

async function scan(hh: Harness) {
  const res = await hh.inject({ method: 'POST', url: '/api/processing/scan', headers: hh.apiKeyHeaders() });
  expect(res.statusCode).toBe(200);
  await hh.engine.drain(10_000);
}

const reply = (req: ChatRequestInfo) =>
  req.user.includes('worksheet')
    ? analysisJson({
        title: 'Fractions worksheet',
        correspondent: 'Schulbuchverlag',
        tags: ['Mathe', 'Rechnung', 'Bruchrechnung'],
        document_type: 'Arbeitsblatt',
        custom_fields: [
          { field_name: 'Subject', value: 'Mathematik' },
          { field_name: 'Grade', value: '6' },
          { field_name: 'Amount', value: '12 EUR' },
        ],
      })
    : analysisJson({ title: 'Electricity bill', correspondent: 'City Power', tags: ['Rechnung'], document_type: 'Invoice', custom_fields: [{ field_name: 'Amount', value: '89.50 EUR' }] });

describe('prompt rules', () => {
  it('analyses documents with the prompt and the settings of the first matching rule', async () => {
    const { hh, ids } = await setup(({ teaching }) => [
      {
        name: 'School',
        prompt: teaching,
        match: { tagsAny: ['unterricht'] },
        overrides: {
          functions: { correspondent: false, events: false },
          customFields: ['Subject', 'Grade'],
          allowedTags: ['Mathe', 'Deutsch', 'Bruchrechnung'],
          allowedDocumentTypes: ['Arbeitsblatt', 'Test'],
          model: 'small-local-model',
        },
      },
    ]);
    hh.paperless.addDocument({ id: 1, title: 'scan1', content: 'A worksheet about fractions for grade 6, Mathematik.', tags: [50] });
    hh.paperless.addDocument({ id: 2, title: 'scan2', content: 'City Power electricity bill, total 89.50 EUR for March 2024.' });
    hh.llm.reply(reply);
    await scan(hh);

    const [school, home] = [...requestsByDocument(hh)].sort((a) => (a.user.includes('worksheet') ? -1 : 1));
    expect(school.system.startsWith(TEACHING)).toBe(true);
    expect(school.model).toBe('small-local-model');
    expect(school.properties).not.toContain('correspondent');
    expect(school.system).toContain('ONLY use tags from this list: Mathe, Deutsch, Bruchrechnung');
    expect(school.system).toContain('document_type: ONLY use one of: Arbeitsblatt, Test');
    expect(school.system).toContain('Subject');
    expect(school.system).not.toContain('Amount');
    expect(home.system.startsWith(HOUSEHOLD)).toBe(true);
    expect(home.model).toBe('test-model');
    expect(home.properties).toContain('correspondent');

    // Only the settings of the rule were applied to the worksheet
    const worksheet = hh.paperless.docs.get(1)!;
    expect(worksheet.correspondent).toBeNull();
    const tagNames = worksheet.tags.map((id) => hh.paperless.tags.get(id)!.name).sort();
    expect(tagNames).toEqual(['Bruchrechnung', 'Mathe', 'Unterricht']); // "Rechnung" is not allowed, "Bruchrechnung" was created
    expect(hh.paperless.documentTypes.get(worksheet.document_type!)!.name).toBe('Arbeitsblatt');
    const fieldNames = worksheet.custom_fields.map((f) => hh.paperless.customFields.get(f.field)!.name).sort();
    expect(fieldNames).toEqual(['Grade', 'Subject']);
    const bill = hh.paperless.docs.get(2)!;
    expect(hh.paperless.correspondents.get(bill.correspondent!)!.name).toBe('City Power');

    // The history and the library show which prompt was used
    const history = (await hh.inject({ method: 'GET', url: '/api/history', headers: hh.apiKeyHeaders() })).json() as { items: HistoryItem[] };
    expect(history.items.find((i) => i.documentId === 1)!.prompt).toEqual({ id: ids.teaching, name: 'Teaching material' });
    expect(history.items.find((i) => i.documentId === 2)!.prompt).toBeNull();
    const lib = (await hh.inject({ method: 'GET', url: '/api/prompts', headers: hh.apiKeyHeaders() })).json() as PromptLibrary;
    expect(lib.prompts.find((p) => p.id === ids.teaching)).toMatchObject({ documents: 1, rules: ['School'] });
  });

  it('matches on all kinds of conditions, in order', async () => {
    const select = { select_options: [{ id: 'opt-a', label: 'Klasse 5' }, { id: 'opt-b', label: 'Klasse 6' }] };
    const { hh, ids } = await setup(({ teaching, household }) => [
      { name: 'Off', enabled: false, prompt: household, match: {} },
      { name: 'All tags', prompt: teaching, match: { tagsAll: ['Unterricht', 'Mathe'] } },
      { name: 'Type + correspondent', prompt: teaching, match: { documentTypes: ['arbeitsblatt'], correspondents: ['Schulbuchverlag'] } },
      { name: 'Storage path', prompt: teaching, match: { storagePaths: ['Schule'] } },
      { name: 'Owner', prompt: teaching, match: { owners: ['Lehrerin'] } },
      { name: 'Custom field', prompt: teaching, match: { customField: { name: 'Klasse', value: 'klasse 6' } } },
      { name: 'Everything else', prompt: household, match: {} },
    ]);
    const klasse = hh.paperless.addCustomField('Klasse', 'select', select, 90);
    const p = hh.paperless;
    const docs: [number, Partial<Parameters<typeof p.addDocument>[0]>][] = [
      [11, { tags: [50, 51] }],
      [12, { tags: [50] }],
      [13, { document_type: 60, correspondent: 70 }],
      [14, { document_type: 60 }],
      [15, { storage_path: 80 }],
      [16, { owner: 7 }],
      [17, { custom_fields: [{ field: klasse.id, value: 'opt-b' }] }],
      [18, { custom_fields: [{ field: klasse.id, value: 'opt-a' }] }],
    ];
    for (const [id, d] of docs) p.addDocument({ id, content: `Document number ${id} with enough text.`, ...d });
    const match = async (id: number) => (await hh.inject({ method: 'GET', url: `/api/prompt-rules/match/${id}`, headers: hh.apiKeyHeaders() })).json().rule as { name: string } | null;
    const expected: Record<number, string> = {
      11: 'All tags',
      12: 'Everything else',
      13: 'Type + correspondent',
      14: 'Everything else',
      15: 'Storage path',
      16: 'Owner',
      17: 'Custom field',
      18: 'Everything else',
    };
    for (const [id, name] of Object.entries(expected)) expect((await match(Number(id)))?.name, `document ${id}`).toBe(name);
    expect(await match(11)).toMatchObject({ promptId: ids.teaching, promptName: 'Teaching material', model: null });

    // Without the permission to view users the owner can still be given by id
    hh.paperless.users = null;
    hh.ctx.metadata().invalidate();
    hh.ctx.config.update({ processing: { promptRules: [promptRuleSchema.parse({ prompt: ids.teaching, match: { owners: ['7'] } })] } });
    expect((await match(16))?.name).toBe('Rule 1');
  });

  it('lets "Tags: no" win over a tag list', () => {
    const base = promptRuleSchema.parse({ prompt: 1 });
    const settings = { ...configSchema.parse({}).processing, usePromptTags: true, promptTags: ['A'] };
    const off = ruleProcessing(settings, { ...base, overrides: { ...base.overrides, functions: { tags: false }, allowedTags: ['B'] } }, 'Prompt');
    expect(enabledFields(off).tags).toBe(false);
    const listed = ruleProcessing(settings, { ...base, overrides: { ...base.overrides, allowedTags: ['B'] } }, 'Prompt');
    expect(enabledFields(listed).tags).toBe(true);
    expect(listed.promptTags).toEqual(['B']);
  });

  it('checks the conditions like Paperless names: case-insensitive, all set conditions together', () => {
    const facts: DocumentFacts = {
      tags: new Set(['unterricht', 'mathe']),
      documentType: 'arbeitsblatt',
      correspondent: null,
      storagePath: null,
      owner: ['7', 'lehrerin'],
      customFields: new Map([['klasse', 'Klasse 6']]),
    };
    const c = (patch: Partial<ReturnType<typeof emptyConditions>>) => ({ ...emptyConditions(), ...patch });
    expect(matchesConditions(c({}), facts)).toBe(true);
    expect(matchesConditions(c({ tagsAny: ['Deutsch', 'MATHE'] }), facts)).toBe(true);
    expect(matchesConditions(c({ tagsAll: ['Mathe', 'Deutsch'] }), facts)).toBe(false);
    expect(matchesConditions(c({ tagsAny: ['Mathe'], documentTypes: ['Test'] }), facts)).toBe(false);
    expect(matchesConditions(c({ correspondents: ['Anyone'] }), facts)).toBe(false);
    expect(matchesConditions(c({ customField: { name: 'Klasse', value: '' } }), facts)).toBe(true);
    expect(matchesConditions(c({ customField: { name: 'Klasse', value: 'Klasse 5' } }), facts)).toBe(false);
    expect(matchesConditions(c({ customField: { name: 'Fach', value: '' } }), facts)).toBe(false);
  });

  it('can switch fields on, restrict to existing values and leaves explicit prompts alone', async () => {
    const { hh } = await setup(({ teaching }) => [
      { prompt: teaching, match: { tagsAny: ['Unterricht'] }, overrides: { functions: { events: true }, restrict: { tags: true, documentTypes: true } } },
    ]);
    hh.paperless.addDocument({ id: 1, content: 'A worksheet about fractions for grade 6, Mathematik.', tags: [50] });
    hh.llm.reply(reply);
    await scan(hh);
    const [req] = requestsByDocument(hh);
    expect(req.properties).toContain('events');
    const tagNames = hh.paperless.docs.get(1)!.tags.map((id) => hh.paperless.tags.get(id)!.name).sort();
    expect(tagNames).toEqual(['Mathe', 'Rechnung', 'Unterricht']); // "Bruchrechnung" does not exist and is not created

    // A prompt sent with the webhook wins over the rules
    hh.llm.clearRequests();
    await hh.inject({ method: 'POST', url: '/api/webhook/document', headers: hh.apiKeyHeaders(), payload: { document_id: 1, force: true, prompt: 'Webhook prompt' } });
    await hh.engine.drain();
    expect(requestsByDocument(hh)[0].system.startsWith('Webhook prompt')).toBe(true);
  });

  it('manages the rules through the API, locked by PROMPT_RULES', async () => {
    const { hh, ids } = await setup(() => []);
    const cookie = await hh.login();
    const get = async () => (await hh.inject({ method: 'GET', url: '/api/prompt-rules', headers: { cookie } })).json() as PromptRulesInfo;
    const put = (rules: unknown, headers: Record<string, string> = { cookie }) => hh.inject({ method: 'PUT', url: '/api/prompt-rules', headers, payload: { rules } });

    const rule = { name: 'School', prompt: ids.teaching, match: { tagsAny: ['Unterricht'] }, overrides: { functions: { correspondent: false } } };
    expect((await put([rule], hh.apiKeyHeaders())).statusCode).toBe(403);
    expect((await put([{ ...rule, prompt: 999 }])).statusCode).toBe(400);
    const saved = await put([rule]);
    expect(saved.statusCode).toBe(200);
    const info = await get();
    expect(info).toMatchObject({ locked: null, storagePaths: ['Schule'], owners: ['lehrerin'], customFields: ['Amount', 'Subject', 'Grade'], model: 'test-model' });
    expect(info.rules).toMatchObject([{ name: 'School', enabled: true, promptId: ids.teaching, promptName: 'Teaching material', problem: null, overrides: { functions: { correspondent: false }, customFields: null, model: '' } }]);

    // A prompt used by a rule cannot be deleted
    const del = await hh.inject({ method: 'DELETE', url: `/api/prompts/${ids.teaching}`, headers: { cookie } });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toContain('"School"');
    const library = (await hh.inject({ method: 'GET', url: '/api/prompts', headers: { cookie } })).json() as PromptLibrary;
    expect(library.prompts.map((p: LibraryPrompt) => p.id)).toContain(ids.teaching);

    // The manual review analyses with the rule as well
    hh.paperless.addDocument({ id: 1, content: 'A worksheet about fractions for grade 6, Mathematik.', tags: [50] });
    hh.llm.reply(reply);
    const analysis = await hh.inject({ method: 'POST', url: '/api/documents/1/analyze', headers: { cookie } });
    expect(analysis.json().rule).toMatchObject({ name: 'School', promptName: 'Teaching material' });
    expect(requestsByDocument(hh).at(-1)!.system.startsWith(TEACHING)).toBe(true);
    const applied = await hh.inject({ method: 'POST', url: '/api/documents/1/apply', headers: { cookie }, payload: { title: 'Fractions', promptId: ids.teaching } });
    expect(applied.statusCode).toBe(200);
    expect(hh.ctx.repos.history.list({}).items[0].prompt).toEqual({ id: ids.teaching, name: 'Teaching material' });
  });

  it('takes rules from PROMPT_RULES, referring to prompts by name', async () => {
    const rules = JSON.stringify([{ name: 'School', prompt: 'teaching material', match: { tagsAny: ['Unterricht'] } }, { prompt: 'Missing prompt', match: {} }]);
    const { hh } = await setup(() => [], { env: { PROMPT_RULES: rules } });
    const cookie = await hh.login();
    const info = (await hh.inject({ method: 'GET', url: '/api/prompt-rules', headers: { cookie } })).json() as PromptRulesInfo;
    expect(info.locked).toBe('PROMPT_RULES');
    expect(info.rules.map((r) => [r.promptName, r.problem === null])).toEqual([
      ['Teaching material', true],
      [null, false],
    ]);
    expect((await hh.inject({ method: 'PUT', url: '/api/prompt-rules', headers: { cookie }, payload: { rules: [] } })).statusCode).toBe(409);
    hh.paperless.addDocument({ id: 1, content: 'A worksheet about fractions for grade 6, Mathematik.', tags: [50] });
    hh.paperless.addDocument({ id: 2, content: 'City Power electricity bill, total 89.50 EUR for March 2024.' });
    hh.llm.reply(reply);
    await scan(hh);
    // the rule with the missing prompt is skipped – the second document gets the system prompt
    const systems = requestsByDocument(hh).map((r) => (r.user.includes('worksheet') ? 'school' : r.system.startsWith(HOUSEHOLD) ? 'system prompt' : 'other'));
    expect(systems.sort()).toEqual(['school', 'system prompt']);
  });
});
