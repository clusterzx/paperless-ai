/**
 * End-to-end test of the complete user journey against the demo server
 * (fake Paperless-ngx + fake LLM, real Paperless-AI backend and UI).
 * Tests run in order and share the server state.
 */
import { expect, test, type Cookie, type Page } from '@playwright/test';
import { timeStep, totpCode } from '../src/server/totp.js';

test.describe.configure({ mode: 'serial' });

// The support reminder would open on the dashboard in every test – it has a test of its own.
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-support-reminder')) localStorage.setItem('pai-support-snoozed-until', String(Date.now() + 86_400_000));
  });
});

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
  // 9 sample documents, one without text content is skipped (OCR is still off here).
  await expect(page.getByText('8 of 9 documents')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('89%', { exact: true })).toBeVisible();
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
  const dialog = page.getByRole('dialog', { name: 'Save in the prompt library' });
  const name = dialog.getByLabel('Name');
  await name.fill('');
  await name.pressSequentially('Works well for invoices');
  await expect(name).toHaveValue('Works well for invoices');
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

test('OCR page finds documents with poor text, reads them and the AI renames them', async ({ page }) => {
  await login(page);
  await page.goto('/settings?tab=ocr');
  await page.getByRole('switch', { name: 'Enable OCR with PaddleOCR' }).click();
  await page.getByLabel('When should OCR run?').selectOption('manual');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Settings saved/)).toBeVisible();

  await page.getByRole('link', { name: 'OCR', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'OCR' })).toBeVisible();
  await page.getByRole('button', { name: 'Re-check text quality' }).click();
  await expect(page.getByRole('tab', { name: /Needs OCR [1-9]/ })).toBeVisible();
  await expect(page.getByText(/words look garbled|No text/).first()).toBeVisible();

  await page.getByRole('button', { name: /OCR all that need it/ }).click();
  await page.getByRole('button', { name: 'Start OCR' }).click();
  await expect(page.getByRole('tab', { name: /Needs OCR 0/ })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: /OCR done/ }).click();
  await expect(page.getByText('Saved in Paperless').first()).toBeVisible();

  await page.getByRole('button', { name: 'Show text' }).first().click();
  const dialog = page.getByRole('dialog');
  // Side by side: the text before the OCR and the OCR result that is in Paperless now.
  await expect(dialog.getByText('Before OCR', { exact: true })).toBeVisible();
  await expect(dialog.getByText('PaddleOCR result – now in Paperless', { exact: true })).toBeVisible();
  // Renamed by the AI pipeline from the OCR text.
  await expect(dialog.getByRole('heading', { name: /Malermeister Kopp/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Restore the text before OCR' })).toBeVisible();
});

test('prompt library keeps tested prompts with ratings per model and activates them', async ({ page }) => {
  await login(page);
  await page.goto('/playground');
  await page.getByRole('button', { name: /Analyze \d+ documents?/ }).click();
  await expect(page.getByText(/tokens · avg\./)).toBeVisible({ timeout: 20_000 });

  // Save the tested prompt: the rating is for the model of the test run.
  await page.getByRole('button', { name: 'Save & rate' }).click();
  let dialog = page.getByRole('dialog', { name: 'Save in the prompt library' });
  await dialog.getByLabel('Name').fill('Invoices, tested');
  await dialog.getByLabel('Use case').fill('Invoices & receipts');
  await dialog.getByRole('radio', { name: '9 of 10' }).click();
  await expect(dialog.getByLabel('Tested with model')).not.toHaveValue('');
  await dialog.getByLabel('Note').fill('Good titles');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Prompt saved in the library')).toBeVisible();

  await page.getByRole('link', { name: 'Prompt library' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Prompt library' })).toBeVisible();
  const tested = page.getByRole('region', { name: 'Invoices, tested' });
  await expect(tested.getByRole('button', { name: 'In use' })).toBeDisabled();
  await expect(tested.getByText('Invoices & receipts')).toBeVisible();
  await expect(tested.getByText('9/10')).toBeVisible();

  // A new prompt, rated later with another model, then used for processing.
  await page.getByRole('button', { name: 'New prompt' }).click();
  await page.getByRole('dialog', { name: 'New prompt' }).getByLabel('Prompt').fill('Write very short titles.');
  await page.getByRole('button', { name: 'Next' }).click();
  dialog = page.getByRole('dialog', { name: 'Save in the prompt library' });
  await dialog.getByLabel('Name').fill('Short titles');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const short = page.getByRole('region', { name: 'Short titles' });
  await expect(short.getByText('Not rated')).toBeVisible();

  await short.getByRole('button', { name: 'Rate' }).click();
  dialog = page.getByRole('dialog', { name: 'Rate “Short titles”' });
  await dialog.getByRole('radio', { name: '6 of 10' }).click();
  await dialog.getByLabel('Model').fill('qwen3:8b');
  await dialog.getByRole('button', { name: 'Save rating' }).click();
  await expect(short.getByRole('list', { name: 'Ratings per model' })).toContainText('qwen3:8b');

  await short.getByRole('button', { name: 'Use for processing' }).click();
  await page.getByRole('button', { name: 'Use prompt' }).click();
  await expect(short.getByRole('button', { name: 'In use' })).toBeDisabled();
  await expect(tested.getByRole('button', { name: 'Use for processing' })).toBeEnabled();

  await page.goto('/settings?tab=prompt');
  await expect(page.getByRole('textbox', { name: 'System prompt' })).toHaveValue('Write very short titles.');
});

test('prompt wizard builds, tests and saves a prompt', async ({ page }) => {
  await login(page);
  await page.goto('/settings?tab=prompt');
  await page.getByRole('link', { name: /Start wizard|Open wizard/ }).click();
  await expect(page.getByRole('heading', { name: 'Prompt wizard' })).toBeVisible();

  const owners = page.getByPlaceholder('e.g. Max Mustermann, Mustermann GmbH');
  await owners.fill('Erika Musterfrau');
  await owners.press('Enter');
  const preview = page.locator('pre');
  await expect(preview).toContainText('The archive belongs to “Erika Musterfrau”');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('radio', { name: /Always one language/ }).click();
  await expect(preview).toContainText('Write title, tags and document type in German');

  await page.getByRole('button', { name: /Test & save/ }).click();
  await page.getByRole('button', { name: /Test on \d document/ }).click();
  await expect(page.getByText('Test finished')).toBeVisible({ timeout: 20_000 });

  // Keep it in the prompt library as well (with the wizard answers).
  await page.getByRole('button', { name: 'Save in library' }).click();
  const keep = page.getByRole('dialog', { name: 'Save in the prompt library' });
  await keep.getByLabel('Name').fill('Wizard: Erika');
  await keep.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Prompt saved in the library')).toBeVisible();

  await page.getByRole('button', { name: 'Save prompt' }).click();
  await page.waitForURL(/tab=prompt/, { timeout: 3000 }).catch(async () => {
    await page.getByRole('button', { name: 'Replace prompt' }).click();
    await page.waitForURL(/tab=prompt/);
  });
  await expect(page.getByText('in use')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'System prompt' })).toHaveValue(/Erika Musterfrau/);

  await page.goto('/prompts');
  const wizard = page.getByRole('region', { name: 'Wizard: Erika' });
  await expect(wizard.getByText('Wizard', { exact: true })).toBeVisible();
  await expect(wizard.getByRole('button', { name: 'In use' })).toBeDisabled();
});

test('two-factor authentication: set up, sign in with a code and a recovery code, switch off', async ({ page }) => {
  await login(page);
  await page.goto('/settings?tab=account');
  await page.getByRole('button', { name: 'Set up' }).click();
  const setup = page.getByRole('dialog', { name: 'Set up two-factor authentication' });
  await expect(setup.getByRole('img', { name: 'QR code for the authenticator app' })).toBeVisible();
  const secret = (await setup.getByLabel('Secret key').textContent())!.replace(/\s/g, '');
  await setup.getByLabel('Code from the app').fill(totpCode(secret, timeStep()));
  await setup.getByLabel('Current password').fill(PASSWORD);
  await setup.getByRole('button', { name: 'Enable' }).click();

  const shown = page.getByRole('dialog', { name: 'Your recovery codes' });
  const items = shown.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
  await expect(items).toHaveCount(10);
  const codes = await items.allTextContents();
  await shown.getByRole('button', { name: 'I have stored them' }).click();
  await expect(page.getByText('10 recovery codes left')).toBeVisible();

  const signIn = async (code: string) => {
    await page.context().clearCookies();
    await page.goto('/login');
    await page.fill('#username', USER);
    await page.fill('#password', PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible();
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(dashboardHeading(page)).toBeVisible();
  };
  // The password alone is not enough any more: the code of the app (each one only once) …
  await signIn(totpCode(secret, timeStep() + 1));
  // … or a recovery code.
  await signIn(codes[0]);
  await expect(page.getByText('Signed in with a recovery code – 9 left.')).toBeVisible();

  await page.goto('/settings?tab=account');
  await page.getByRole('button', { name: 'Switch off' }).click();
  const off = page.getByRole('dialog', { name: 'Switch off two-factor authentication?' });
  await off.getByLabel('Code').fill(codes[1]);
  await off.getByLabel('Current password').fill(PASSWORD);
  await off.getByRole('button', { name: 'Switch off' }).click();
  await expect(page.getByText('Not enabled.')).toBeVisible();
  session = await page.context().cookies();
});

test('calendar finds dates in documents, lists them and offers an iCal subscription', async ({ page, request }) => {
  await login(page);
  await page.goto('/settings?tab=processing');
  await page.getByRole('switch', { name: 'Appointments & deadlines' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Settings saved/)).toBeVisible();

  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible();
  await expect(page.getByText('No upcoming dates')).toBeVisible();

  // Documents processed before the calendar was switched on are searched on request.
  await page.getByRole('button', { name: 'Search documents' }).click();
  const scan = page.getByRole('dialog', { name: 'Search documents for dates' });
  await scan.getByLabel('Documents created in the').selectOption('0');
  await scan.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Stromrechnung SR-2024-0412 bezahlen')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Wohnungsbegehung mit der Hausverwaltung')).toBeVisible();
  await expect(page.getByText('10:30 · in 2 days')).toBeVisible();

  const kfz = page.getByRole('listitem').filter({ hasText: 'Kündigungsfrist Kfz-Versicherung' });
  await kfz.getByRole('button', { name: 'Hide' }).click();
  await expect(kfz).toHaveCount(0);
  await page.getByRole('radio', { name: 'Hidden (1)' }).click();
  await expect(page.getByText('Kündigungsfrist Kfz-Versicherung')).toBeVisible();

  await page.getByRole('button', { name: 'Subscribe' }).click();
  const link = page.getByRole('dialog', { name: 'Subscribe in your calendar app' }).getByLabel('Subscription link');
  await expect(link).toHaveValue(/\/api\/calendar\/feed\/.+\.ics$/);
  const ics = await request.get(await link.inputValue());
  expect(ics.headers()['content-type']).toContain('text/calendar');
  const body = await ics.text();
  expect(body).toContain('SUMMARY:Stromrechnung SR-2024-0412 bezahlen');
  expect(body).not.toContain('Kfz-Versicherung');
});

