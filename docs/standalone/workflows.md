# Workflows

← [Overview](README.md)

## 1. Goal

Rules that act on documents automatically: **when** something happens (trigger), **if** the
document matches (conditions), **then** do something (actions). They work in both modes and replace
the prompt rules, which become a special case.

What should make them better than what users know:

* **Visible:** every run is logged with each condition and action, their results and duration.
* **Testable:** dry run against any document, showing exactly what would change.
* **AI-aware:** conditions and actions can ask the AI ("Is this an invoice above 500 €?",
  "Extract the contract end date into the custom field *End date*").
* **Safe:** loop protection, rate limits, attributable changes (change log), undo.

## 2. Model

Shared types in `src/shared/workflows.ts` (zod schema, like `src/shared/promptRules.ts`):

```ts
interface Workflow {
  id: number;
  libraryId: number | null;          // null = global (admins only)
  name: string;
  enabled: boolean;
  position: number;                  // order of evaluation within a trigger
  trigger: Trigger;
  conditions: ConditionGroup;        // all / any, nested
  actions: Action[];
  /** Do not evaluate later workflows of the same trigger for this document (prompt rule semantics). */
  stopAfterMatch: boolean;
  revision: number;
  suspendedReason: string | null;    // e.g. the owner lost access (access-control.md §6)
}
```

## 3. Triggers

| Trigger | Fires | Notes |
| --- | --- | --- |
| `document.added` | after intake (built-in) / webhook or new id in the scan (companion) | filter by channel: upload, api, folder, mail, webdav |
| `analysis.before` | before each AI analysis of a document | only analysis-shaping actions (prompt, settings, model, skip); this is where prompt rules live |
| `document.processed` | after a successful AI analysis | the AI result is available to conditions |
| `document.updated` | after a change of selected fields | not fired by changes of the same workflow run (§7.4) |
| `document.version_added` | new file version (built-in) | |
| `schedule` | cron expression (`croner`, already a dependency) | evaluates a saved filter and runs per matching document (capped) |
| `date.reached` | a date field (document date, custom field, calendar event) ± offset reaches today | daily job; idempotent per (workflow, document, date) |
| `manual` | button on the document, bulk action in the list, API | |

## 4. Conditions

`ConditionGroup = { op: 'all' | 'any'; items: (Condition | ConditionGroup)[] }`

| Condition | Source |
| --- | --- |
| tags any / all / none, correspondent, document type, storage path, owner, custom field set / equals / range | the existing `PromptRuleConditions` |
| library | built-in |
| channel (upload, api, folder, mail, webdav), mail sender / subject, folder path | intake hints |
| file name pattern, MIME type, page count | document |
| text contains / regex (current text) | document text |
| document date range, added within N days | document |
| AI processed yes / no, last analysis failed | processing state |
| **AI question** | `{ question: string, expect: boolean }` → one short structured LLM call (JSON `{ answer: boolean, reason: string }`, temperature 0) |

* Conditions are evaluated cheapest first. AI questions run last and only when everything else
  matched.
* AI answers are cached per (document id, `modified`, question hash), so re-evaluation and dry runs
  do not pay twice. Tokens are recorded in `usage` with feature `workflow`.
* Names are compared like Paperless names today (`normalizeName`).

## 5. Actions

| Action | Effect | Modes |
| --- | --- | --- |
| `set_title` | template, e.g. `{correspondent} – {document_type} {created_year}` | both |
| `add_tags` / `remove_tags` | create when missing (editor rights of the workflow scope) | both |
| `set_correspondent`, `set_document_type`, `set_storage_path` | | both |
| `set_custom_field` | value or template | both |
| `assign_asn` | next free archive serial number in the library | both |
| `set_owner` | | both |
| `move_to_library` | target must be in the workflow's allowed list | built-in |
| `analyze` | with a library prompt, overrides (functions, restrictions, allowed lists) and model – the prompt rule action | both |
| `skip_analysis` | OCR and indexing only | both |
| `run_ocr` | force OCR | both |
| `ai_extract` | question → value into a custom field (typed, normalised like suggestions today) | both |
| `add_calendar_event` | from a date field + offset, with title template | both |
| `notify_email` | SMTP settings (new section `notifications.smtp`), template, recipients (users, groups, addresses) | both |
| `notify_webhook` | POST JSON (document summary, link, changes) with an HMAC signature header; presets for ntfy / Gotify | both |
| `notify_inapp` | notification in the UI for users / groups | both |
| `move_to_trash` | needs an explicit confirmation flag in the editor | both |

* Actions run in order. A failing action stops the run (later actions are skipped, the run is
  `failed`). Writes that succeeded stay and are visible in the change log, and they can be undone
  together (`ref = 'run:<id>'`).
