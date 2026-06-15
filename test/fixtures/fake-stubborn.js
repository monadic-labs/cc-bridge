// A process that ignores every catchable signal — used to prove the executor's
// last-resort force-kill actually fires when graceful Ctrl-C is not honoured.
// Only SIGKILL (un-catchable) can stop it.
//
// argv: <readyPath>
import fs from 'fs';

const [readyPath] = process.argv.slice(2);

process.on('SIGINT', () => { /* deliberately ignored */ });
process.on('SIGTERM', () => { /* deliberately ignored */ });

setInterval(() => { /* idle */ }, 60_000);

fs.writeFileSync(readyPath, '1');
