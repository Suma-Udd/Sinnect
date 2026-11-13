import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasOwnFile, isOpenWorkspace } from '../src/workspace-file.ts';

// The list holds file names, as the engine writes them.
const saved = [{ name: 'Backend' }, { name: 'Çalışma alanı' }, { name: 'Q3_ plans' }, { name: '__autosave' }];

test('a saved board has its own file, matched through the file name', () => {
  assert.equal(hasOwnFile('Backend', saved), true);
  assert.equal(hasOwnFile('Çalışma alanı', saved), true);
  // Typed as "Q3/ plans", saved as "Q3_ plans".
  assert.equal(hasOwnFile('Q3/ plans', saved), true);
});

test('a never-saved board and the hidden autosave do not', () => {
  assert.equal(hasOwnFile('My workspace', saved), false);
  assert.equal(hasOwnFile('__autosave', saved), false);
  assert.equal(hasOwnFile('Backend', []), false);
});

test('isOpenWorkspace compares the listed file name with the typed name', () => {
  assert.equal(isOpenWorkspace('Q3_ plans', 'Q3/ plans'), true);
  assert.equal(isOpenWorkspace('Backend', 'Frontend'), false);
});
