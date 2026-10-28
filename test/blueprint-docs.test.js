import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

function lifecycleDiagrams(markdown) {
  return [...markdown.matchAll(/```mermaid\n(stateDiagram-v2\n[\s\S]*?)```/g)].map((m) => m[1]);
}

test('blueprint README and LABELS each hold exactly one lifecycle diagram', () => {
  assert.equal(lifecycleDiagrams(read('blueprint/README.md')).length, 1);
  assert.equal(lifecycleDiagrams(read('blueprint/LABELS.md')).length, 1);
});

test('blueprint lifecycle diagrams are byte-identical across README and LABELS', () => {
  const [readme] = lifecycleDiagrams(read('blueprint/README.md'));
  const [labels] = lifecycleDiagrams(read('blueprint/LABELS.md'));
  assert.equal(readme, labels);
});
