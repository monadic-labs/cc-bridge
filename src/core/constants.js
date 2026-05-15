import path from 'path';

export const CCB_VERSION = '1.8.0';
export const CCB_DIR_NAME = '.ccb';
export const CONFIG_FILENAME = 'config.json';
export const PROVIDERS_FILENAME = 'providers.json';
export const VERSIONS_FILENAME = 'versions.json';
export const RUNTIME_FILENAME = 'runtime.json';
export const ENV_FILENAME = '.env';
export const LOGS_DIR_NAME = 'logs';
export const WATCHDOG_SCRIPT_NAME = 'ccb-watchdog.js';

export function getControlIpcPath(port) {
  const suffix = port ? `-${port}` : '';
  if (process.platform === 'win32') {
    return `\\\\?\\pipe\\ccb-ctrl${suffix}`;
  }
  // We can't use resolveUserConfigDir here to avoid circular dependency
  // but we can assume the default if CCB_CONFIG_DIR is not set.
  const configDir = process.env.CCB_CONFIG_DIR
    || path.join(process.env.HOME || process.env.USERPROFILE, '.claude', CCB_DIR_NAME);
  return path.join(configDir, `ccb-ctrl${suffix}.sock`);
}
