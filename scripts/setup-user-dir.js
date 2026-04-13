import fs from 'fs';
import path from 'path';
import { resolveUserConfigDir } from '../src/core/config.js';
import { ensureCompleteConfig, ensureCompleteProviders } from '../src/core/migrator.js';

const USER_CONFIG_DIR = resolveUserConfigDir();
const PROVIDERS_PATH = path.join(USER_CONFIG_DIR, 'providers.json');
const CONFIG_PATH = path.join(USER_CONFIG_DIR, 'config.json');
const ENV_PATH = path.join(USER_CONFIG_DIR, '.env');

function main() {
  if (!fs.existsSync(USER_CONFIG_DIR)) {
    console.log(`Creating user config directory: ${USER_CONFIG_DIR}`);
    fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
    fs.mkdirSync(path.join(USER_CONFIG_DIR, 'logs'), { recursive: true });
  }

  let providersData = {};
  if (fs.existsSync(PROVIDERS_PATH)) {
    try {
      providersData = JSON.parse(fs.readFileSync(PROVIDERS_PATH, 'utf8'));
    } catch (e) {
      console.warn(`Warning: Could not parse existing providers.json. Preserving it and starting fresh.`);
    }
  } else {
    console.log(`Initializing default providers.json...`);
  }
  
  const mergedProviders = ensureCompleteProviders(providersData);
  fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(mergedProviders, null, 2) + '\n');
  
  let configData = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      configData = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      console.warn(`Warning: Could not parse existing config.json. Preserving it and starting fresh.`);
    }
  } else {
    console.log(`Initializing default config.json...`);
  }

  const mergedConfig = ensureCompleteConfig(configData);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(mergedConfig, null, 2) + '\n');

  if (!fs.existsSync(ENV_PATH)) {
    console.log(`Initializing empty .env file...`);
    fs.writeFileSync(ENV_PATH, '# Add your API keys here\n# CUSTOM_GATEWAY_KEY=your_key_here\n');
    if (process.platform !== 'win32') {
      try { fs.chmodSync(ENV_PATH, 0o600); } catch { /* best effort */ }
    }
  }

  console.log('✨ CC-Bridge user directory is ready.');
}

main();
