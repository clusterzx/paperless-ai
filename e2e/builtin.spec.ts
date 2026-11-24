/**
 * End-to-end test of the built-in archive: setup without Paperless-ngx, upload, the document page,
 * trash. Runs against its own demo server (playwright.builtin.config.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { makePdf } from '../test/helpers/pdf.js';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => localStorage.setItem('pai-support-snoozed-until', String(Date.now() + 86_400_000)));
});

const USER = 'owner';
const PASSWORD = 'e2e-password-123';

async function login(page: Page) {
  const home = page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening|night)/ });
  await page.goto('/login');
  // Every test signs in: the sign-in rate limit can answer "retry in N seconds" – then wait and retry.
  for (let attempt = 0; attempt < 3 && page.url().endsWith('/login'); attempt++) {
    await page.fill('#username', USER);
    await page.fill('#password', PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    const limited = page.getByRole('alert').filter({ hasText: /Rate limit exceeded/ });
    await expect(home.or(limited)).toBeVisible();
    if (await home.isVisible()) return;
    const seconds = Number(/retry in (\d+)/.exec((await limited.textContent()) ?? '')?.[1] ?? 30);
    await page.waitForTimeout((seconds + 1) * 1000);
  }
  await expect(home).toBeVisible();
}

test('setup wizard sets up the built-in archive', async ({ page, request }) => {
  const info = (await (await request.get('/__demo/info')).json()) as { llmUrl: string };
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel('Username').fill(USER);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('radio', { name: /Built-in archive/ }).click();
  await page.getByLabel('Name of the first library').fill('Familie');
  await page.getByRole('button', { name: 'Continue' }).click();

  // No Paperless-ngx step.
  await page.getByRole('radio', { name: /OpenAI-compatible/ }).click();
  await page.getByPlaceholder('https://api.example.com/v1').fill(info.llmUrl);
  await page.getByPlaceholder('deepseek-chat').fill('mock-gpt');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/Built-in · library “Familie”/)).toBeVisible();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening|night)/ })).toBeVisible();
});

test('uploads a document, which is stored, read and analysed', async ({ page }) => {
  await login(page);
  await page.goto('/inbox');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'stromrechnung.pdf',
    mimeType: 'application/pdf',
    buffer: makePdf([['Stadtwerke München GmbH', 'Stromrechnung Nr. SR-2024-0315', 'Gesamtbetrag: 84,20 EUR']]),
  });
  // The upload of this session: sent, stored in the background, then linked.
  const open = page.getByRole('link', { name: 'Open', exact: true });
  await expect(open).toBeVisible();
  await expect(page.getByText('1 of 1 stored')).toBeVisible();
  await open.click();
  await expect(page).toHaveURL(/\/documents\/\d+$/);
  await page.getByRole('tab', { name: 'Text' }).click();
  await expect(page.getByRole('textbox', { name: 'Text of the document' })).toHaveValue(/Stromrechnung Nr\. SR-2024-0315/);
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByText('Added to the archive')).toBeVisible();
});

test('deletes to the trash and restores', async ({ page }) => {
  await login(page);
  await page.goto('/documents');
  await page.getByRole('link').filter({ hasText: /SR-2024-0315|stromrechnung/i }).first().click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.goto('/trash');
  await expect(page.getByText(/deleted/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Restore', exact: true }).first().click();
  await expect(page.getByText('The trash is empty')).toBeVisible();
});

test('adds a version, compares the texts, switches back with undo', async ({ page }) => {
  await login(page);
  await page.goto('/documents');
  await page.getByRole('link').filter({ hasText: /SR-2024-0315|stromrechnung/i }).first().click();
  await page.getByRole('tab', { name: /^Versions/ }).click();
  await page.getByLabel('File of the new version').setInputFiles({
    name: 'stromrechnung-korrigiert.pdf',
    mimeType: 'application/pdf',
    buffer: makePdf([['Stadtwerke München GmbH', 'Stromrechnung Nr. SR-2024-0315 (Korrektur)', 'Gesamtbetrag: 79,90 EUR']]),
  });
  await page.getByLabel('Comment (optional)').fill('korrigierte Rechnung');
  await page.getByRole('button', { name: 'Add version' }).click();
  await expect(page.getByText('korrigierte Rechnung')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Versions (2)' })).toBeVisible();

  await page.getByRole('button', { name: 'Compare' }).click();
  const diff = page.getByLabel('Text differences');
  await expect(diff).toContainText('79,90 EUR');
  await expect(diff).toContainText('84,20 EUR');

  // The new version is undone from the activity: version 1 is current again.
  await page.getByRole('tab', { name: 'Activity' }).click();
  const added = page.getByRole('listitem').filter({ hasText: 'New version' });
  await added.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Undo' }).click();
  await expect(added.getByText('undone')).toBeVisible();
  await page.getByRole('tab', { name: 'Text' }).click();
  await expect(page.getByRole('textbox', { name: 'Text of the document' })).toHaveValue(/84,20 EUR/);
});

test('creates a library and adds a member with a role', async ({ page }) => {
  await login(page);
  // A second account to add as a member.
  expect((await page.request.post('/api/users', { data: { username: 'kim', password: 'kim-password-123', role: 'member' } })).ok()).toBe(true);
  await page.goto('/libraries');
  await expect(page.getByText('Familie')).toBeVisible();
  await page.getByRole('button', { name: 'New library' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Verein');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('dialog', { name: 'Verein' })).toBeVisible();
  await page.getByRole('tab', { name: 'Members' }).click();
  await page.getByLabel('Add').selectOption({ label: 'kim' });
  await page.getByLabel('Role', { exact: true }).selectOption('editor');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Save members' }).click();
  await expect(page.getByText('Members saved')).toBeVisible();
  await expect(page.getByLabel('Role of kim')).toHaveValue('editor');
});

test('sets the default library for uploads and limits an API key to a library', async ({ page }) => {
  await login(page);
  await page.goto('/settings?tab=account');
  await page.getByLabel('Default library').selectOption({ label: 'Verein' });
  await expect(page.getByText('Default library saved')).toBeVisible();
  await page.goto('/inbox');
  await expect(page.getByLabel('Library').locator('option').first()).toHaveText('Default (Verein)');

  await page.goto('/settings?tab=keys');
  await page.getByRole('button', { name: 'New key' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Scanner');
  await dialog.getByLabel('Upload documents').check();
  await dialog.getByLabel('Familie').check();
  await dialog.getByRole('button', { name: 'Create key' }).click();
  await expect(dialog.getByText('Copy the key now')).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  const row = page.getByRole('listitem').filter({ hasText: 'Scanner' });
  await expect(row.getByText('Familie')).toBeVisible();
  // Back to the oldest library, so the following tests upload where they expect.
  await page.goto('/settings?tab=account');
  await page.getByLabel('Default library').selectOption({ index: 0 });
  await expect(page.getByText('Default library saved')).toBeVisible();
});

test('builds a workflow, tests it and runs it on a document', async ({ page }) => {
  await login(page);
  await page.goto('/workflows/new');
  await page.getByLabel('Name', { exact: true }).fill('Strom markieren');
  await page.getByLabel('Trigger', { exact: true }).selectOption('manual');
  await page.getByLabel('Condition to add').selectOption('text');
  await page.getByRole('button', { name: 'Add condition' }).click();
  await page.getByLabel('Text contains').fill('Stadtwerke');
  await page.getByLabel('Action to add').selectOption('add_tags');
  await page.getByRole('button', { name: 'Add action' }).click();
  await page.getByRole('region', { name: 'Then' }).getByRole('combobox', { name: 'Add…' }).fill('Energie');
  await page.getByRole('region', { name: 'Then' }).getByRole('combobox', { name: 'Add…' }).press('Enter');

  // Dry run: nothing is written, the planned change is shown.
  await page.getByRole('button', { name: 'Test with a document' }).click();
  await page.getByRole('dialog').getByText(/SR-2024-0315|stromrechnung/i).first().click();
  await expect(page.getByText('The workflow applies')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Add tags Energie')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Save workflow' }).click();
  await expect(page.getByText('Workflow saved')).toBeVisible();
  await page.goto('/workflows');
  await expect(page.getByRole('link', { name: /Strom markieren/ })).toBeVisible();

  // Run it from the document page.
  await page.goto('/documents');
  await page.getByRole('link').filter({ hasText: /SR-2024-0315|stromrechnung/i }).first().click();
  await page.getByRole('button', { name: 'Workflow', exact: true }).click();
  await page.getByRole('dialog').getByRole('listitem').filter({ hasText: 'Strom markieren' }).getByRole('button', { name: 'Run' }).click();
  await expect(page.getByText(/started for 1 document/)).toBeVisible();
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByText('Workflow “Strom markieren” ran')).toBeVisible({ timeout: 15_000 });
});

test('the dashboard follows new documents without a reload', async ({ page }) => {
  await login(page);
  const tile = page.getByText(/^\d+ of \d+ documents$/);
  await expect(tile).toBeVisible();
  const before = Number(/of (\d+)/.exec((await tile.textContent()) ?? '')?.[1]);
  const res = await page.request.post('/api/documents/upload', {
    multipart: { file: { name: 'wasserrechnung.pdf', mimeType: 'application/pdf', buffer: makePdf([['Stadtwerke Wasserrechnung 2024', 'Betrag: 31,50 EUR']]) } },
  });
  expect(res.ok(), await res.text()).toBe(true);
  // The tiles used to be reloaded only every minute while the processing card counted live.
  await expect(tile).toHaveText(new RegExp(`^${before + 1} of ${before + 1} documents$`), { timeout: 15_000 });
});

test('shows a correspondent the AI created after the lists were loaded', async ({ page }) => {
  await login(page);
  // Open a document: the app loads (and caches) the lists of tags and correspondents.
  const list = (await (await page.request.get('/api/documents?pageSize=1')).json()) as { results: { id: number }[] };
  await page.goto(`/documents/${list.results[0].id}`);
  await expect(page.getByLabel('Correspondent')).toBeVisible();
  const res = await page.request.post('/api/documents/upload', {
    multipart: { file: { name: 'bfj.pdf', mimeType: 'application/pdf', buffer: makePdf([['Bundesamt für Justiz', 'Zahlungsbestätigung über 13,00 EUR']]) } },
  });
  const id = ((await res.json()) as { results: { documentId: number }[] }).results[0].documentId;
  await expect.poll(async () => ((await (await page.request.get(`/api/documents/${id}`)).json()) as { correspondent: number | null }).correspondent, { timeout: 15_000 }).not.toBeNull();
  // Within the app (no reload): the cached lists do not know the new correspondent yet.
  await page.evaluate(`history.pushState(null, '', '/documents/${id}'); dispatchEvent(new PopStateEvent('popstate'));`);
  await expect(page.getByLabel('Correspondent')).toHaveValue('Bundesamt für Justiz');
});

test('finds duplicate correspondents and merges them under one name', async ({ page }) => {
  await login(page);
  for (const name of ['ADAC Versicherung', 'ADAC Versicherung AG', 'Stadtwerke Bonn', 'Stadtwerke Essen']) {
    const res = await page.request.post('/api/correspondents', { data: { name } });
    expect(res.ok(), `${name}: ${await res.text()}`).toBe(true);
  }
  await page.goto('/metadata?kind=correspondents');
  await page.getByRole('button', { name: 'Find duplicates' }).click();
  await expect(page.getByText('ADAC Versicherung AG · 0')).toBeVisible();
  await expect(page.getByLabel('Name for ADAC Versicherung, ADAC Versicherung AG')).toHaveValue('ADAC Versicherung');
  // Different Stadtwerke are no duplicates.
  await expect(page.getByText(/Stadtwerke Bonn · /)).toHaveCount(0);
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(page.getByText(/Merged into “ADAC Versicherung”/)).toBeVisible();
  await expect(page.getByText('No duplicates found')).toBeVisible();
  await expect(page.locator('li').filter({ hasText: /^ADAC Versicherung AG/ })).toHaveCount(0);
});

test('searches with tag:, title: … and completes names', async ({ page }) => {
  await login(page);
  const res = await page.request.post('/api/documents/upload', {
    multipart: { file: { name: 'urlaub.pdf', mimeType: 'application/pdf', buffer: makePdf([['Buchungsbestätigung Ferienhaus Ostsee']]) }, tags: 'Urlaubsreise', skipAnalysis: 'true', title: 'Ferienhaus Ostsee' },
  });
  expect(res.ok(), await res.text()).toBe(true);
  await page.goto('/documents');
  const box = page.getByRole('combobox', { name: 'Search documents' });
  // A key is offered while typing it …
  await box.fill('corr');
  await expect(page.getByRole('option', { name: /correspondent:/ })).toBeVisible();
  // … and names after it.
  await box.fill('tag:urlaub');
  await page.getByRole('option', { name: /Urlaubsreise/ }).click();
  await expect(box).toHaveValue('tag:Urlaubsreise ');
  await expect(page.getByLabel('Search understood as')).toContainText('tag:Urlaubsreise');
  await expect(page.getByText('Ferienhaus Ostsee').first()).toBeVisible();
  await expect(page.getByText('Stromrechnung')).toHaveCount(0);
  // A name that does not exist says so.
  await box.fill('tag:gibtesnicht');
  await expect(page.getByLabel('Search understood as')).toContainText('No tag “gibtesnicht”');
});

test('shows a monetary field as amount and currency and saves it in the stored form', async ({ page }) => {
  await login(page);
  const list = (await (await page.request.get('/api/documents?limit=1')).json()) as { results: { id: number; library_id: number }[] };
  const doc = list.results[0];
  expect((await page.request.post('/api/custom-fields', { data: { name: 'Rechnungssumme', dataType: 'monetary', currency: 'EUR', libraryId: doc.library_id } })).ok()).toBe(true);
  expect((await page.request.patch(`/api/documents/${doc.id}`, { data: { customFields: [{ field_name: 'Rechnungssumme', value: 'EUR134.89' }] } })).ok()).toBe(true);

  await page.goto(`/documents/${doc.id}`);
  const amount = page.getByLabel('Rechnungssumme', { exact: true });
  await expect(amount).toHaveValue('134.89'); // the browser's notation (en-US here), not "EUR134.89"
  await expect(page.getByLabel('Currency of Rechnungssumme')).toHaveValue('EUR');
  await amount.fill('150,5'); // German notation is understood as well
  await page.getByLabel('Currency of Rechnungssumme').selectOption('USD');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  const saved = (await (await page.request.get(`/api/documents/${doc.id}`)).json()) as { custom_fields: { value: unknown }[] };
  expect(saved.custom_fields.map((f) => f.value)).toContain('USD150.50');
  await page.reload();
  await expect(page.getByLabel('Rechnungssumme', { exact: true })).toHaveValue('150.50');
  await expect(page.getByLabel('Currency of Rechnungssumme')).toHaveValue('USD');
});

test('sorts tags by name and by number of documents', async ({ page }) => {
  await login(page);
  for (const [name, text] of [
    ['mmm-sort', 'Sortiertest eins'],
    ['mmm-sort,zzz-sort', 'Sortiertest zwei'],
  ]) {
    const res = await page.request.post('/api/documents/upload', {
      multipart: { file: { name: `${text}.pdf`, mimeType: 'application/pdf', buffer: makePdf([[text]]) }, tags: name, skipAnalysis: 'true' },
    });
    expect(res.ok(), await res.text()).toBe(true);
  }
  expect((await page.request.post('/api/tags', { data: { name: 'aaa-sort' } })).ok()).toBe(true);
  await page.goto('/metadata?kind=tags');
  await page.getByLabel('Find').fill('-sort');
  const order = async () =>
    (await page.getByRole('checkbox', { name: /^Select .*-sort$/ }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!.replace('Select ', ''))));
  await expect.poll(order).toEqual(['aaa-sort', 'mmm-sort', 'zzz-sort']);
  await page.getByRole('button', { name: /^Sort by name/ }).click();
  await expect.poll(order).toEqual(['zzz-sort', 'mmm-sort', 'aaa-sort']);
  await page.getByRole('button', { name: /^Sort by number of documents/ }).click();
  await expect.poll(order).toEqual(['mmm-sort', 'zzz-sort', 'aaa-sort']); // most used first
  await page.getByRole('button', { name: /^Sort by number of documents/ }).click();
  await expect.poll(order).toEqual(['aaa-sort', 'zzz-sort', 'mmm-sort']);
  // kept after a reload
  await page.reload();
  await page.getByLabel('Find').fill('-sort');
  await expect.poll(order).toEqual(['aaa-sort', 'zzz-sort', 'mmm-sort']);
  // select all shown
  await page.getByRole('checkbox', { name: 'Select all shown' }).check();
  await expect(page.getByRole('button', { name: 'Merge 3' })).toBeVisible();
});

test('names the libraries in the filter of the document list', async ({ page }) => {
  await login(page);
  const res = await page.request.post('/api/documents/upload', {
    multipart: { file: { name: 'verein.pdf', mimeType: 'application/pdf', buffer: makePdf([['Protokoll der Mitgliederversammlung']]) }, library: 'Verein', skipAnalysis: 'true' },
  });
  expect(res.ok(), await res.text()).toBe(true);
  await page.goto('/documents');
  const filter = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Library' }) });
  await expect(filter.getByText('Verein', { exact: true })).toBeVisible();
  await expect(filter.getByText('Familie', { exact: true })).toBeVisible();
  await expect(filter.getByText(/^Library \d+$/)).toHaveCount(0);
});
