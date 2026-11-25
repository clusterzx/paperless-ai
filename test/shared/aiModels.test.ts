import { describe, expect, it } from 'vitest';
import { RETIRING_MODELS, retirementOf } from '../../src/shared/aiModels.js';
import { DEFAULT_OPENAI_MODEL } from '../../src/server/config/defaults.js';

describe('retirementOf', () => {
  it('knows models OpenAI shuts down – also as a dated snapshot or behind a router', () => {
    expect(retirementOf('gpt-5-mini', '2026-11-25')).toEqual({ model: 'gpt-5-mini', date: '2026-12-11', replacement: 'gpt-6.1-terra', retired: false });
    expect(retirementOf('gpt-5-mini-2025-08-07', '2026-11-25')?.model).toBe('gpt-5-mini');
    expect(retirementOf(' OpenAI/GPT-4o-mini ', '2026-11-25')).toMatchObject({ model: 'gpt-4o-mini', date: '2027-01-14', replacement: 'gpt-6-luna' });
    // On and after the date it is shut down.
    expect(retirementOf('gpt-5-mini', '2026-12-11')?.retired).toBe(true);
    expect(retirementOf('o4-mini', '2026-11-25')?.retired).toBe(true);
  });

  it('leaves current models alone', () => {
    for (const model of ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-5.5', 'claude-haiku-5-5', 'llama3.2', 'deepseek-chat']) expect(retirementOf(model, '2026-11-25')).toBeNull();
  });

  it('never recommends a model that is itself shut down, and the default is none of them', () => {
    for (const { replacement } of Object.values(RETIRING_MODELS)) expect(RETIRING_MODELS[replacement]).toBeUndefined();
    expect(retirementOf(DEFAULT_OPENAI_MODEL)).toBeNull();
  });
});
