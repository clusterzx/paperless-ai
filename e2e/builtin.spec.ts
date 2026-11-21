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
  await page.goto('/login');
  if (page.url().endsWith('/login')) {
    await page.fill('#username', USER);
    await page.fill('#password', PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening|night)/ })).toBeVisible();
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
  await expect(page.getByText('stored').first()).toBeVisible();
  await page.getByRole('link', { name: 'Open' }).first().click();
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
