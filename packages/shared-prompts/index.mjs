import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function loadPrompt(name) {
  return readFileSync(join(here, 'prompts', `${name}.md`), 'utf8');
}

export function loadSchema(name) {
  return JSON.parse(readFileSync(join(here, 'schemas', `${name}.schema.json`), 'utf8'));
}
