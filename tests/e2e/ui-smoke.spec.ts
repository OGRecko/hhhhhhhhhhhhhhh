import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PORTS } from '../../playwright.config';

const base = `http://127.0.0.1:${PORTS.good}`;
let app: ElectronApplication; let page: Page;
const errors: string[] = [];

test.beforeEach(async () => {
  errors.length = 0;
  app = await electron.launch({
    args: [path.resolve('tests/e2e/host.cjs'), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...process.env, E2E_DOWNLOAD_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cavity-ui-')) },
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
});
test.afterEach(async () => { await app.close(); });

test('landing page renders, shows no payment/login wording, and has the Download EXE button', async () => {
  await page.goto(`${base}/`);
  await expect(page.locator('body')).not.toBeEmpty();
  const text = (await page.locator('body').innerText()).toLowerCase();
  for (const banned of ['subscribe', 'subscription', 'polar', 'sign in', 'log in', 'login', 'upgrade to pro', 'paywall']) {
    expect(text, `landing page must not mention "${banned}"`).not.toContain(banned);
  }
  const buttons = page.getByRole('link', { name: /Download (Windows )?EXE/ });
  // The button renders after the page fetches the release manifest; count() does not auto-wait.
  await expect(buttons.first()).toBeVisible();
  expect(await buttons.count()).toBeGreaterThanOrEqual(1);
  const hero = buttons.last();
  await expect(hero).toBeVisible();
  await expect(hero).toHaveAttribute('href', '/download/windows-exe');
  // "Green" is checked on the rendered colours, not on a class name.
  const [r, g, b] = (await hero.evaluate((el) => getComputedStyle(el).color)).match(/\d+/g)!.map(Number);
  expect(g, `button text colour rgb(${r},${g},${b}) should be green-dominant`).toBeGreaterThan(Math.max(r, b));
  expect(errors).toEqual([]);
});

test('simulator (/app) mounts without runtime errors and exposes the core controls', async () => {
  await page.goto(`${base}/app`);
  await page.waitForLoadState('networkidle');
  const text = (await page.locator('body').innerText()).toLowerCase();
  expect(text.length).toBeGreaterThan(200);
  for (const banned of ['subscribe', 'polar', 'sign in', 'upgrade to pro']) expect(text).not.toContain(banned);
  // Core capabilities must be reachable from the UI, not just exist in code.
  for (const needle of ['speaker', 'receiver', 'room']) expect(text, `UI should mention "${needle}"`).toContain(needle);
  expect(errors).toEqual([]);
  console.log('UI TEXT SAMPLE:', text.replace(/\s+/g, ' ').slice(0, 600));
});
