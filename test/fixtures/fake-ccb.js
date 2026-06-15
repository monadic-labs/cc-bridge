// Stand-in for the ccb launcher in the shutdown behaviour test. The launcher
// holds no OAuth state, so it just exits cleanly on the first Ctrl-C.
//
// argv: <readyPath>
import fs from 'fs';

const [readyPath] = process.argv.slice(2);

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => { /* deliberately ignored */ });

setInterval(() => { /* idle */ }, 60_000);

fs.writeFileSync(readyPath, '1');
