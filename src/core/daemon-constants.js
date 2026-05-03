import path from 'path';
import os from 'os';

export const INIT_TIMEOUT_MS = 10_000;
export const DRAIN_TIMEOUT_MS = 600_000;

export function getControlIpcPath() {
  if (process.platform === 'win32') {
    return '\\\\?\\pipe\\ccb-ctrl';
  }
  const configDir = process.env.CCB_CONFIG_DIR
    || path.join(os.homedir(), '.claude', '.ccb');
  return path.join(configDir, 'ccb-ctrl.sock');
}