test('support reminder opens on the dashboard, can be put off for 7 days and comes back', async ({ page }) => {
  await login(page);
  await page.evaluate(() => {
    sessionStorage.setItem('e2e-support-reminder', '1');
    localStorage.removeItem('pai-support-snoozed-until');
  });
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Enjoying Paperless-AI?' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  // The shields.io badges, served by Paperless-AI itself.
  const links = dialog.getByRole('list', { name: 'Ways to support the project' }).getByRole('link');
  expect(await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual([
    'https://www.patreon.com/c/clusterzx',
    'https://www.paypal.com/paypalme/bech0r',
    'https://www.buymeacoffee.com/clusterzx',
    'https://ko-fi.com/clusterzx',
  ]);
  const images = dialog.getByRole('img');
  await expect(images).toHaveCount(4);
  expect(await images.evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src')))).toEqual([
    '/support/patreon.svg',
    '/support/paypal.svg',
    '/support/buymeacoffee.svg',
    '/support/kofi.svg',
  ]);
  for (const img of await images.all()) {
    await expect.poll(() => img.evaluate((i) => (i as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0);
  }

  await dialog.getByRole('button', { name: 'Maybe later' }).click();
  await expect(dialog).toBeHidden();
  const until = Number(await page.evaluate(() => localStorage.getItem('pai-support-snoozed-until')));
  expect(until - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
  expect(until - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);

  // Not again on the next visit …
  await page.reload();
  await expect(dashboardHeading(page)).toBeVisible();
  await page.waitForTimeout(3500);
  await expect(dialog).toBeHidden();
  // … but once the 7 days are over.
  await page.evaluate(() => localStorage.setItem('pai-support-snoozed-until', String(Date.now() - 1000)));
  await page.reload();
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // At any time from the account menu.
  await page.getByRole('button', { name: /Account & appearance/ }).click();
  await page.getByRole('button', { name: 'Support the project' }).click();
  await expect(dialog).toBeVisible();
});
