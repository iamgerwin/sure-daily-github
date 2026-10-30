import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdvancedIssueHandler from '../src/github/advanced-issue-handler.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function templatesSection() {
  const doc = fs.readFileSync(path.join(root, 'docs/RANDOMIZATION.md'), 'utf8');
  const match = doc.match(/\n## Issue Content Templates\n([\s\S]*?)\n## /);
  assert.ok(match, 'docs/RANDOMIZATION.md should have an "Issue Content Templates" section');
  return match[1];
}

// Placeholders listed in the section's table (the YAML example is excluded)
function documentedPlaceholders() {
  const rows = templatesSection().split('\n').filter(line => line.startsWith('| `'));
  return [...new Set(rows.flatMap(row => [...row.split('|')[1].matchAll(/\$\{(\w+)\}/g)].map(m => m[1])))].sort();
}

function sourcePlaceholders() {
  const source = fs.readFileSync(path.join(root, 'src/github/advanced-issue-handler.js'), 'utf8');
  const block = source.match(/const replacements = \{([\s\S]*?)\n\s*\};/);
  assert.ok(block, 'expected a replacements object in generateIssueContent');
  return [...block[1].matchAll(/^\s*(\w+)\s*(?::|,|$)/gm)].map(m => m[1]).sort();
}

function createHandler() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-issue-docs-'));
  process.env.SDG_ISSUE_STATE_FILE = path.join(dir, 'issue-state.json');
  const handler = new AdvancedIssueHandler('ghp_test');
  delete process.env.SDG_ISSUE_STATE_FILE;
  return handler;
}

// contentTemplates placeholders are only discoverable through the docs, so the
// table must list exactly what generateIssueContent fills
test('the issue content template docs list every placeholder the advanced handler fills', () => {
  assert.deepEqual(documentedPlaceholders(), sourcePlaceholders());
});

test('every documented issue template placeholder is filled', () => {
  const placeholders = documentedPlaceholders();
  assert.ok(placeholders.length > 0);
  const template = placeholders.map(name => `\${${name}}`).join(' ');
  const config = { contentTemplates: [{ title: template, body: template }] };

  const { title, body } = createHandler().generateIssueContent(
    { owner: 'me', repo: 'demo', labels: [] }, config, new Date('2026-10-15T00:00:00Z'));

  assert.doesNotMatch(title, /\$\{/);
  assert.doesNotMatch(body, /\$\{/);
});
