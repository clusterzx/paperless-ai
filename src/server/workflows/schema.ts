/**
 * Validation of workflow definitions (API input and stored JSON). The types are the shared ones in
 * src/shared/workflows.ts; the checks at the end keep both in step.
 */
import { z } from 'zod';
import { Cron } from 'croner';
import { promptRuleSchema } from '../config/schema.js';
import { EVENT_KINDS } from '../../shared/api.js';
import { INTAKE_CHANNELS, type Action, type Condition, type ConditionGroup, type Trigger, type WorkflowDefinition } from '../../shared/workflows.js';

const names = z.array(z.string().trim().min(1).max(200)).max(200).default([]);
const text = (max = 2000) => z.string().max(max);
const channel = z.enum(INTAKE_CHANNELS);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ids = z.array(z.number().int().positive()).max(200).default([]);

const cron = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (v) => {
      try {
        new Cron(v, { paused: true }).stop();
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Not a valid cron expression' },
  );

export const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('document.added'), channels: z.array(channel).max(20).optional() }),
  z.object({ type: z.literal('analysis.before') }),
  z.object({ type: z.literal('document.processed') }),
  z.object({ type: z.literal('document.updated'), fields: z.array(z.string().max(64)).max(30).optional() }),
  z.object({ type: z.literal('document.version_added') }),
  z.object({ type: z.literal('schedule'), cron, query: text(500).optional(), tags: z.array(z.string().max(200)).max(50).optional(), limit: z.number().int().min(1).max(5000).optional() }),
  z.object({ type: z.literal('date.reached'), source: z.enum(['created', 'custom_field', 'calendar']), field: z.string().max(200).optional(), offsetDays: z.number().int().min(-3650).max(3650) }),
  z.object({ type: z.literal('manual') }),
]);

export const conditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tags'), mode: z.enum(['any', 'all', 'none']), names }),
  z.object({ type: z.literal('correspondent'), names }),
  z.object({ type: z.literal('document_type'), names }),
  z.object({ type: z.literal('storage_path'), names }),
  z.object({ type: z.literal('owner'), names }),
  z.object({ type: z.literal('custom_field'), name: z.string().trim().min(1).max(200), op: z.enum(['set', 'equals', 'gte', 'lte']), value: text(500).optional() }),
  z.object({ type: z.literal('library'), ids }),
  z.object({ type: z.literal('channel'), channels: z.array(channel).max(20) }),
  z.object({ type: z.literal('mail_from'), contains: text(500) }),
  z.object({ type: z.literal('mail_subject'), contains: text(500) }),
  z.object({ type: z.literal('folder_path'), contains: text(1000) }),
  z.object({ type: z.literal('filename'), pattern: text(500) }),
  z.object({ type: z.literal('mime_type'), types: z.array(z.string().max(100)).max(50) }),
  z.object({ type: z.literal('page_count'), min: z.number().int().min(0).optional(), max: z.number().int().min(0).optional() }),
  z
    .object({ type: z.literal('text'), contains: text(1000).optional(), regex: text(500).optional() })
    .refine((c) => {
      if (!c.regex) return true;
      try {
        new RegExp(c.regex, 'iu');
        return true;
      } catch {
        return false;
      }
    }, 'Not a valid regular expression'),
  z.object({ type: z.literal('created'), from: day.optional(), to: day.optional() }),
  z.object({ type: z.literal('added_within'), days: z.number().int().min(0).max(36500) }),
  z.object({ type: z.literal('processed'), value: z.boolean() }),
  z.object({ type: z.literal('analysis_failed'), value: z.boolean() }),
  z.object({ type: z.literal('ai_question'), question: z.string().trim().min(3).max(1000), expect: z.boolean() }),
]);

export const conditionGroupSchema: z.ZodType<ConditionGroup> = z.lazy(() =>
  z.object({ op: z.enum(['all', 'any']), items: z.array(z.union([conditionSchema, conditionGroupSchema])).max(50) }),
);

