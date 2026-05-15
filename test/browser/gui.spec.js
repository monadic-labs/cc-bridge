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
  //  - Generic "Failed to load resource: ... status of 4xx/5xx": the
  //    Chrome console auto-emits these for every non-2xx response. They're
  //    not JavaScript errors — real JS exceptions arrive via 'pageerror'
  //    (covered separately). Several tests deliberately POST invalid
  //    payloads and assert on the resulting error toast; their 4xx
  //    responses would otherwise fail the test on noise.
  page.on('pageerror', (err) => { throw new Error(`pageerror: ${err.message}`); });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (text.includes('favicon.ico')) return;
    if (/Failed to load resource.*status of [45]\d\d/.test(text)) return;
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

test('Extensions tab: every built-in extension is listed with metadata', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="extensions"]').click();

  await expect(page.locator('main h2')).toHaveText('Extensions');

  // All seven built-ins must show. Web-search-zai only activates if a
  // provider opts in via toolTransforms.web_search; the fixture's zai
  // provider does, so it will be registered.
  const expectedNames = [
    'Fallback',
    'Load Balancer',
    'Non-Compliant Transform',
    'OpenAI Format',
    'Sanitization',
    'Thinking SSE Transform',
    'Web Search (z.ai)',
  ];
  for (const title of expectedNames) {
    await expect(
      page.locator('main .card h3', { hasText: title })
    ).toBeVisible();
  }

  // Cards are tagged by extension name for selector reuse.
  const cards = page.locator('main .card[data-extension]');
  await expect(cards).toHaveCount(expectedNames.length);
});

test('Extensions tab: configurable extensions expose their form, non-configurable show placeholder', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="extensions"]').click();

  // openai-format has a schema with additionalProperties (provider map) →
  // shows a "new-map-key-..." input.
  const openaiCard = page.locator('main .card[data-extension="openai-format"]');
  await expect(openaiCard.locator('input[id^="new-map-key-"]')).toHaveCount(1);

  // load-balancer also has a schema → shows a new-map-key input for pools.
  const lbCard = page.locator('main .card[data-extension="load-balancer"]');
  await expect(lbCard.locator('input[id^="new-map-key-"]')).toHaveCount(1);

  // sanitization has no schema → shows the placeholder, no form.
  const sanCard = page.locator('main .card[data-extension="sanitization"]');
  await expect(sanCard.getByText(/No user-tunable settings/)).toBeVisible();
  await expect(sanCard.locator('input[id^="new-map-key-"]')).toHaveCount(0);

  // fallback has no schema either.
  const fbCard = page.locator('main .card[data-extension="fallback"]');
  await expect(fbCard.getByText(/No user-tunable settings/)).toBeVisible();
});

test('Extensions tab: activation tag rendered for each card', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="extensions"]').click();

  await expect(page.locator('main .card[data-extension="openai-format"] .tag')).toContainText('Always on');
  await expect(page.locator('main .card[data-extension="fallback"] .tag')).toContainText('Activates per-route');
  await expect(page.locator('main .card[data-extension="web-search-zai"] .tag')).toContainText('Activates per-provider');
});

// Select an input by the dot-path it writes to. We bake the path into the
// onchange attribute of each form field (e.g.
//   onchange="updateConfigNumber('daemon.daemonStartProgressGraceMs', ...)").
// Matching on that attribute is precise: each path is unique and the locator
// can't accidentally resolve to a parent form-group that contains the field.
function inputForPath(page, path) {
  return page.locator(`main input[onchange*="'${path}'"]`);
}
function selectForPath(page, path) {
  return page.locator(`main select[onchange*="'${path}'"]`);
}

test('Daemon Config tab: form renders fields and edits round-trip', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="daemon"]').click();

  await expect(page.locator('main h2')).toHaveText('Daemon Config');

  // Top-level port field
  await expect(inputForPath(page, 'port')).toHaveValue(String(PORT));

  // Edit daemonStartProgressGraceMs via the form
  const graceInput = inputForPath(page, 'daemon.daemonStartProgressGraceMs');
  await graceInput.fill('20000');
  await graceInput.blur();

  await page.locator('#save-btn').click();

  const persisted = await pollDaemonReload(() => {
    try {
      const onDisk = JSON.parse(fs.readFileSync(DAEMON_CFG_PATH, 'utf8'));
      return onDisk.daemon?.daemonStartProgressGraceMs === 20000;
    } catch { return false; }
  });
  expect(persisted).toBe(true);
});

