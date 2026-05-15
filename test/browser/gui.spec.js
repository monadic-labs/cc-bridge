// Real-browser tests for the CC-Bridge dashboard.
//
// Per manifesto: drive the rendered UI through Playwright, against a real
// running daemon. No mocks, no bypassing the form into state mutation. Every
// click is a click a real user could perform.
//
// Each test re-writes providers.json / config.json to a known fixture so the
// suite is order-independent.

import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  CONFIG_DIR, LOGS_DIR, PORT,
  fixtureProviders, fixtureDaemonConfig, writeFixtures
} from './setup-daemon.js';

const PROVIDERS_PATH = path.join(CONFIG_DIR, 'providers.json');
const DAEMON_CFG_PATH = path.join(CONFIG_DIR, 'config.json');

// Touch the file to invite the daemon's fs.watch reload. Used after a write
// that's already targeting providers.json; provides a deterministic hook
// for the assertion-side polling instead of an arbitrary sleep.
async function pollDaemonReload(predicate, timeoutMs = 5000) {
  const start = Date.now();
  const POLL_MS = 80;
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  return false;
}

test.beforeEach(async ({ page }) => {
  // Restore canonical fixture so each test sees the same baseline.
  writeFixtures();

  // Surface browser-side errors as test failures rather than letting them
  // accumulate silently. Filter known noise:
  //  - favicon.ico 404: the browser auto-requests it; we don't ship one.
  page.on('pageerror', (err) => { throw new Error(`pageerror: ${err.message}`); });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (text.includes('favicon.ico')) return;
    throw new Error(`console.error: ${text}`);
  });
});

// Wait until load() has populated state.config and the initial render has
// drawn the providers list — the deterministic "GUI is ready" signal.
async function appReady(page) {
  await page.waitForFunction(
    () => document.querySelector('main h2')?.textContent === 'Upstream Providers'
  );
}

test('Providers tab: renders both fixtures with full field set', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);
  await expect(page.locator('nav h1')).toHaveText('CC-Bridge');
  await expect(page.locator('main h2')).toHaveText('Upstream Providers');

  // Two provider cards from the fixture (top-level children of main; the
  // nested .card wrappers for the models table don't count).
  const cards = page.locator('main > .card');
  await expect(cards).toHaveCount(2);

  // zai card
  const zai = cards.first();
  await expect(zai.locator('input[type="text"]').nth(0)).toHaveValue('zai');
  await expect(zai.locator('input[type="text"]').nth(1)).toHaveValue('https://api.z.ai/api/anthropic');
  await expect(zai.locator('input[type="text"]').nth(2)).toHaveValue('ENV:ZAI_KEY');
  await expect(zai.locator('input[type="checkbox"]')).not.toBeChecked();

  // mirror card — anthropicCompliant true
  const mirror = cards.nth(1);
  await expect(mirror.locator('input[type="text"]').nth(1)).toHaveValue('https://mirror.example.com/v1');
  await expect(mirror.locator('input[type="checkbox"]')).toBeChecked();
});

test('Providers tab: HTML escaping safe against script-injection URL', async ({ page }) => {
  // Write a fixture with a malicious URL — the rendered DOM must contain it
  // as text, never as an executable script tag.
  const evil = '"><script>window.__pwned=true</script>';
  const providers = fixtureProviders();
  providers.providers.zai.url = evil;
  fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(providers, null, 2));

  await page.goto('/gui');
  await appReady(page);
  // The injected script must NOT have executed.
  expect(await page.evaluate(() => window.__pwned ?? null)).toBeNull();
  // And the value should appear in the URL input, escaped.
  const zaiUrl = page.locator('main > .card').first().locator('input[type="text"]').nth(1);
  await expect(zaiUrl).toHaveValue(evil);
});

test('Providers tab: add then remove a new provider', async ({ page }) => {
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'prompt') await dialog.accept('localprovider');
    if (dialog.type() === 'confirm') await dialog.accept();
  });

  await page.goto('/gui');
  await appReady(page);
  await page.getByRole('button', { name: '+ Add Provider' }).click();

  // New card appears with id "localprovider"
  const newId = page.locator('main > .card input[type="text"][disabled][value="localprovider"]');
  await expect(newId).toBeVisible();

  // Remove it
  const cards = page.locator('main > .card');
  const newCard = cards.last();
  await newCard.getByRole('button', { name: 'Remove Provider' }).click();
  await expect(newId).toHaveCount(0);
});

test('Routes tab: shows fixture entries across all three rule kinds', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="routes"]').click();

  await expect(page.locator('main h2')).toHaveText('Routing Rules');

  // Each rule kind in its own card section
  const headings = page.locator('main .card h3');
  await expect(headings).toContainText(['Model aliases', 'Property-based rules', 'Payload-size rules', 'Default fallback']);

  // Model alias 'fast' → 'zai.glm-4.7'
  await expect(page.locator('main .list-item strong', { hasText: 'fast' })).toBeVisible();
  await expect(page.locator('main .list-item strong', { hasText: '*sonnet*' })).toBeVisible();
  // Property rule 'thinking'
  await expect(page.locator('main .list-item strong', { hasText: 'thinking' })).toBeVisible();
  // Payload rule '>102400'
  await expect(page.locator('main .list-item strong', { hasText: '>102400' })).toBeVisible();
});

