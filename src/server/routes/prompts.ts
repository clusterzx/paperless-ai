import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { LibraryPrompt, PromptLibrary, PromptRating } from '../../shared/api.js';
import type { Services } from '../http/app.js';
import { HttpProblem, notFound } from '../http/helpers.js';
import { promptWizardSchema } from '../config/schema.js';
import type { PromptRatingRow, PromptRow } from '../db/promptsRepo.js';
import { logger } from '../logger.js';
import { rulePrompt } from '../processing/promptRules.js';
import { ruleLabel } from '../../shared/promptRules.js';

const log = logger.child({ module: 'prompts' });

/** Offered next to the use cases already in the library. */
const USE_CASE_SUGGESTIONS = ['General', 'Invoices & receipts', 'Contracts & insurance', 'Letters & correspondence', 'Tax', 'Medical', 'Business'];
/** Upper limit of prompts imported from a browser at once. */
const MAX_IMPORT = 200;

const id = z.coerce.number().int().positive();
const name = z.string().trim().min(1).max(120);
const useCase = z.string().trim().max(60);
const promptText = z.string().trim().min(1).max(50_000);
const rating = z.object({
  score: z.number().int().min(1).max(10),
  note: z.string().trim().max(2000).default(''),
  /** Default: the AI provider and model in use. */
  provider: z.string().trim().max(60).optional(),
  model: z.string().trim().max(200).optional(),
  documents: z.array(z.number().int().positive()).max(100).default([]),
});

