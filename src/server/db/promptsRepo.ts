import type { Db } from './database.js';

export interface PromptRow {
  id: number;
  name: string;
  use_case: string;
  prompt: string;
  wizard: string | null;
  created_at: number;
  updated_at: number;
}

export interface PromptRatingRow {
  id: number;
  prompt_id: number;
  provider: string;
  model: string;
  score: number;
  note: string;
  documents: string | null;
  created_at: number;
}

export interface NewPrompt {
  name: string;
  useCase: string;
  prompt: string;
  /** Prompt wizard answers (stored as JSON). */
  wizard?: Record<string, unknown> | null;
}

export interface NewRating {
  provider: string;
  model: string;
  score: number;
  note: string;
  documents: number[];
  createdAt?: number;
}

/** The prompt library: prompts with the use case they were written for and their ratings per model. */
export class PromptsRepo {
  constructor(private readonly db: Db) {}

  list(): PromptRow[] {
    return this.db.prepare('SELECT * FROM prompts ORDER BY updated_at DESC, id DESC').all() as PromptRow[];
  }

  get(id: number): PromptRow | undefined {
    return this.db.prepare('SELECT * FROM prompts WHERE id = ?').get(id) as PromptRow | undefined;
  }

  /** A prompt with the same text (ignoring surrounding whitespace). */
  findByText(prompt: string): PromptRow | undefined {
    return this.list().find((p) => p.prompt.trim() === prompt.trim());
  }

  ratings(): PromptRatingRow[] {
    return this.db.prepare('SELECT * FROM prompt_ratings ORDER BY created_at DESC, id DESC').all() as PromptRatingRow[];
  }

  create(p: NewPrompt, createdAt = Date.now()): number {
    return Number(
      this.db
        .prepare('INSERT INTO prompts (name, use_case, prompt, wizard, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(p.name, p.useCase, p.prompt, p.wizard ? JSON.stringify(p.wizard) : null, createdAt, createdAt).lastInsertRowid,
    );
  }

  /** Changing the text keeps the ratings – they are shown with their date. */
  update(id: number, patch: Partial<Pick<NewPrompt, 'name' | 'useCase' | 'prompt'>>): boolean {
    const row = this.get(id);
    if (!row) return false;
    this.db
      .prepare('UPDATE prompts SET name = ?, use_case = ?, prompt = ?, updated_at = ? WHERE id = ?')
      .run(patch.name ?? row.name, patch.useCase ?? row.use_case, patch.prompt ?? row.prompt, Date.now(), id);
    return true;
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM prompts WHERE id = ?').run(id).changes > 0;
  }

  addRating(promptId: number, r: NewRating): number {
    const now = r.createdAt ?? Date.now();
    const id = Number(
      this.db
        .prepare('INSERT INTO prompt_ratings (prompt_id, provider, model, score, note, documents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(promptId, r.provider, r.model, r.score, r.note, r.documents.length ? JSON.stringify(r.documents) : null, now).lastInsertRowid,
    );
    this.db.prepare('UPDATE prompts SET updated_at = MAX(updated_at, ?) WHERE id = ?').run(now, promptId);
    return id;
  }

  deleteRating(promptId: number, ratingId: number): boolean {
    return this.db.prepare('DELETE FROM prompt_ratings WHERE id = ? AND prompt_id = ?').run(ratingId, promptId).changes > 0;
  }
}
