import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { createProxyCore } from './proxy-core.js';
import { loadConfigFromFile, resolveUserConfigDir } from './core/config.js';

const USER_CONFIG_DIR = resolveUserConfigDir();
const config = loadConfigFromFile(USER_CONFIG_DIR);
const PORT = config.port;

const core = createProxyCore({ configDir: USER_CONFIG_DIR, port: PORT });
core.initProviders();

const server = http.createServer(core.createRequestHandler());

server.listen(PORT, async () => {
  const pidsFile = path.join(core.logsDir, 'proxy.pids');
  if (!fs.existsSync(core.logsDir)) fs.mkdirSync(core.logsDir, { recursive: true });
  fs.appendFileSync(pidsFile, process.pid + '\n', 'utf8');

  const cfg = await core.getConfig();
  await core.emit(`CC-Bridge proxy listening on http://localhost:${PORT}`);
  await core.emit(`Logging: ${cfg.loggingEnabled ? 'ON' : 'OFF'} | logs dir: ${core.logsDir}`);
  await core.emit(`Providers: ${core.providerCount} route(s) loaded`);
});
