import { stopDaemon } from './setup-daemon.js';

export default async function globalTeardown() {
  await stopDaemon();
}
