import path from 'path';
import { fileURLToPath } from 'url';
import { runKill } from '../src/proxy-core.js';
import { loadConfigFromFile, resolveUserConfigDir } from '../src/core/config.js';

const USER_CONFIG_DIR = resolveUserConfigDir();
const LOGS_DIR = path.join(USER_CONFIG_DIR, 'logs');
const config = loadConfigFromFile(USER_CONFIG_DIR);
const PORT = config.port;

const args = process.argv.slice(2);
const target = args[0] === 'all' ? undefined : args[0];
runKill({ logsDir: LOGS_DIR, target, port: PORT });
