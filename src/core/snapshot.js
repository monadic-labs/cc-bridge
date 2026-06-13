import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CCBSnapshotError } from './exceptions.js';
import { WATCHDOG_SCRIPT_NAME } from './constants.js';

const SNAPSHOT_SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB
const IDENTITY_PATTERN = /^[\d]+\.[\d]+\.[\d]+\+[0-9a-f]{10}$/;

function collectSourceFiles(sourceRoot) {
  const srcDir = path.join(sourceRoot, 'src');
  const binDir = path.join(sourceRoot, 'bin');
  const packageJson = path.join(sourceRoot, 'package.json');

  const collected = [];

  const scanDir = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { recursive: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry);
      if (!fs.statSync(absolute).isFile()) continue;
      const relative = path.join(prefix, entry);
      collected.push({ absolute, relative });
    }
  };

  scanDir(srcDir, 'src');
  scanDir(binDir, 'bin');

  if (fs.existsSync(packageJson)) {
    collected.push({ absolute: packageJson, relative: 'package.json' });
  }

  return collected.filter(({ relative }) => {
    const posix = relative.split(path.sep).join('/');
    if (posix === 'src/test.js') return false;
    if (posix.endsWith('/package-lock.json') || posix === 'package-lock.json') return false;
    if (posix.includes('node_modules/')) return false;
    if (posix.includes('.git/')) return false;
    return true;
  });
}

function copyDotenv(sourceRoot, snapshotDir) {
  const dotenvSrc = path.join(sourceRoot, 'node_modules', 'dotenv');
  if (!fs.existsSync(dotenvSrc)) return;
  const dotenvDst = path.join(snapshotDir, 'node_modules', 'dotenv');
  fs.mkdirSync(dotenvDst, { recursive: true });
  const entries = fs.readdirSync(dotenvSrc, { recursive: true });
  for (const entry of entries) {
    const srcPath = path.join(dotenvSrc, entry);
    if (!fs.statSync(srcPath).isFile()) continue;
    const dstPath = path.join(dotenvDst, entry);
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    fs.copyFileSync(srcPath, dstPath);
  }
}

function computeContentHash(tempDir, files) {
  const parts = [];
  for (const { relative } of files) {
    const posixRelative = relative.split(path.sep).join('/');
    const absolute = path.join(tempDir, relative);
    const bytes = fs.readFileSync(absolute);
    parts.push({ posixRelative, bytes });
  }
  parts.sort((a, b) => a.posixRelative.localeCompare(b.posixRelative));
  const hash = crypto.createHash('sha256');
  for (const { posixRelative, bytes } of parts) {
    hash.update(posixRelative);
    hash.update('\0');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function readSemver(sourceRoot) {
  const pkgPath = path.join(sourceRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return pkg.version;
}

export function createSnapshot(sourceRoot, versionsDir) {
  const semver = readSemver(sourceRoot);
  const files = collectSourceFiles(sourceRoot);

  const tempName = `.incoming-${crypto.randomBytes(4).toString('hex')}`;
  const tempDir = path.join(versionsDir, tempName);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    let totalBytes = 0;
    for (const { absolute, relative } of files) {
      const destPath = path.join(tempDir, relative);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(absolute, destPath);
      totalBytes += fs.statSync(destPath).size;
      if (totalBytes >= SNAPSHOT_SIZE_LIMIT) {
        throw new CCBSnapshotError(`Snapshot size exceeded 5 MB limit`);
      }
    }

    copyDotenv(sourceRoot, tempDir);

    const contentHash = computeContentHash(tempDir, files);
    const shortHash = contentHash.slice(0, 10);
    const identity = `${semver}+${shortHash}`;
    const targetDir = path.join(versionsDir, identity);

    try {
      fs.renameSync(tempDir, targetDir);
    } catch (err) {
      if (err.code === 'EEXIST' || err.code === 'ENOTEMPTY') {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { }
        return { snapshotDir: targetDir, identity };
      }
      throw err;
    }

    const snapshotMeta = {
      identity,
      semver,
      contentHash,
      createdAt: new Date().toISOString(),
      sourceRoot,
    };
    fs.writeFileSync(
      path.join(targetDir, 'snapshot.json'),
      JSON.stringify(snapshotMeta, null, 2)
    );

    return { snapshotDir: targetDir, identity };
  } catch (err) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { }
    throw err;
  }
}

export function listSnapshots(versionsDir) {
  if (!fs.existsSync(versionsDir)) return [];
  const entries = fs.readdirSync(versionsDir);
  const snapshots = [];
  for (const entry of entries) {
    if (!IDENTITY_PATTERN.test(entry)) continue;
    const snapshotDir = path.join(versionsDir, entry);
    const metaPath = path.join(snapshotDir, 'snapshot.json');
    if (!fs.existsSync(metaPath)) continue;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    snapshots.push({ identity: entry, snapshotDir, createdAt: meta.createdAt });
  }
  snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return snapshots;
}

export function findSnapshot(versionsDir, identity) {
  const snapshotDir = path.join(versionsDir, identity);
  if (!fs.existsSync(snapshotDir)) return null;
  return { snapshotDir };
}

export function getSnapshotWatchdogPath(snapshotDir) {
  return path.join(snapshotDir, 'bin', WATCHDOG_SCRIPT_NAME);
}
