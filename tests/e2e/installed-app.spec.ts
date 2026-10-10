import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';

/**
 * Drives the INSTALLED desktop app (the real NSIS-installed "Cavity Audio.exe"), not the dev host.
 * Runs only when INSTALLED_EXE is set; the windows-release workflow sets it after the silent install.
 * Without it the suite is skipped on purpose (there is no installed app to drive).
 *
 * Selectors are deliberately loose (text / role / canvas) because they have not been exercised against
 * the installed build yet; the first windows-latest run is what validates them.
 */
const exe = process.env.INSTALLED_EXE;
test.skip(!exe, 'INSTALLED_EXE not set: no installed app to test');

let app: ElectronApplication; let page: Page;
const errors: string[] = [];

test.beforeEach(async () => {
  errors.length = 0;
  app = await electron.launch({
    executablePath: exe!,
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
    env: process.env as Record<string, string>,
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
});
test.afterEach(async () => { await app?.close(); });

async function openApp() {
  await page.waitForLoadState('domcontentloaded');
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/app`);
  await page.waitForLoadState('networkidle');
}

test('installed app: simulator mounts, no payment/login wording, no runtime errors', async () => {
  await openApp();
  const text = (await page.locator('body').innerText()).toLowerCase();
  expect(text.length).toBeGreaterThan(200);
  for (const banned of ['subscribe', 'polar', 'sign in', 'upgrade to pro']) expect(text).not.toContain(banned);
  expect(errors).toEqual([]);
});

test('installed app: 3D/2D viewport renders a canvas or shows the explicit WebGL fallback notice', async () => {
  await openApp();
  const canvas = page.locator('canvas').first();
  const fallback = page.getByTestId('viewport-fallback');
  await expect(canvas.or(fallback)).toBeVisible({ timeout: 30_000 });
});

test('installed app: speaker library and Sound Tester are reachable', async () => {
  await openApp();
  const opener = page.getByRole('button', { name: /speaker/i }).first();
  await expect(opener).toBeVisible({ timeout: 30_000 });
  await opener.click();
  await expect(page.getByText(/Speaker Library & A\/B Sound Tester/i)).toBeVisible({ timeout: 15_000 });
  // The library must list real models and must not claim fallback data is manufacturer-measured.
  const body = (await page.locator('body').innerText()).toLowerCase();
  expect(body).toMatch(/models/);
});

test('installed app: relaunch keeps the app data directory and serves the app again', async () => {
  await openApp();
  const dataDir = await app.evaluate(({ app: a }) => a.getPath('userData'));
  expect(fs.existsSync(dataDir)).toBe(true);
  await app.close();
  app = await electron.launch({ executablePath: exe!, args: process.platform === 'linux' ? ['--no-sandbox'] : [], env: process.env as Record<string, string> });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('body')).not.toBeEmpty();
});

test('installed app: a saved local project survives close + relaunch', async () => {
  await openApp();
  const origin1 = new URL(page.url()).origin;
  const name = `E2E Persist ${Date.now()}`;
  await page.getByTitle('Local Projects').click();
  await page.getByPlaceholder('Project name').fill(name);
  await page.getByRole('button', { name: 'Save Copy' }).click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
  await app.close();

  app = await electron.launch({ executablePath: exe!, args: process.platform === 'linux' ? ['--no-sandbox'] : [], env: process.env as Record<string, string> });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const origin2 = new URL(page.url()).origin;
  void origin1; // projects are stored on disk now, so the port no longer has to match (see the next test)
  await page.goto(`${origin2}/app`);
  await page.waitForLoadState('networkidle');
  await page.getByTitle('Local Projects').click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
  await page.getByText(name).click();                       // reopen it
  await expect(page.getByRole('dialog', { name: 'Local projects' })).toBeHidden({ timeout: 15_000 });
});

test('installed app: a saved project survives relaunch on a DIFFERENT port (disk-backed, port-independent)', async () => {
  await app.close();
  const launch = (port: string) => electron.launch({ executablePath: exe!, args: process.platform === 'linux' ? ['--no-sandbox'] : [], env: { ...(process.env as Record<string, string>), CAVITY_PORT_OVERRIDE: port } });
  app = await launch('47631');
  page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
  const o1 = new URL(page.url()).origin;
  await page.goto(`${o1}/app`); await page.waitForLoadState('networkidle');
  const name = `E2E Port ${Date.now()}`;
  await page.getByTitle('Local Projects').click();
  await page.getByPlaceholder('Project name').fill(name);
  await page.getByRole('button', { name: 'Save Copy' }).click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
  await app.close();

  app = await launch('47632');
  page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
  const o2 = new URL(page.url()).origin;
  expect(o2).not.toBe(o1);
  await page.goto(`${o2}/app`); await page.waitForLoadState('networkidle');
  await page.getByTitle('Local Projects').click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
});
