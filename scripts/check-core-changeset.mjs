#!/usr/bin/env node
// Fails CI if a PR touches packages/core/** without a .changeset entry that
// mentions @ai-plugins-cc/core. Compares HEAD against the merge base with
// the base branch (default: main).

import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const BASE_BRANCH = process.env.BASE_BRANCH || 'main';
const CORE_PREFIX = 'packages/core/';
const CORE_PACKAGE = '@ai-plugins-cc/core';

function git(args) {
  return execSync(`git ${args}`, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function changedFiles() {
  let mergeBase;
  for (const ref of [`origin/${BASE_BRANCH}`, BASE_BRANCH, 'HEAD~1']) {
    try {
      mergeBase = git(`merge-base HEAD ${ref}`);
      break;
    } catch {
      // try next ref
    }
  }
  if (!mergeBase) return null;
  return git(`diff --name-only ${mergeBase}...HEAD`).split('\n').filter(Boolean);
}

function changesetMentionsCore() {
  const dir = join(REPO_ROOT, '.changeset');
  if (!existsSync(dir)) return false;
  const entries = readdirSync(dir).filter(
    (name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md',
  );
  for (const name of entries) {
    const body = readFileSync(join(dir, name), 'utf8');
    if (body.includes(CORE_PACKAGE)) return true;
  }
  return false;
}

function main() {
  const files = changedFiles();
  if (files === null) {
    console.log('No diffable base ref — changeset enforcement skipped.');
    return;
  }
  const touchedCore = files.some((f) => f.startsWith(CORE_PREFIX));
  if (!touchedCore) {
    console.log('No changes under packages/core/ — changeset enforcement skipped.');
    return;
  }
  if (changesetMentionsCore()) {
    console.log(`Found a changeset entry mentioning ${CORE_PACKAGE}. OK.`);
    return;
  }
  console.error(
    `\nThis PR modifies packages/core/ but has no changeset entry referencing ${CORE_PACKAGE}.`,
  );
  console.error('Run `npm run changeset` and commit the generated file.');
  process.exit(1);
}

main();
