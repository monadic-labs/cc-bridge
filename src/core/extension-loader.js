import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { ExtensionRegistry } from './extension-registry.js';

const FACTORY_RE = /^create\w+Extension$/;
const DEBOUNCE_MS = 200;

export function getNestedValue(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => o?.[k], obj);
}

function findFactory(mod) {
  for (const [name, val] of Object.entries(mod)) {
    if (typeof val === 'function' && FACTORY_RE.test(name)) return val;
  }
  return null;
}

async function loadModule(filePath) {
  const mtime = (await fs.promises.stat(filePath)).mtimeMs;
  const mod = await import(`${pathToFileURL(filePath).href}?mtime=${mtime}`);
  const meta = mod.EXTENSION_META ?? { activation: 'always' };
  const factory = findFactory(mod);
  if (!factory) {
    return { filePath, error: `No createXxxExtension export found` };
  }
  return { filePath, factory, meta };
}

export async function discoverExtensions(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  const seen = new Set();

  // Preferred: directories containing index.js
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const indexPath = path.join(dir, entry.name, 'index.js');
    try {
      await fs.promises.access(indexPath);
      seen.add(entry.name);
      results.push(await loadModule(indexPath));
    } catch {
      // directory without index.js — skip
    }
  }

  // Legacy: flat .js files (backward compat)
  const jsFiles = entries
    .filter(e => e.isFile() && e.name.endsWith('.js'))
    .map(e => e.name)
    .sort();

  for (const file of jsFiles) {
    const baseName = path.basename(file, '.js');
    if (seen.has(baseName)) continue; // dir version takes precedence
    const filePath = path.join(dir, file);
    try {
      results.push(await loadModule(filePath));
    } catch (e) {
      results.push({ filePath, error: e.message });
    }
  }

  return results;
}

// Copy the discovered EXTENSION_META onto the runtime extension instance so
// downstream code (registry.getAll, /api/extensions) can return human-readable
// metadata without re-importing the module.
function attachMeta(ext, meta) {
  if (!meta) return;
  if (meta.schema) ext.schema = meta.schema;
  ext.activation = meta.activation ?? 'always';
  if (meta.title) ext.title = meta.title;
  if (meta.description) ext.description = meta.description;
  if (meta.configuredBy) ext.configuredBy = meta.configuredBy;
  if (meta.providerTrigger) ext.providerTrigger = meta.providerTrigger;
}

export function buildRegistry(discoveredModules, providerConfigs, extensionConfigs = {}) {
  const registry = new ExtensionRegistry();
  const errors = [];

  for (const mod of discoveredModules) {
    if (mod.error) {
      errors.push(`${path.basename(mod.filePath)}: ${mod.error}`);
      continue;
    }
    try {
      if (mod.meta.activation === 'provider-driven' && mod.meta.providerTrigger) {
        for (const cfg of providerConfigs) {
          const triggerValue = getNestedValue(cfg, mod.meta.providerTrigger);
          if (triggerValue) {
            const ext = mod.factory(triggerValue);
            if (ext) {
              attachMeta(ext, mod.meta);
              registry.register(ext);
            }
          }
        }
        continue;
      }

      // Determine extension name from directory (e.g., "openai-format" from path)
      const dirName = path.basename(path.dirname(mod.filePath));
      const extConfig = extensionConfigs[dirName] ?? {};
      const ext = mod.factory(extConfig);
      if (ext) {
        attachMeta(ext, mod.meta);
        registry.register(ext);
      }
    } catch (e) {
      errors.push(`${path.basename(mod.filePath)}: ${e.message}`);
    }
  }

  return { registry, errors };
}

export function watchExtensions(dirs, onChange) {
  const timers = new Map();
  const watchers = [];

  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { continue; }

    // Watch the root dir for flat .js files and new/removed subdirectories
    try {
      const rootWatcher = fs.watch(dir, (eventType, filename) => {
        if (!filename) return;
        debounce(`${dir}/${filename}`);
      });
      watchers.push(rootWatcher);
    } catch { /* dir may not exist */ }

    // Watch each extension subdirectory recursively
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(dir, entry.name);
      try {
        const subWatcher = fs.watch(subDir, { recursive: true }, (eventType, filename) => {
          if (!filename || !filename.endsWith('.js')) return;
          debounce(`${subDir}/${filename}`);
        });
        watchers.push(subWatcher);
      } catch { /* subdirectory may not be watchable */ }
    }
  }

  function debounce(key) {
    if (timers.has(key)) clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      onChange();
    }, DEBOUNCE_MS));
  }

  return () => watchers.forEach(w => w.close());
}