export const promptRoutes =
  ({ ctx }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();
    const repo = ctx.repos.prompts;

    const isActive = (prompt: string) => !ctx.cfg.processing.usePromptTags && prompt.trim() === ctx.cfg.processing.systemPrompt.trim();
    const withRating = (r: z.output<typeof rating>) => {
      const current = ctx.aiInfo();
      return { ...r, provider: r.provider ?? current.provider, model: r.model ?? current.model };
    };

    /** Documents processed with each prompt and the rules using it. */
    const usage = () => {
      const documents = ctx.repos.history.promptUsage();
      const rules = new Map<number, string[]>();
      ctx.cfg.processing.promptRules.forEach((rule, index) => {
        const p = rulePrompt(ctx, rule);
        if (p) rules.set(p.id, [...(rules.get(p.id) ?? []), ruleLabel(rule, index)]);
      });
      return (id: number) => ({ documents: documents.get(id) ?? 0, rules: rules.get(id) ?? [] });
    };

    const library = (): PromptLibrary => {
      const ratings = new Map<number, PromptRatingRow[]>();
      for (const r of repo.ratings()) ratings.set(r.prompt_id, [...(ratings.get(r.prompt_id) ?? []), r]);
      const usageOf = usage();
      const prompts = repo.list().map((p) => toDto(p, ratings.get(p.id) ?? [], isActive(p.prompt), usageOf(p.id)));
      const used = [...new Set(prompts.map((p) => p.useCase).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      const current = ctx.cfg.processing.systemPrompt.trim();
      return {
        prompts,
        useCases: [...used, ...USE_CASE_SUGGESTIONS.filter((s) => !used.some((u) => u.toLowerCase() === s.toLowerCase()))],
        current: ctx.aiInfo(),
        currentMissing: !ctx.cfg.processing.usePromptTags && current !== '' && !repo.findByText(current),
        locked: Boolean(ctx.config.lockedPaths['processing.systemPrompt']),
      };
    };
    const one = (promptId: number): LibraryPrompt => {
      const p = repo.get(promptId);
      if (!p) throw notFound('Prompt not found');
      return toDto(
        p,
        repo.ratings().filter((r) => r.prompt_id === promptId),
        isActive(p.prompt),
        usage()(p.id),
      );
    };

    app.get('/api/prompts', { schema: { description: 'The prompt library: kept prompts with their ratings per model.' } }, async () => library());

    app.post(
      '/api/prompts',
      {
        schema: {
          description:
            'Keep a prompt in the library, optionally with a first rating. A prompt with the same text is not added twice – the rating goes to the existing one. ' +
            'With `current: true` the system prompt in use is saved (including the prompt wizard answers it was made with).',
          body: z.object({
            name,
            useCase: useCase.default(''),
            prompt: promptText.optional(),
            current: z.boolean().optional(),
            /** Answers of the prompt wizard the prompt was made with. */
            wizard: z.record(z.string(), z.unknown()).optional(),
            rating: rating.optional(),
          }),
        },
      },
      async (req, reply) => {
        const b = req.body;
        const p = ctx.cfg.processing;
        const text = b.current ? p.systemPrompt.trim() : b.prompt;
        if (!text) throw new HttpProblem(400, b.current ? 'No system prompt is set' : 'The prompt is empty');
        const wizard = b.wizard ? promptWizardSchema.parse(b.wizard) : b.current && p.promptWizard.used ? p.promptWizard : null;
        const existing = repo.findByText(text);
        const promptId = existing?.id ?? repo.create({ name: b.name, useCase: b.useCase, prompt: text, wizard: wizard ? { ...wizard, used: true } : null });
        if (b.rating) repo.addRating(promptId, withRating(b.rating));
        if (!existing) log.info(`Prompt "${b.name}" added to the library`);
        return reply.code(existing ? 200 : 201).send({ prompt: one(promptId), created: !existing });
      },
    );

    app.patch(
      '/api/prompts/:id',
      { schema: { params: z.object({ id }), body: z.object({ name: name.optional(), useCase: useCase.optional(), prompt: promptText.optional() }) } },
      async (req) => {
        if (!repo.update(req.params.id, req.body)) throw notFound('Prompt not found');
        return one(req.params.id);
      },
    );

    app.delete('/api/prompts/:id', { schema: { params: z.object({ id }) } }, async (req, reply) => {
      const inUse = usage()(req.params.id).rules;
      if (inUse.length) throw new HttpProblem(409, `The prompt is used by the prompt rule ${inUse.map((r) => `"${r}"`).join(', ')} – remove or change the rule first`);
      if (!repo.delete(req.params.id)) throw notFound('Prompt not found');
      return reply.code(204).send();
    });

    app.post(
      '/api/prompts/:id/ratings',
      { schema: { description: 'Rate how well the prompt worked (1–10); the model defaults to the one in use.', params: z.object({ id }), body: rating } },
      async (req, reply) => {
        if (!repo.get(req.params.id)) throw notFound('Prompt not found');
        repo.addRating(req.params.id, withRating(req.body));
        return reply.code(201).send(one(req.params.id));
      },
    );

    app.delete('/api/prompts/:id/ratings/:ratingId', { schema: { params: z.object({ id, ratingId: id }) } }, async (req) => {
      if (!repo.deleteRating(req.params.id, req.params.ratingId)) throw notFound('Rating not found');
      return one(req.params.id);
    });

    app.post(
      '/api/prompts/:id/activate',
      {
        config: { auth: 'session' },
        schema: { description: 'Use the prompt as system prompt for automatic processing.', params: z.object({ id }) },
      },
      async (req) => {
        const p = repo.get(req.params.id);
        if (!p) throw notFound('Prompt not found');
        if (ctx.config.lockedPaths['processing.systemPrompt']) {
          throw new HttpProblem(409, `The system prompt is set by the environment variable ${ctx.config.lockedPaths['processing.systemPrompt']}`);
        }
        // A prompt made with the wizard brings its answers back (e.g. the output language); any other one is a manual prompt.
        const wizard = parseWizard(p.wizard);
        ctx.config.update({
          processing: {
            systemPrompt: p.prompt,
            usePromptTags: false,
            promptWizard: wizard ? { ...wizard, used: true } : { used: false },
          },
        });
        log.info(`Prompt "${p.name}" is now the system prompt`);
        return one(p.id);
      },
    );

    app.post(
      '/api/prompts/import',
      {
        schema: {
          description: 'Take over prompts saved in the browser by earlier versions of the prompt playground.',
          body: z.object({
            prompts: z
              .array(
                z.object({
                  prompt: z.string().max(50_000),
                  rating: z.coerce.number().int().min(1).max(10).catch(5),
                  comment: z.string().max(2000).catch(''),
                  savedAt: z.coerce.number().int().positive().optional().catch(undefined),
                }),
              )
              .max(MAX_IMPORT),
          }),
        },
      },
      async (req) => {
        let imported = 0;
        for (const [i, s] of req.body.prompts.entries()) {
          const text = s.prompt.trim();
          if (!text) continue;
          const at = s.savedAt ?? Date.now();
          let promptId = repo.findByText(text)?.id;
          if (!promptId) {
            promptId = repo.create({ name: `Saved prompt ${new Date(at).toISOString().slice(0, 10)}${req.body.prompts.length > 1 ? ` (${i + 1})` : ''}`, useCase: '', prompt: text }, at);
            imported++;
          }
          repo.addRating(promptId, { provider: '', model: '', score: s.rating, note: s.comment.trim(), documents: [], createdAt: at });
        }
        if (imported) log.info(`Imported ${imported} prompt(s) saved in the browser`);
        return { imported, library: library() };
      },
    );
  };

function parseWizard(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return promptWizardSchema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}

function toDto(p: PromptRow, rows: PromptRatingRow[], active: boolean, usage: { documents: number; rules: string[] } = { documents: 0, rules: [] }): LibraryPrompt {
  const ratings: PromptRating[] = rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    model: r.model,
    score: r.score,
    note: r.note,
    documents: r.documents ? (JSON.parse(r.documents) as number[]) : [],
    createdAt: r.created_at,
  }));
  const byModel = new Map<string, { provider: string; model: string; total: number; count: number }>();
  for (const r of ratings) {
    const key = `${r.provider}\u0000${r.model}`;
    const m = byModel.get(key) ?? { provider: r.provider, model: r.model, total: 0, count: 0 };
    m.total += r.score;
    m.count++;
    byModel.set(key, m);
  }
  const mean = (total: number, count: number) => Math.round((total / count) * 10) / 10;
  return {
    id: p.id,
    name: p.name,
    useCase: p.use_case,
    prompt: p.prompt,
    fromWizard: Boolean(p.wizard),
    active,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    ratings,
    score: ratings.length ? mean(ratings.reduce((s, r) => s + r.score, 0), ratings.length) : null,
    documents: usage.documents,
    rules: usage.rules,
    models: [...byModel.values()]
      .map((m) => ({ provider: m.provider, model: m.model, score: mean(m.total, m.count), count: m.count }))
      .sort((a, b) => b.score - a.score || b.count - a.count),
  };
}
