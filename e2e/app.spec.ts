/**
 * End-to-end test of the complete user journey against the demo server
 * (fake Paperless-ngx + fake LLM, real Paperless-AI backend and UI).
 * Tests run in order and share the server state.
 */
import { expect, test, type Cookie, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const USER = 'admin';
const PASSWORD = 'e2e-password-123';

/** The dashboard greets the user ("Good morning, admin"). */
const dashboardHeading = (page: Page) => page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening|night)/ });

/** Session cookies of the last login – reused so the tests stay below the login rate limit. */
let session: Cookie[] | null = null;

async function login(page: Page) {
  if (session) {
    await page.context().addCookies(session);
    await page.goto('/');
    const username = page.locator('#username');
    await expect(dashboardHeading(page).or(username)).toBeVisible();
    if (!(await username.count())) return;
  } else {
    await page.goto('/login');
  }
  await page.fill('#username', USER);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(dashboardHeading(page)).toBeVisible();
  session = await page.context().cookies();
}

test('setup wizard configures Paperless-AI', async ({ page, request }) => {
  const info = (await (await request.get('/__demo/info')).json()) as { paperlessUrl: string; paperlessToken: string; llmUrl: string };
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await page.getByLabel('Username').fill(USER);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Wrong token → error, then fix it.
  await page.getByPlaceholder('http://paperless-ngx:8000').fill(`${info.paperlessUrl}/api/`);
  await page.getByPlaceholder('Token of the Paperless user').fill('wrong-token');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/rejected the API token/)).toBeVisible();
  await page.getByPlaceholder('Token of the Paperless user').fill(info.paperlessToken);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText(/Connected to Paperless-ngx 3\.2\.1 \(API v10\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('radio', { name: /OpenAI-compatible/ }).click();
  await page.getByPlaceholder('https://api.example.com/v1').fill(info.llmUrl);
  await page.getByPlaceholder('deepseek-chat').fill('mock-gpt');
  await page.getByRole('button', { name: 'Test AI connection' }).click();
  await expect(page.getByText(/model "mock-gpt" is available/)).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText('All documents of your archive will be analyzed')).toBeVisible();
  // Keep automatic processing off for a deterministic test; documents are processed via "Scan now".
  await page.getByRole('switch', { name: 'Process new documents automatically' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();

  await expect(dashboardHeading(page)).toBeVisible();
  expect(errors).toEqual([]);
});

test('scan processes documents and the dashboard updates', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Scan now' }).click();
  await expect(page.getByText(/queued for analysis/)).toBeVisible();
  // 8 sample documents, one without text content is skipped.
  await expect(page.getByText('7 of 8 documents')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('88%', { exact: true })).toBeVisible();
  const skipped = page.getByRole('button', { name: /^Skipped\s*1$/ });
  await expect(skipped).toBeVisible();
  await skipped.click();
  await expect(page.getByText('No text content (OCR not finished or failed)')).toBeVisible();
});

test('history lists changes and can undo them', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'History', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'Mietvertrag Leopoldstraße 12' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Details' }).click();
  await expect(page.getByRole('dialog').getByText('Mietvertrag', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await row.getByRole('button', { name: 'Undo' }).click();
  // The confirm button keeps its autoFocus.
  await expect(page.getByRole('button', { name: 'Undo changes' })).toBeFocused();
  await page.getByRole('button', { name: 'Undo changes' }).click();
  await expect(page.getByText('1 document(s) restored')).toBeVisible();
  await expect(row).toHaveCount(0);
  await page.getByRole('switch', { name: 'Show reverted' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Mietvertrag Leopoldstraße 12' }).getByText('reverted')).toBeVisible();
});

test('ask your archive answers with cited sources', async ({ page }) => {
  await login(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Ask your archive' }).click();
  await expect(page.getByText('What would you like to know?')).toBeVisible();
  await page.getByPlaceholder('Ask about your documents…').fill('Wie hoch war die letzte Stromrechnung der Stadtwerke?');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/finden sich die gesuchten Angaben/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/cited source/)).toBeVisible();
  const cite = page.locator('button.cite').first();
  await expect(cite).toBeVisible();
  await cite.click();
  // The conversation is kept in the history.
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.getByRole('dialog').getByText('Wie hoch war die letzte Stromrechnung der Stadtwerke?')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('radio', { name: 'Search' }).or(page.getByRole('button', { name: 'Search', exact: true })).first().click();
  await page.getByPlaceholder(/Search documents by meaning/).fill('Kfz Versicherung');
  await page.getByRole('button', { name: 'Search', exact: true }).last().click();
  await expect(page.getByText(/documents · (hybrid|keyword) search/)).toBeVisible();
  await expect(page.getByRole('link', { name: /HUK-COBURG|Kfz-Versicherung/ }).first()).toBeVisible();
});

test('document chat streams an answer', async ({ page }) => {
  await login(page);
  await page.goto('/chat?doc=4');
  await expect(page.getByRole('heading', { level: 2 })).toContainText(/Allianz|Krankenversicherung/);
  await page.getByRole('button', { name: 'Summarize this document.' }).click();
  await expect(page.getByText('kurze Zusammenfassung')).toBeVisible();
});

test('manual review analyses and saves a document', async ({ page }) => {
  await login(page);
  await page.goto('/review?doc=3');
  await page.getByRole('button', { name: 'Analyze with AI' }).click();
  await expect(page.getByText(/AI suggestion by mock-gpt/)).toBeVisible();
  await page.getByLabel('Title').fill('Mietvertrag Leopoldstraße (geprüft)');
  await page.getByRole('button', { name: 'Save to Paperless' }).click();
  await expect(page.getByText(/Saved: /)).toBeVisible();
});

test('settings validate and save without restart', async ({ page }) => {
  await login(page);
  await page.goto('/settings?tab=processing');
  const cron = page.locator('input.font-mono').first();
  await cron.fill('not a cron');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Invalid scan interval/)).toBeVisible();
  await cron.fill('*/10 * * * *');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Settings saved/)).toBeVisible();

  await page.goto('/settings?tab=integrations');
  await expect(page.locator('input[value$="/api/webhook/document"]')).toBeVisible();
});