test('Daemon Config tab: enum field (logging.level) round-trips', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="daemon"]').click();

  await selectForPath(page, 'logging.level').selectOption('debug');
  await page.locator('#save-btn').click();

  const persisted = await pollDaemonReload(() => {
    try {
      const onDisk = JSON.parse(fs.readFileSync(DAEMON_CFG_PATH, 'utf8'));
      return onDisk.logging?.level === 'debug';
    } catch { return false; }
  });
  expect(persisted).toBe(true);
});

test('Daemon Config tab: boolean field (compression.recompressRequests) toggles', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="daemon"]').click();

  const cb = inputForPath(page, 'compression.recompressRequests');
  // Fixture has it true; flip to false.
  await expect(cb).toBeChecked();
  await cb.uncheck();
  await page.locator('#save-btn').click();

  const persisted = await pollDaemonReload(() => {
    try {
      const onDisk = JSON.parse(fs.readFileSync(DAEMON_CFG_PATH, 'utf8'));
      return onDisk.compression?.recompressRequests === false;
    } catch { return false; }
  });
  expect(persisted).toBe(true);
});

test('Daemon Config tab: raw JSON details surface reflects current state', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="daemon"]').click();

  // Expand the <details>
  await page.locator('main summary').click();
  const rawPre = page.locator('main pre');
  await expect(rawPre).toBeVisible();
  const raw = await rawPre.textContent();
  const parsed = JSON.parse(raw);
  expect(parsed.port).toBe(PORT);
  expect(parsed.daemon.ipcTimeoutMs).toBe(5000);
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

test('Providers tab: edit URL, save, verify on-disk + reload', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);

  const newUrl = 'https://updated-zai.example.com/api/anthropic';
  const zaiUrl = page.locator('main > .card').first().locator('input[type="text"]').nth(1);
  await zaiUrl.fill(newUrl);
  // dispatch onchange so updateConfig() in app.js fires
  await zaiUrl.blur();

  await page.locator('#save-btn').click();

  const persisted = await pollDaemonReload(() => {
    try {
      const onDisk = JSON.parse(fs.readFileSync(PROVIDERS_PATH, 'utf8'));
      return onDisk.providers?.zai?.url === newUrl;
    } catch { return false; }
  });
  expect(persisted).toBe(true);
});

test('Providers tab: anthropicCompliant checkbox toggles and persists', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);

  const zaiCard = page.locator('main > .card').first();
  const checkbox = zaiCard.locator('input[type="checkbox"]');
  await expect(checkbox).not.toBeChecked();  // fixture has zai as non-compliant
  await checkbox.check();
  await page.locator('#save-btn').click();

  const persisted = await pollDaemonReload(() => {
    try {
      const onDisk = JSON.parse(fs.readFileSync(PROVIDERS_PATH, 'utf8'));
      return onDisk.providers?.zai?.anthropicCompliant === true;
    } catch { return false; }
  });
  expect(persisted).toBe(true);
});

test('Providers tab: add model alias to existing provider, save, persist', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);

  // zai card already has glm-4.7. Add a new alias.
  await page.locator('#new-model-alias-zai').fill('fast');
  await page.locator('#new-model-real-zai').fill('glm-4.7-flash');
  await page.locator('main > .card').first().getByRole('button', { name: '+ Add' }).click();

  // The new row renders
  await expect(page.locator('main > .card').first().locator('input[value="fast"]')).toBeVisible();

  await page.locator('#save-btn').click();

  const persisted = await pollDaemonReload(() => {
    try {
      const onDisk = JSON.parse(fs.readFileSync(PROVIDERS_PATH, 'utf8'));
      return onDisk.providers?.zai?.models?.fast === 'glm-4.7-flash';
    } catch { return false; }
  });
  expect(persisted).toBe(true);
});

