import { startDaemon, PORT } from './setup-daemon.js';

export default async function globalSetup() {
  await startDaemon();
  process.env.CCB_GUI_BASE_URL = `http://localhost:${PORT}`;
}