test('logs page streams log entries and sign out works', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Logs & diagnostics', exact: true }).click();
  await expect(page.getByText('Streaming')).toBeVisible();
  await expect(page.getByText(/Processed document \d+/).first()).toBeVisible();
  await page.getByRole('button', { name: /Account & appearance/ }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('ask survives "New" during an answer and reports interrupted answers', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await page.goto('/ask');
  // Empty conversation: "Ask about your documents…", afterwards "Ask a follow-up…".
  const composer = page.getByPlaceholder(/^(Ask about your documents…|Ask a follow-up…)$/);

  // A stream that stops without a final event is reported instead of looking complete.
  await page.route('**/api/rag/chat', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'delta', text: 'Teilantwort' })}\n\n` }),
  );
  await composer.fill('Wie hoch war die letzte Stromrechnung?');
  await composer.press('Enter');
  await expect(page.getByText('Teilantwort')).toBeVisible();
  await expect(page.getByText(/connection was interrupted/)).toBeVisible();
  await page.unroute('**/api/rag/chat');

  // "New" while the answer is still pending starts an empty conversation (used to blank the page).
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/rag/chat', async (route) => {
    await held;
    await route.continue().catch(() => undefined);
  });
  await composer.fill('Und die davor?');
  await composer.press('Enter');
  await expect(page.getByText('Thinking…')).toBeVisible();
  await page.getByRole('button', { name: 'New chat' }).click();
  release();
  await expect(page.getByText('What would you like to know?')).toBeVisible();
  await page.unroute('**/api/rag/chat');
  await composer.fill('Wie hoch war die letzte Stromrechnung der Stadtwerke?');
  await composer.press('Enter');
  await expect(page.getByText(/finden sich die gesuchten Angaben/)).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('modals keep the focus while typing and trap Tab', async ({ page }) => {
  await login(page);
  await page.goto('/playground');
  const open = page.getByRole('button', { name: 'Save & rate' });
  await expect(open).toBeEnabled();
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Rate this prompt' });
  const comment = dialog.getByLabel('Comment');
  await comment.pressSequentially('Works well for invoices');
  await expect(comment).toHaveValue('Works well for invoices');
  for (let i = 0; i < 15; i++) await page.keyboard.press('Tab');
  expect(await dialog.evaluate((el) => el.contains(el.ownerDocument.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();

  // No horizontal scrolling on a phone.
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.getByRole('heading', { name: 'Prompt playground' })).toBeVisible();
  expect(await page.locator('main').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});

test('command menu jumps to pages and asks the archive', async ({ page }) => {
  await login(page);
  await page.keyboard.press('Control+k');
  const menu = page.getByRole('dialog', { name: 'Command menu' });
  await expect(menu).toBeVisible();
  await menu.getByRole('combobox').fill('history');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/history$/);

  await page.keyboard.press('Control+k');
  await menu.getByRole('combobox').fill('Wie hoch war die letzte Stromrechnung der Stadtwerke?');
  await expect(menu.getByRole('option', { name: /Wie hoch war/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/ask$/);
  await expect(page.getByText(/finden sich die gesuchten Angaben/)).toBeVisible({ timeout: 20_000 });

  // Appearance: accent colour from the account menu, kept after a reload.
  await page.getByRole('button', { name: /Account & appearance/ }).click();
  await page.getByRole('radio', { name: 'Emerald' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'emerald');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'emerald');
  await page.getByRole('button', { name: /Account & appearance/ }).click();
  await page.getByRole('radio', { name: 'Iris' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-accent', /.+/);
});

test('settings form controls are labelled and keep typed numbers', async ({ page }) => {
  await login(page);
  await page.goto('/settings?tab=processing');
  const parallel = page.getByLabel('Parallel analyses');
  const before = await parallel.inputValue();
  await parallel.fill('');
  await expect(parallel).toHaveValue('');
  await parallel.blur();
  await expect(parallel).toHaveValue(before);

  await page.getByRole('switch', { name: 'Only process documents with specific tags' }).click();
  await expect(page.getByRole('combobox', { name: 'Trigger tags' }).or(page.getByRole('textbox', { name: 'Trigger tags' }))).toBeVisible();

  // Tabs: arrow keys move to the next tab.
  await page.getByRole('tab', { name: 'Prompt' }).click();
  await page.getByRole('tab', { name: 'Prompt' }).press('ArrowRight');
  await expect(page).toHaveURL(/tab=fields/);
  await expect(page.getByRole('tabpanel', { name: 'Custom fields' })).toBeVisible();
  await page.getByRole('button', { name: 'Add custom field' }).click();
  await expect(page.getByRole('combobox', { name: 'Type' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Currency' })).toBeVisible();
});
