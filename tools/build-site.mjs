#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = path.join(repoRoot, 'engine');
const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'engine.lock.json'), 'utf8'));
if (typeof lock.repository !== 'string' || !/^[0-9a-f]{40}$/.test(lock.commit)) {
  throw new Error('engine.lock.json must contain a repository URL and full commit SHA');
}
const setupOnly = process.argv.includes('--setup-only');

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function headCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: engineDir, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

if (!fs.existsSync(path.join(engineDir, '.git'))) {
  run('git', ['clone', '--no-checkout', lock.repository, engineDir], repoRoot);
}
if (headCommit() !== lock.commit || !fs.existsSync(path.join(engineDir, 'package.json'))) {
  run('git', ['fetch', 'origin', lock.commit], engineDir);
  run('git', ['checkout', '--force', '--detach', lock.commit], engineDir);
}
run('pnpm', ['install', '--frozen-lockfile'], engineDir);
if (setupOnly) process.exit(0);

run('pnpm', ['run', 'build:site'], engineDir);
const out = path.join(repoRoot, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(engineDir, 'dist', 'gui-static'), out, { recursive: true });
console.log(`site built from engine ${lock.commit.slice(0, 12)} into dist/`);