const template = text(1000);
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_title'), template: z.string().trim().min(1).max(500) }),
  z.object({ type: z.literal('add_tags'), names: names.refine((n) => n.length > 0, 'At least one tag') }),
  z.object({ type: z.literal('remove_tags'), names: names.refine((n) => n.length > 0, 'At least one tag') }),
  z.object({ type: z.literal('set_correspondent'), name: z.string().trim().max(200).nullable() }),
  z.object({ type: z.literal('set_document_type'), name: z.string().trim().max(200).nullable() }),
  z.object({ type: z.literal('set_storage_path'), name: z.string().trim().max(200).nullable() }),
  z.object({ type: z.literal('set_custom_field'), name: z.string().trim().min(1).max(200), value: template }),
  z.object({ type: z.literal('assign_asn') }),
  z.object({ type: z.literal('set_owner'), username: z.string().trim().max(200).nullable() }),
  z.object({ type: z.literal('move_to_library'), libraryId: z.number().int().positive() }),
  z.object({ type: z.literal('analyze'), prompt: z.union([z.number().int().positive(), z.string().trim().min(1).max(200)]).nullable(), overrides: promptRuleSchema.shape.overrides }),
  z.object({ type: z.literal('skip_analysis') }),
  z.object({ type: z.literal('run_ocr') }),
  z.object({ type: z.literal('ai_extract'), question: z.string().trim().min(3).max(1000), field: z.string().trim().min(1).max(200) }),
  z.object({
    type: z.literal('add_calendar_event'),
    source: z.enum(['created', 'custom_field']),
    field: z.string().max(200).optional(),
    offsetDays: z.number().int().min(-3650).max(3650),
    title: z.string().trim().min(1).max(300),
    kind: z.enum(EVENT_KINDS),
  }),
  z.object({
    type: z.literal('notify_email'),
    to: z.array(z.email().max(300)).max(50).default([]),
    users: ids,
    groups: ids,
    subject: z.string().trim().min(1).max(300),
    body: template,
  }),
  z.object({ type: z.literal('notify_webhook'), url: z.url({ protocol: /^https?$/ }).max(2000), preset: z.enum(['generic', 'ntfy', 'gotify']).default('generic'), secret: z.string().max(500).optional() }),
  z.object({ type: z.literal('notify_inapp'), users: ids, groups: ids, title: z.string().trim().min(1).max(300), body: template }),
  z.object({ type: z.literal('move_to_trash'), confirm: z.boolean() }),
]);

export const workflowDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    enabled: z.boolean().default(true),
    libraryId: z.number().int().positive().nullable().default(null),
    trigger: triggerSchema,
    conditions: conditionGroupSchema.default({ op: 'all', items: [] }),
    actions: z.array(actionSchema).max(30).default([]),
    stopAfterMatch: z.boolean().default(false),
    allowedLibraries: z.array(z.number().int().positive()).max(200).default([]),
  })
  .superRefine((w, ctx) => {
    if (w.trigger.type === 'analysis.before') {
      const bad = w.actions.filter((a) => a.type !== 'analyze' && a.type !== 'skip_analysis');
      if (bad.length) ctx.addIssue({ code: 'custom', path: ['actions'], message: `Before the analysis only "analyze" and "skip analysis" are possible (not ${bad.map((a) => a.type).join(', ')})` });
    }
    w.actions.forEach((a, i) => {
      if (a.type === 'move_to_trash' && !a.confirm) ctx.addIssue({ code: 'custom', path: ['actions', i, 'confirm'], message: 'Moving to the trash needs the confirmation' });
      if (a.type === 'move_to_library' && !w.allowedLibraries.includes(a.libraryId)) {
        ctx.addIssue({ code: 'custom', path: ['actions', i, 'libraryId'], message: 'The target library must be in the allowed libraries of the workflow' });
      }
    });
  });

// The schemas describe the shared types.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const checks: [Same<z.output<typeof triggerSchema>, Trigger>, Same<z.output<typeof conditionSchema>, Condition>] = [true, true];
void checks;
const actionCheck = (a: z.output<typeof actionSchema>): Action => a;
const definitionCheck = (w: z.output<typeof workflowDefinitionSchema>): WorkflowDefinition => w;
void actionCheck;
void definitionCheck;
