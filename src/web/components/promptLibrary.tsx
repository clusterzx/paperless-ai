import { useEffect, useId, useState } from 'react';
import { Star } from 'lucide-react';
import type { LibraryPrompt, PromptLibrary } from '@shared/api';
import { Badge, Button, Field, Input, Modal, Textarea, useToast } from './ui';
import { errorMessage, post } from '../lib/api';
import { cn } from '../lib/format';

/** Where earlier versions of the prompt playground kept rated prompts (browser only). */
const LEGACY_KEY = 'pai-saved-prompts';

/** Move prompts saved in this browser by the old playground into the library (once). */
export async function importLegacyPrompts(): Promise<number> {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null');
  } catch {
    saved = null;
  }
  if (!Array.isArray(saved) || !saved.length) return 0;
  const res = await post<{ imported: number }>('/api/prompts/import', { prompts: saved.slice(0, 200) });
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // storage blocked – the import is idempotent (same text is never added twice)
  }
  return res.imported;
}

export function ScoreBadge({ score, count }: { score: number | null; count?: number }) {
  if (score === null) return <Badge>Not rated</Badge>;
  return (
    <Badge tone="warn" title={count !== undefined ? `${count} rating${count === 1 ? '' : 's'}` : undefined}>
      <Star className="size-3 fill-current" /> {score.toFixed(1).replace(/\.0$/, '')}/10
      {count !== undefined && count > 1 && <span className="font-normal opacity-80">· {count}×</span>}
    </Badge>
  );
}

/** 1–10 stars; clicking the selected star again clears the rating (0 = no rating). */
export function ScorePicker({ value, onChange, optional }: { value: number; onChange: (v: number) => void; optional?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Rating">
      {Array.from({ length: 10 }, (_, i) => (
        <button
          key={i}
          type="button"
          role="radio"
          aria-checked={value === i + 1}
          aria-label={`${i + 1} of 10`}
          onClick={() => onChange(optional && value === i + 1 ? 0 : i + 1)}
        >
          <Star className={cn('size-6', i < value ? 'fill-warn text-warn' : 'text-border-strong')} />
        </button>
      ))}
      <span className="ml-2 text-sm text-muted">{value ? `${value}/10` : 'no rating'}</span>
    </div>
  );
}

export interface SavePromptDefaults {
  name?: string;
  useCase?: string;
  provider?: string;
  model?: string;
  score?: number;
}

/** Keep a prompt in the library – with a rating for the model it was tested with. */
export function SavePromptModal({
  open,
  onClose,
  prompt,
  wizard,
  documents = [],
  useCases,
  defaults,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  prompt: string;
  /** Prompt wizard answers the prompt was made with. */
  wizard?: Record<string, unknown>;
  /** Documents of the test run. */
  documents?: number[];
  useCases: string[];
  defaults: SavePromptDefaults;
  onSaved?: (saved: { prompt: LibraryPrompt; created: boolean }) => void;
}) {
  const toast = useToast();
  const listId = useId();
  const [form, setForm] = useState({ name: '', useCase: '', score: 0, model: '', note: '' });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setForm({ name: defaults.name ?? '', useCase: defaults.useCase ?? '', score: defaults.score ?? 0, model: defaults.model ?? '', note: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = async () => {
    setSaving(true);
    try {
      // A model typed by hand has no known provider; an empty field means the model in use.
      const model = form.model.trim();
      const saved = await post<{ prompt: LibraryPrompt; created: boolean }>('/api/prompts', {
        name: form.name.trim() || 'Untitled prompt',
        useCase: form.useCase,
        prompt,
        wizard,
        rating: form.score
          ? { score: form.score, note: form.note, documents, model: model || undefined, provider: !model ? undefined : model === defaults.model ? defaults.provider : '' }
          : undefined,
      });
      toast.success(saved.created ? 'Prompt saved in the library' : `Rating added to “${saved.prompt.name}” – the same prompt is already in the library`);
      onSaved?.(saved);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save in the prompt library"
      footer={
        <Button variant="primary" loading={saving} onClick={save} disabled={!prompt.trim()}>
          Save
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Invoices with short titles" maxLength={120} />
          </Field>
          <Field label="Use case" hint="Pick one or type your own.">
            <Input list={listId} value={form.useCase} onChange={(e) => setForm((f) => ({ ...f, useCase: e.target.value }))} placeholder="General" maxLength={60} />
            <datalist id={listId}>
              {useCases.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </Field>
        </div>
        <Field label="How well did it work?" hint="Optional – you can rate it later, also with other models.">
          <ScorePicker value={form.score} onChange={(score) => setForm((f) => ({ ...f, score }))} optional />
        </Field>
        {form.score > 0 && (
          <>
            <Field label="Tested with model">
              <Input value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} maxLength={200} />
            </Field>
            <Field label="Note">
              <Textarea rows={3} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="What worked well, what did not?" maxLength={2000} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Rate a prompt of the library (again), e.g. after testing it with another model. */
export function RatePromptModal({
  prompt,
  library,
  onClose,
  onRated,
}: {
  prompt: LibraryPrompt | null;
  library: Pick<PromptLibrary, 'current'> | undefined;
  onClose: () => void;
  onRated: (p: LibraryPrompt) => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({ score: 7, model: '', note: '' });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (prompt) setForm({ score: 7, model: library?.current.model ?? '', note: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt?.id]);

  const save = async () => {
    if (!prompt) return;
    setSaving(true);
    try {
      const model = form.model.trim();
      const rated = await post<LibraryPrompt>(`/api/prompts/${prompt.id}/ratings`, {
        score: form.score,
        note: form.note,
        model: model || undefined,
        provider: model === library?.current.model ? library.current.provider : model ? '' : undefined,
      });
      toast.success('Rating saved');
      onRated(rated);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={Boolean(prompt)}
      onClose={onClose}
      title={prompt ? `Rate “${prompt.name}”` : 'Rate'}
      footer={
        <Button variant="primary" loading={saving} onClick={save}>
          Save rating
        </Button>
      }
    >
      <div className="space-y-4">
        <ScorePicker value={form.score} onChange={(score) => setForm((f) => ({ ...f, score }))} />
        <Field label="Model" hint="The model the prompt was tested with.">
          <Input value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} maxLength={200} />
        </Field>
        <Field label="Note">
          <Textarea rows={3} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="What worked well, what did not?" maxLength={2000} />
        </Field>
      </div>
    </Modal>
  );
}