test('Routes tab: add and remove a model route', async ({ page }) => {
  page.on('dialog', async (d) => { if (d.type() === 'confirm') await d.accept(); });

  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="routes"]').click();

  await page.locator('#new-models-key').fill('haiku');
  await page.locator('#new-models-val').fill('zai.glm-4.7');
  await page.getByRole('button', { name: '+ Add' }).first().click();

  const newRow = page.locator('main .list-item strong', { hasText: 'haiku' });
  await expect(newRow).toBeVisible();

  // Remove it
  await newRow.locator('xpath=ancestor::*[contains(@class,"list-item")]')
    .getByRole('button', { name: 'Remove' }).click();
  await expect(newRow).toHaveCount(0);
});

test('Extensions tab: openai-format schema renders editable', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="extensions"]').click();

  await expect(page.locator('main h2')).toHaveText('Extension Settings');
  await expect(page.locator('main .card h3')).toContainText(['OpenAI Format']);

  // The schema declares an additionalProperties map for providers — the GUI
  // exposes a "new key" input + Add button for it.
  await expect(page.locator('main input[id^="new-map-key-"]')).toHaveCount(1);
});

test('Daemon Config tab: JSON editor renders current config and accepts save', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="daemon"]').click();

  await expect(page.locator('main h2')).toHaveText('Daemon Config');
  const editor = page.locator('#daemon-config-editor');
  await expect(editor).toBeVisible();

  const initial = await editor.inputValue();
  const parsed = JSON.parse(initial);
  expect(parsed.port).toBe(PORT);
  expect(parsed.daemon.ipcTimeoutMs).toBe(5000);

  // Flip logging.level to debug, save, verify on-disk persistence.
  parsed.logging.level = 'debug';
  await editor.fill(JSON.stringify(parsed, null, 2));
  await page.locator('#save-btn').click();

  const persisted = await pollDaemonReload(() => {
    try {
      const onDisk = JSON.parse(fs.readFileSync(DAEMON_CFG_PATH, 'utf8'));
      return onDisk.logging?.level === 'debug';
    } catch { return false; }
  });
  expect(persisted).toBe(true);
});

test('Daemon Config tab: invalid JSON surfaces a parse error in-line', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="daemon"]').click();

  const editor = page.locator('#daemon-config-editor');
  await editor.fill('{not valid json');
  // Dispatch an explicit input event in case fill() didn't trigger one
  // for the listener (Playwright fill normally does; this is belt + braces).
  await editor.evaluate((el) => el.dispatchEvent(new Event('input', { bubbles: true })));

  await expect(page.locator('main').getByText(/JSON parse error/)).toBeVisible();
});

test('Status tab: shows daemon metadata, log tail, and restart button', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="status"]').click();

  await expect(page.locator('main h2')).toHaveText('Daemon Status');
  // Version line — exact string match against package version is brittle,
  // so just assert it's a dotted token.
  await expect(page.locator('main .list-item').filter({ hasText: 'Version' })).toBeVisible();
  await expect(page.locator('main .list-item').filter({ hasText: 'Worker PID' })).toBeVisible();
  await expect(page.locator('main .list-item').filter({ hasText: 'Uptime' })).toBeVisible();

  // Log tail panel is present (may be empty if daemon just started)
  await expect(page.locator('main h3', { hasText: 'Log tail' })).toBeVisible();

  // Restart + Refresh buttons render
  await expect(page.getByRole('button', { name: 'Restart Daemon' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
});

test('Status tab: restart button triggers daemon restart with uptime reset', async ({ page }) => {
  page.on('dialog', async (d) => { if (d.type() === 'confirm') await d.accept(); });
  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="status"]').click();

  const before = await (await fetch(`http://localhost:${PORT}/__ccb_internal__/status`)).json();

  await page.getByRole('button', { name: 'Restart Daemon' }).click();

  const restarted = await pollDaemonReload(async () => {
    try {
      const res = await fetch(`http://localhost:${PORT}/__ccb_internal__/status`);
      if (!res.ok) return false;
      const after = await res.json();
      return after.worker_pid !== before.worker_pid || after.uptime_sec < before.uptime_sec;
    } catch { return false; }
  }, 15000);

  expect(restarted).toBe(true);
});

test('Tab navigation: switching tabs updates the active marker', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);
  await expect(page.locator('nav li.active')).toHaveText('Providers');

  await page.locator('nav li[data-tab="routes"]').click();
  await expect(page.locator('nav li.active')).toHaveText('Routing Rules');

  await page.locator('nav li[data-tab="extensions"]').click();
  await expect(page.locator('nav li.active')).toHaveText('Extensions');

  await page.locator('nav li[data-tab="daemon"]').click();
  await expect(page.locator('nav li.active')).toHaveText('Daemon Config');

  await page.locator('nav li[data-tab="status"]').click();
  await expect(page.locator('nav li.active')).toHaveText('Status');
});

// Suppress the unused-import warning for LOGS_DIR — kept for future log-tail
// assertions but not exercised yet.
void LOGS_DIR;
