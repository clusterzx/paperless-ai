import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { MatchedPromptRule, PromptRuleConfig, PromptRulesInfo } from '../../shared/promptRules.js';
import { ruleLabel } from '../../shared/promptRules.js';
import type { Services } from '../http/app.js';
import { HttpProblem } from '../http/helpers.js';
import { promptRuleSchema } from '../config/schema.js';
import { activeModel } from '../ai/factory.js';
import { rulePrompt } from '../processing/promptRules.js';
import { describePlan, planAnalysis } from '../workflows/analysis.js';
import { replaceRuleWorkflows, ruleWorkflows } from '../workflows/promptRules.js';
import { userIdOf } from '../access/scope.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'prompt-rules' });

export const promptRuleRoutes =
  ({ ctx }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    const locked = () => ctx.config.lockedPaths['processing.promptRules'] ?? null;

    const info = async (): Promise<PromptRulesInfo> => {
      // Storage paths and users for the conditions – empty while Paperless is not set up or without permission.
      const extras = ctx.isConfigured() ? await ctx.metadata().extras().catch(() => null) : null;
      // Rules from the environment, or the workflows that have the shape of a prompt rule.
      const env = locked();
      const rules: PromptRuleConfig[] = env ? ctx.cfg.processing.promptRules : ruleWorkflows(ctx).map((r) => r.rule);
      const before = ctx.repos.workflows.list({ trigger: 'analysis.before' }).length;
      return {
        otherWorkflows: env ? before : before - rules.length,
        rules: rules.map((rule) => {
          const prompt = rulePrompt(ctx, rule);
          return {
            ...rule,
            promptId: prompt?.id ?? null,
            promptName: prompt?.name ?? null,
            problem: prompt ? null : `The prompt ${typeof rule.prompt === 'number' ? `#${rule.prompt}` : `"${rule.prompt}"`} is not in the prompt library – the rule is skipped`,
          };
        }),
        locked: locked(),
        storagePaths: extras?.storagePaths.map((s) => s.name) ?? [],
        owners: extras?.users.map((u) => u.username) ?? [],
        customFields: ctx.cfg.processing.customFields.map((c) => c.name),
        model: activeModel(ctx.cfg.ai),
      };
    };

    app.get('/api/prompt-rules', { schema: { description: 'Prompt rules: which library prompt and settings a document is analysed with.' } }, info);

    app.put(
      '/api/prompt-rules',
      {
        config: { auth: 'session' },
        schema: {
          description: 'Replace the prompt rules (in order – the first matching rule wins).',
          body: z.object({ rules: z.array(promptRuleSchema).max(50) }),
        },
      },
      async (req) => {
        const env = locked();
        if (env) throw new HttpProblem(409, `The prompt rules are set by the environment variable ${env}`);
        req.body.rules.forEach((rule, index) => {
          if (!rulePrompt(ctx, rule)) throw new HttpProblem(400, `${ruleLabel(rule, index)}: the prompt is not in the prompt library`);
        });
        replaceRuleWorkflows(ctx, req.body.rules, userIdOf(req.access!));
        log.info(`Prompt rules saved (${req.body.rules.length} workflow(s) before the analysis)`);
        return info();
      },
    );

    app.get(
      '/api/prompt-rules/match/:documentId',
      {
        schema: {
          description: 'The prompt rule a document would be analysed with (null: the system prompt).',
          params: z.object({ documentId: z.coerce.number().int().positive() }),
        },
      },
      async (req): Promise<{ rule: MatchedPromptRule | null }> => {
        const doc = await ctx.backend(req.access!).getDocument(req.params.documentId);
        return { rule: describePlan(await planAnalysis(ctx, doc, { record: false })) };
      },
    );
  };