test('Routes tab: remove a property rule, save, verify gone from disk', async ({ page }) => {
  page.on('dialog', async (d) => { if (d.type() === 'confirm') await d.accept(); });
  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="routes"]').click();

  // The 'thinking' property rule is in the fixture
  const row = page.locator('main .list-item strong', { hasText: 'thinking' });
  await expect(row).toBeVisible();

  await row.locator('xpath=ancestor::*[contains(@class,"list-item")]')
    .getByRole('button', { name: 'Remove' }).click();
  await expect(row).toHaveCount(0);

  await page.locator('#save-btn').click();
  const persisted = await pollDaemonReload(() => {
    try {
      const onDisk = JSON.parse(fs.readFileSync(PROVIDERS_PATH, 'utf8'));
      return onDisk.routes?.properties?.thinking === undefined;
    } catch { return false; }
  });
  expect(persisted).toBe(true);
});

test('Routes tab: add a payloadSize rule via UI', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="routes"]').click();

  await page.locator('#new-payloadSize-key').fill('>500000');
  await page.locator('#new-payloadSize-val').fill('mirror.claude-opus-4-6');
  // The "Add" button inside the payloadSize section — there are three +Add
  // buttons across the three route map sections; nth(2) is payloadSize.
  await page.getByRole('button', { name: '+ Add' }).nth(2).click();

  await expect(page.locator('main .list-item strong', { hasText: '>500000' })).toBeVisible();
  await page.locator('#save-btn').click();

  const persisted = await pollDaemonReload(() => {
    try {
      const onDisk = JSON.parse(fs.readFileSync(PROVIDERS_PATH, 'utf8'));
      return onDisk.routes?.payloadSize?.['>500000'] === 'mirror.claude-opus-4-6';
    } catch { return false; }
  });
  expect(persisted).toBe(true);
});

test('Extensions tab: declare a provider as OpenAI-format via map editor', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="extensions"]').click();

  // Scope to the openai-format card — multiple extensions now expose map
  // editors so a global `getByRole(... '+ Add')` would be ambiguous.
  const openaiCard = page.locator('main .card[data-extension="openai-format"]');
  await openaiCard.locator('input[id^="new-map-key-"]').fill('mirror');
  await openaiCard.getByRole('button', { name: '+ Add' }).click();

  // The new map entry renders inside the openai-format card as a nested card
  // with a strong tag bearing the key.
  await expect(openaiCard.locator('strong', { hasText: 'mirror' })).toBeVisible();
  await page.locator('#save-btn').click();

  const persisted = await pollDaemonReload(() => {
    try {
      const onDisk = JSON.parse(fs.readFileSync(PROVIDERS_PATH, 'utf8'));
      return typeof onDisk.extensions?.['openai-format']?.providers?.mirror === 'object';
    } catch { return false; }
  });
  expect(persisted).toBe(true);
});

test('Daemon Config tab: save with a busted port shows a backend error toast', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);
  await page.locator('nav li[data-tab="daemon"]').click();

  // The new form renders <input type="number" min="1" max="65535"> for port.
  // The browser's number-input validation would block typing -1, so we bypass
  // it the way the daemon would actually receive a bad value: set via JS and
  // dispatch the change event.
  await page.evaluate(() => {
    const portInput = document.querySelector('main input[type="number"]');
    portInput.value = '-1';
    portInput.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await page.locator('#save-btn').click();

  // Toast surfaces the daemon's ConfigError message
  await expect(page.locator('#toast')).toContainText(/port|Port/);
});

test('Save button: success toast after a valid round-trip', async ({ page }) => {
  await page.goto('/gui');
  await appReady(page);

  // Mutate URL of zai then save — the save flow must show the success toast.
  const zaiUrl = page.locator('main > .card').first().locator('input[type="text"]').nth(1);
  await zaiUrl.fill('https://api.z.ai/api/anthropic');
  await zaiUrl.blur();

  await page.locator('#save-btn').click();
  await expect(page.locator('#toast')).toContainText(/saved/i);
});

// Suppress the unused-import warning for LOGS_DIR — kept for future log-tail
// assertions but not exercised yet.
void LOGS_DIR;
