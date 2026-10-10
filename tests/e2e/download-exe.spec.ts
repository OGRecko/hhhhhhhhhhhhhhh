import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXE_NAME, FIXTURE, PORTS } from '../../playwright.config';

const base = (n: keyof typeof PORTS) => `http://127.0.0.1:${PORTS[n]}`;
let app: ElectronApplication;
let page: Page;
let downloadDir: string;

test.beforeEach(async () => {
  downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cavity-dl-'));
  app = await electron.launch({
    args: [path.resolve('tests/e2e/host.cjs'), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...process.env, E2E_DOWNLOAD_DIR: downloadDir },
  });
  page = await app.firstWindow();
});
test.afterEach(async () => { await app.close(); });

test('shows "Download Windows EXE" / "Download EXE" when a valid release exists', async () => {
  await page.goto(`${base('good')}/`);
  const big = page.getByRole('link', { name: 'Download Windows EXE' });
  const compact = page.getByRole('link', { name: 'Download EXE', exact: true });
  await expect(big).toBeVisible();
  await expect(compact).toBeVisible();
  for (const l of [big, compact]) {
    await expect(l).toHaveAttribute('href', '/download/windows-exe');
    await expect(l).toHaveAttribute('download', EXE_NAME);
  }
  await expect(page.getByText('EXE not built')).toHaveCount(0);
});

test('clicking the button downloads a .exe whose SHA-256 matches manifest.json', async () => {
  await page.goto(`${base('good')}/`);
  await page.getByRole('link', { name: 'Download Windows EXE' }).click();
  await expect.poll(async () => (await app.evaluate(() => (global as any).__downloads.length)), { timeout: 30_000 }).toBeGreaterThan(0);
  const [d] = await app.evaluate(() => (global as any).__downloads as Array<{ filename: string; savePath: string; state: string }>);
  expect(d.state).toBe('completed');
  expect(d.filename.toLowerCase().endsWith('.exe')).toBe(true);
  const bytes = fs.readFileSync(d.savePath);
  expect(bytes.length).toBe(FIXTURE.size);
  expect(bytes.subarray(0, 2).toString()).toBe('MZ');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const manifest = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'cavity-e2e', 'releases-good', 'manifest.json'), 'utf8'));
  expect(sha).toBe(manifest.sha256);
});

test('with an empty RELEASES_DIR the button is the disabled "EXE not built" state and the download 404s', async () => {
  await page.goto(`${base('empty')}/`);
  const disabled = page.locator('[aria-disabled="true"]', { hasText: 'EXE not built' }).first();
  await expect(disabled).toBeVisible();
  await expect(disabled).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('link', { name: /Download (Windows )?EXE/ })).toHaveCount(0);
  const dl = await page.request.get(`${base('empty')}/download/windows-exe`);
  expect(dl.status()).toBe(404);
  const info = await (await page.request.get(`${base('empty')}/release/windows`)).json();
  expect(info.available).toBe(false);
});

test('a manifest whose size does not match the file is not advertised and is not downloadable', async () => {
  const info = await (await page.request.get(`${base('tampered')}/release/windows`)).json();
  expect(info.available).toBe(false);
  expect((await page.request.get(`${base('tampered')}/download/windows-exe`)).status()).toBe(404);
  await page.goto(`${base('tampered')}/`);
  await expect(page.getByText('EXE not built').first()).toBeVisible();
});

test('a same-size file whose SHA-256 differs from the manifest is not advertised and is not downloadable', async () => {
  const info = await (await page.request.get(`${base('badhash')}/release/windows`)).json();
  expect(info.available).toBe(false);
  expect((await page.request.get(`${base('badhash')}/download/windows-exe`)).status()).toBe(404);
  await page.goto(`${base('badhash')}/`);
  await expect(page.getByText('EXE not built').first()).toBeVisible();
});

test('a renamed non-PE file with a matching size and SHA-256 is not advertised and is not downloadable', async () => {
  const info = await (await page.request.get(`${base('notpe')}/release/windows`)).json();
  expect(info.available).toBe(false);
  expect((await page.request.get(`${base('notpe')}/download/windows-exe`)).status()).toBe(404);
});