* All field writes of one run are combined into **one** `updateDocument` call where possible
  (one event, one `modified` change).

## 6. Storage

```sql
CREATE TABLE workflows (
  id INTEGER PRIMARY KEY,
  library_id INTEGER REFERENCES libraries(id) ON DELETE CASCADE,   -- NULL = global
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL,
  trigger TEXT NOT NULL,             -- JSON
  conditions TEXT NOT NULL,          -- JSON
  actions TEXT NOT NULL,             -- JSON
  stop_after_match INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  allowed_libraries TEXT,            -- JSON, targets of move_to_library (validated on save)
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  suspended_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE workflow_revisions (    -- every saved version, runs reference (workflow_id, revision)
  workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  definition TEXT NOT NULL,
  saved_by INTEGER,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, revision)
) WITHOUT ROWID;

CREATE TABLE workflow_runs (
  id INTEGER PRIMARY KEY,
  workflow_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  document_id INTEGER,
  trigger TEXT NOT NULL,
  trigger_key TEXT,                  -- idempotency for schedule / date.reached, e.g. '2026-12-01'
  parent_run_id INTEGER,             -- chain depth (§7.4)
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped', 'not_matched')),
  dry_run INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE UNIQUE INDEX workflow_runs_once ON workflow_runs(workflow_id, document_id, trigger_key) WHERE trigger_key IS NOT NULL;
CREATE INDEX workflow_runs_document ON workflow_runs(document_id, id);
CREATE INDEX workflow_runs_workflow ON workflow_runs(workflow_id, id);
CREATE INDEX workflow_runs_queue ON workflow_runs(status, queued_at) WHERE status IN ('queued', 'running');

CREATE TABLE workflow_run_steps (
  run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('condition', 'action')),
  name TEXT NOT NULL,
  status TEXT NOT NULL,              -- matched | not_matched | done | failed | skipped
  details TEXT NOT NULL DEFAULT '{}',-- JSON: values compared, AI answer + reason, patch applied, HTTP status …
  duration_ms INTEGER,
  PRIMARY KEY (run_id, idx)
) WITHOUT ROWID;
```

Run retention: successful runs 90 days, failed runs 1 year (settings).

## 7. Execution

### 7.1 Engine

