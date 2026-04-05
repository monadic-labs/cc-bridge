import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { runKill } from '../src/proxy-core.js';
import { loadConfigFromFile, resolveUserConfigDir } from '../src/core/config.js';

const USER_CONFIG_DIR = resolveUserConfigDir();
const LOGS_DIR = path.join(USER_CONFIG_DIR, 'logs');
const config = loadConfigFromFile(USER_CONFIG_DIR);
const PORT = config.port;

const CCB_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccb.js');

console.log(`Restarting CC-Bridge on port ${PORT}...`);

runKill({ logsDir: LOGS_DIR, target: undefined, port: PORT });

let attempts = 0;
const isWin = process.platform === 'win32';
while (attempts < 50) {
  try {
    execSync(isWin ? `netstat -ano | findstr :${PORT} | findstr LISTENING` : `lsof -i :${PORT} -t`, { stdio: 'ignore' });
    process.stdout.write('.');
    execSync(isWin ? 'timeout /t 1' : 'sleep 0.1');
    attempts++;
  } catch {
    break;
  }
}
console.log('\nPort is free, starting proxy...');

spawn(process.execPath, [CCB_BIN, '--__cc-proxy-daemon__'], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
  env: process.env
}).unref();

console.log('Proxy restart triggered.');
