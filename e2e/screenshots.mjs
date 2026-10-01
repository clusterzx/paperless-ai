// Usage: node e2e/screenshots.mjs <baseUrl> <outDir>
import { chromium } from '@playwright/test';
const [base = 'http://127.0.0.1:3456', out = 'screenshots'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const errors = [];
async function run(theme, viewport, suffix, pages) {
  const ctx = await browser.newContext({ viewport, colorScheme: theme });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${suffix}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${suffix} console: ${m.text()}`));
  await page.goto(`${base}/login`);
  await page.screenshot({ path: `${out}/login-${suffix}.png` });
  await page.fill('#username', 'admin');
  await page.fill('#password', 'demo1234');
  await page.click('button[type=submit]');
  await page.waitForURL(`${base}/`);
  for (const [name, path, action] of pages) {
    await page.goto(`${base}${path}`);
    await page.waitForTimeout(1200);
    if (action) await action(page);
    await page.screenshot({ path: `${out}/${name}-${suffix}.png`, fullPage: false });
  }
  await ctx.close();
}
const pages = [
  ['dashboard', '/'],
  ['ask', '/ask', async (p) => { await p.getByText('When did I sign my rental agreement?').click(); await p.waitForTimeout(2500); }],
  ['chat', '/chat?doc=3', async (p) => { await p.getByText('Summarize this document.').click(); await p.waitForTimeout(2000); }],
  ['review', '/review?doc=1', async (p) => { await p.getByRole('button', { name: /Analyze with AI/ }).click(); await p.waitForTimeout(1500); }],
  ['playground', '/playground'],
  ['history', '/history'],
  ['settings', '/settings?tab=ai'],
  ['settings-processing', '/settings?tab=processing'],
  ['logs', '/logs'],
];
await run('light', { width: 1440, height: 900 }, 'light', pages);
await run('dark', { width: 1440, height: 900 }, 'dark', pages.slice(0, 4));
await run('light', { width: 390, height: 844 }, 'mobile', [['dashboard', '/'], ['ask', '/ask']]);
await browser.close();
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors');