`src/server/workflows/engine.ts` subscribes to the document event bus
([architecture.md](architecture.md#5-document-event-bus)):

* For each event, the enabled workflows of the matching trigger and of the document's library (plus
  global ones) are selected in `position` order and inserted as `queued` runs.
* A worker loop (concurrency 2, setting) takes queued runs. On start, runs left `running` by a
  crash go back to `queued`. Actions are written so that repeating them is harmless: setting
  fields is idempotent, notifications record their delivery in the step.
* Retries: external actions (webhook, e-mail) up to 3 times with back-off. Field writes are not
  retried. A conflict is reported instead.

### 7.2 Interplay with the processing engine

```
document.added ─▶ workflows (trigger document.added)            e.g. move to library, tags from mail sender
             └─▶ engine job ─▶ analysis.before workflows ─▶ AI analysis ─▶ apply
                                (synchronous, in the job)                 └─▶ document.processed ─▶ workflows
```

* `analysis.before` is evaluated **inside** the processing job, synchronously, exactly where
  `processing/promptRules.ts` is evaluated today. The result is a copy of the processing settings
  (prompt, functions, restrictions, allowed lists, model) or `skip`. Prompt building, planning and
  the calendar use that copy, so nothing else changes.
* For `document.added`, the engine job waits until the workflows of that trigger have finished
  (bounded by a timeout), so a workflow can still move the document or set `skip_analysis` before
  the AI runs.

### 7.3 Templates

`{title}`, `{correspondent}`, `{document_type}`, `{created}`, `{created_year}`, `{created_month}`,
`{added}`, `{field:<name>}`, `{library}`, `{asn}`, `{mail_from}`, `{mail_subject}`, `{filename}`.
Missing values become empty. Values are inserted as text (no expression language, no code).

### 7.4 Loop protection

* Every write of a run carries `ChangeOrigin { actor: 'workflow', actorId: workflowId, runId }`.
* `document.updated` caused by a run does **not** trigger the same workflow again.
* Chains (workflow A's change triggers B) are limited to depth 3 via `parent_run_id`. Deeper runs
  are `skipped` with the reason.
* At most 10 runs per (workflow, document) per hour, more are `skipped` and shown as a warning on
  the workflow.

## 8. Prompt rules become workflows

Migration in M6 (once, when the schema is created):

| Prompt rule | Workflow |
| --- | --- |
| order in `processing.promptRules` | `position` |
| `enabled`, `name` | same |
| `match` (tags any/all, types, correspondents, storage paths, owners, custom field) | `conditions` (all) |
| `prompt` + `overrides` (functions, custom fields, restrictions, allowed lists, model) | action `analyze` |
| first matching rule wins | `trigger = analysis.before`, `stopAfterMatch = true` |

* `history.prompt_id / prompt_name` keep working. Runs also link to the history entry.
* Rules pinned by the environment variable (`PromptRulesInfo.locked`) become read-only workflows
  generated at start-up and are not stored.
* A webhook/API `prompt` still skips them, as today.
* The prompt rules page stays as a simplified view on `analysis.before` workflows (open question Q2).
* Test: the existing `test/integration/promptRules.test.ts` cases run against the migrated
  workflows and must give the same results.

## 9. Companion mode

* Triggers come from the event bus as described in the architecture. Changes made directly in
  Paperless-ngx are seen with the scan delay.
* Actions write through the Paperless-ngx API. `move_to_library` and version triggers are not
  available (capabilities).
* Paperless-ngx has workflows of its own (consumption, added, updated). The UI explains the
  difference. Paperless-ngx workflows act at consumption time, Paperless-AI workflows can use the
  AI result and AI conditions. Both writing the same field is a configuration error the dry run
  makes visible.

## 10. UI

* **Workflows page:** list per library (+ global), drag to reorder, enable / disable, last run
  status, runs in the last 7 days, warnings (suspended, rate limited, failing).
* **Editor:** three columns *When* / *If* / *Then*. The condition builder reuses the components of
  the prompt rules editor (`src/web/components/promptRules.tsx`), and the analysis action reuses
  its overrides form.
* **Dry run:** pick a document (document picker) → shows each condition with the compared values,
  the AI answer with its reason, and the resulting patch as a diff. Nothing is written. AI
  conditions are really evaluated (tokens shown).
* **Run log:** per workflow and per document (Document → Activity tab, merged with the change log),
  with each step's details. Failed runs can be re-run.
* **Bulk:** "Run workflow…" on a selection in the document list (manual trigger).

## 11. Tests

* Unit: condition evaluation (all types, nesting), templates, loop protection, idempotency keys.
* Integration (mock LLM, mock Paperless and built-in): trigger → run → change log, `analysis.before`
  shaping the prompt, AI condition caching, crash recovery of `running` runs, webhook retries,
  the prompt rules migration giving identical results.

## 12. Implementation notes (M6)

Code: `src/shared/workflows.ts` (types), `src/server/workflows/` (`schema.ts`, `storage.ts`,
`evaluate.ts`, `actions.ts`, `notify.ts`, `analysis.ts`, `promptRules.ts`, `engine.ts`),
`src/server/routes/workflows.ts`, `src/web/pages/Workflows.tsx`, `src/web/components/workflowEditor.tsx`.
Tests: `test/integration/workflows.test.ts`, `test/integration/promptRules.test.ts` (unchanged,
now running on workflows), E2E "builds a workflow, tests it and runs it".

Decisions made while building it:

* **Prompt rules:** rules in `config.json` (older versions, or anything that writes them there) are
  moved into workflows when the app starts or the configuration changes, then removed from the
  configuration. `/api/prompt-rules` is a view on the global `analysis.before` workflows that have
  the rule shape; others are counted (`otherWorkflows`) and edited on the Workflows page. Rules from
  `PROMPT_RULES` stay virtual and read-only (negative ids).
* **Runs of `analysis.before`** are recorded only when they matched (they would otherwise create a
  row per workflow for every analysis). Runs that did not match are kept 7 days, successful ones 90,
  failed ones 365 (`workflows.*RetentionDays`).
* **Order:** runs of one document are taken one after the other (the queue never runs two runs of a
  document at the same time); "stop after a match" skips the queued runs of the same event.
* **Manual runs** work for every workflow, whatever its trigger (button on the document, bulk
  action "Workflow…", `POST /api/workflows/:id/run`).
* **Undo of a run:** built-in archive – its change log entries (`ref = run:<id>`) are undone
  together; companion mode – the change is in the History (source `workflow`) and undone there.
* **Rights:** global workflows – administrators; library workflows – owners. Webhooks only by
  administrators (requests to the network of the server). Notifications reach only people who may
  read the document. A workflow whose creator is no longer an owner is suspended at its next run.
* **AI:** questions and extraction send the title, correspondent, type, date and up to ~6,000
  tokens of the text; the answers are cached per document version and question. Tested against
  the OpenAI API (gpt-5-mini): open invoices above 50 € recognised, a paid café receipt and a
  termination letter rejected with reasons, the amount extracted into a monetary field.
* Not in this version: drag and drop in the list (up/down buttons instead), a library list per
  mail rule, IMAP IDLE.
