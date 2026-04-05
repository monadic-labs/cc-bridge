import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import readline from 'readline';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG_JSON_PATH = path.join(PKG_ROOT, 'package.json');
const DEFAULT_ALT = 'ccb';

function findExisting(name) {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? `where ${name}` : `which ${name}`;
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return stdout.split('\n')[0].trim();
  } catch {
    return null;
  }
}

function isItself(cmdPath) {
  try {
    const realPath = fs.realpathSync(cmdPath);
    return realPath.startsWith(PKG_ROOT);
  } catch {
    return false;
  }
}

async function ask(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, (ans) => { rl.close(); resolve(ans); }));
}

async function main() {
  let chosenAlias = 'ccb';
  const existing = findExisting('ccb');

  if (existing && !isItself(existing)) {
    console.log(`\n⚠️  Conflict detected: 'ccb' is already in use by another package.`);
    console.log(`   Location: ${existing}`);
    
    const ans = await ask(`\nEnter a different alias to use for this tool (Default: ${DEFAULT_ALT}): `);
    chosenAlias = ans.trim() || DEFAULT_ALT;

    const altExisting = findExisting(chosenAlias);
    if (altExisting && !isItself(altExisting)) {
      console.log(`\n❌ Error: The alias '${chosenAlias}' is also in use at: ${altExisting}`);
      console.log(`   Please run the install script again with a unique name.`);
      process.exit(1);
    }
  }

  const pkg = JSON.parse(fs.readFileSync(PKG_JSON_PATH, 'utf8'));
  const originalBin = { ...pkg.bin };
  
  pkg.bin = { [chosenAlias]: 'bin/ccb.js' };
  
  console.log(`\nConfiguring package to install as '${chosenAlias}'...`);
  fs.writeFileSync(PKG_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n');

  try {
    console.log(`Running: npm install -g .`);
    execSync('npm install -g .', { stdio: 'inherit' });
    console.log(`\n✨ Successfully installed as '${chosenAlias}'!`);
    console.log(`   You can now run '${chosenAlias}' from anywhere.`);
  } catch (err) {
    console.error(`\n❌ Installation failed.`);
  } finally {
    // Restore the original package.json so the git state remains clean
    pkg.bin = originalBin;
    fs.writeFileSync(PKG_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
