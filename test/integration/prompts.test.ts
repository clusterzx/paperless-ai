import { afterEach, describe, expect, it } from 'vitest';
import type { LibraryPrompt, PromptLibrary } from '../../src/shared/api.js';
import { createHarness, type Harness, type HarnessOptions } from '../helpers/appHarness.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function setup(opts: HarnessOptions = {}) {
  h = await createHarness(opts);
  const cookie = await h.login();
  const call = async <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = { cookie }) => {
    const res = await h!.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
  };
  return { hh: h, cookie, call };
}

describe('prompt library', () => {
  it('keeps prompts with ratings per model, defaulting to the model in use', async () => {
    const { call } = await setup();
    const created = await call<{ prompt: LibraryPrompt; created: boolean }>('POST', '/api/prompts', {
      name: 'Invoices, short titles',
      useCase: 'Invoices & receipts',
      prompt: 'Analyze the invoice. Title: "<vendor> <month>".',
      rating: { score: 8, note: 'Good titles', documents: [3, 4] },
    });
    expect(created.status).toBe(201);
    expect(created.body.created).toBe(true);
    const id = created.body.prompt.id;
    expect(created.body.prompt.ratings).toMatchObject([{ provider: 'custom', model: 'test-model', score: 8, note: 'Good titles', documents: [3, 4] }]);

    const rated = await call<LibraryPrompt>('POST', `/api/prompts/${id}/ratings`, { score: 5, provider: 'ollama', model: 'qwen3:8b', note: 'Misses tags' });
    expect(rated.status).toBe(201);
    await call('POST', `/api/prompts/${id}/ratings`, { score: 10 });
    const lib = (await call<PromptLibrary>('GET', '/api/prompts')).body;
    const p = lib.prompts.find((x) => x.id === id)!;
    expect(p.score).toBe(7.7);
    expect(p.models).toEqual([
      { provider: 'custom', model: 'test-model', score: 9, count: 2 },
      { provider: 'ollama', model: 'qwen3:8b', score: 5, count: 1 },
    ]);
    expect(lib.current).toEqual({ provider: 'custom', model: 'test-model' });
    expect(lib.useCases[0]).toBe('Invoices & receipts');
    expect(lib.useCases).toContain('Contracts & insurance');
    expect(lib.currentMissing).toBe(true);
    expect(p.active).toBe(false);

    // the same text again: no duplicate, the rating goes to the existing prompt
    const again = await call<{ prompt: LibraryPrompt; created: boolean }>('POST', '/api/prompts', {
      name: 'Other name',
      prompt: '  Analyze the invoice. Title: "<vendor> <month>".\n',
      rating: { score: 6 },
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, prompt: { id, name: 'Invoices, short titles' } });
    expect(again.body.prompt.ratings).toHaveLength(4);

    // edit, delete a rating, delete the prompt
    const edited = await call<LibraryPrompt>('PATCH', `/api/prompts/${id}`, { name: 'Invoices v2', useCase: 'Tax' });
    expect(edited.body).toMatchObject({ name: 'Invoices v2', useCase: 'Tax', prompt: 'Analyze the invoice. Title: "<vendor> <month>".' });
    const ratingId = edited.body.ratings.find((r) => r.model === 'qwen3:8b')!.id;
    expect((await call<LibraryPrompt>('DELETE', `/api/prompts/${id}/ratings/${ratingId}`)).body.models.map((m) => m.model)).toEqual(['test-model']);
    expect((await call('DELETE', `/api/prompts/${id}/ratings/${ratingId}`)).status).toBe(404);
    expect((await call('DELETE', `/api/prompts/${id}`)).status).toBe(204);
    expect((await call<PromptLibrary>('GET', '/api/prompts')).body.prompts).toEqual([]);
    expect((await call('POST', `/api/prompts/${id}/ratings`, { score: 3 })).status).toBe(404);
  });

  it('validates input', async () => {
    const { call } = await setup();
    expect((await call('POST', '/api/prompts', { name: '', prompt: 'x' })).status).toBe(400);
    expect((await call('POST', '/api/prompts', { name: 'Empty', prompt: '   ' })).status).toBe(400);
    expect((await call('POST', '/api/prompts', { name: 'Bad score', prompt: 'x', rating: { score: 11 } })).status).toBe(400);
  });

  it('activates a prompt as system prompt and restores the wizard answers it was made with', async () => {
    const { hh, call } = await setup();
    const manual = (await call<{ prompt: LibraryPrompt }>('POST', '/api/prompts', { name: 'Manual', prompt: 'My own prompt' })).body.prompt;
    const wizard = (
      await call<{ prompt: LibraryPrompt }>('POST', '/api/prompts', {
        name: 'From the wizard',
        prompt: 'Wizard prompt in German',
        wizard: { language: 'fixed', fixedLanguage: 'German', maxTags: 3 },
      })
    ).body.prompt;
    expect(wizard.fromWizard).toBe(true);

    const activated = await call<LibraryPrompt>('POST', `/api/prompts/${wizard.id}/activate`);
    expect(activated.body.active).toBe(true);
    expect(hh.ctx.cfg.processing.systemPrompt).toBe('Wizard prompt in German');
    expect(hh.ctx.cfg.processing.promptWizard).toMatchObject({ used: true, language: 'fixed', fixedLanguage: 'German', maxTags: 3 });

    await call('POST', `/api/prompts/${manual.id}/activate`);
    expect(hh.ctx.cfg.processing.systemPrompt).toBe('My own prompt');
    expect(hh.ctx.cfg.processing.promptWizard.used).toBe(false);
    const lib = (await call<PromptLibrary>('GET', '/api/prompts')).body;
    expect(lib.prompts.filter((p) => p.active).map((p) => p.name)).toEqual(['Manual']);
    expect(lib.currentMissing).toBe(false);
    expect((await call('POST', '/api/prompts/999/activate')).status).toBe(404);
  });

  it('saves the system prompt in use, with its wizard answers', async () => {
    const { call } = await setup({
      config: { processing: { systemPrompt: 'Prompt made by the wizard', promptWizard: { used: true, language: 'fixed', fixedLanguage: 'French' } } },
    });
    expect((await call<PromptLibrary>('GET', '/api/prompts')).body.currentMissing).toBe(true);
    const saved = await call<{ prompt: LibraryPrompt }>('POST', '/api/prompts', { name: 'Current', current: true });
    expect(saved.body.prompt).toMatchObject({ prompt: 'Prompt made by the wizard', fromWizard: true, active: true });
    expect((await call<PromptLibrary>('GET', '/api/prompts')).body.currentMissing).toBe(false);
  });

  it('activation needs a logged-in user and is refused when SYSTEM_PROMPT is set', async () => {
    const { hh, call } = await setup({ env: { SYSTEM_PROMPT: 'From the environment' } });
    const p = (await call<{ prompt: LibraryPrompt }>('POST', '/api/prompts', { name: 'Mine', prompt: 'Library prompt' })).body.prompt;
    expect((await call<PromptLibrary>('GET', '/api/prompts')).body.locked).toBe(true);
    const res = await call<{ error: string }>('POST', `/api/prompts/${p.id}/activate`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('SYSTEM_PROMPT');
    expect(hh.ctx.cfg.processing.systemPrompt).toBe('From the environment');

    // API keys may read and rate, but not change the system prompt
    const viaKey = hh.apiKeyHeaders();
    expect((await call<PromptLibrary>('GET', '/api/prompts', undefined, viaKey)).body.prompts).toHaveLength(1);
    expect((await call('POST', `/api/prompts/${p.id}/ratings`, { score: 7 }, viaKey)).status).toBe(201);
    expect((await call('POST', `/api/prompts/${p.id}/activate`, undefined, viaKey)).status).toBe(403);
    expect((await call('GET', '/api/prompts', undefined, {})).status).toBe(401);
  });

  it('imports prompts saved in the browser by the old playground', async () => {
    const { call } = await setup();
    await call('POST', '/api/prompts', { name: 'Existing', prompt: 'Same text' });
    const res = await call<{ imported: number; library: PromptLibrary }>('POST', '/api/prompts/import', {
      prompts: [
        { id: 'a', prompt: 'Same text', rating: 9, comment: 'great', savedAt: 1_700_000_000_000 },
        { id: 'b', prompt: 'Another prompt', rating: 4, comment: '', savedAt: 1_700_000_000_000 },
        { id: 'c', prompt: '   ', rating: 5, comment: '' },
      ],
    });
    expect(res.body.imported).toBe(1);
    const byText = Object.fromEntries(res.body.library.prompts.map((p) => [p.prompt, p]));
    expect(byText['Same text']).toMatchObject({ name: 'Existing', ratings: [{ score: 9, note: 'great', model: '' }] });
    expect(byText['Another prompt']).toMatchObject({ name: 'Saved prompt 2023-11-14 (2)', ratings: [{ score: 4 }] });
  });
});
