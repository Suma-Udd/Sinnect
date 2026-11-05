import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionTemplate } from '../../engine/src/protocol.ts';
import { renamedFamilyTemplates, templateFamily } from '../src/template-family.ts';

const families = [
  { id: 'f_a', name: 'Frontend' },
  { id: 'f_b', name: 'Backend team' },
];

test('matches by id first', () => {
  assert.equal(templateFamily({ familyId: 'f_b', familyName: 'Frontend' }, families), 'f_b');
});

test('falls back to name when the id is gone', () => {
  assert.equal(templateFamily({ familyId: 'f_old', familyName: 'Frontend' }, families), 'f_a');
  assert.equal(templateFamily({ familyId: null, familyName: 'Backend team' }, families), 'f_b');
});

test('name match ignores case and surrounding spaces', () => {
  assert.equal(templateFamily({ familyId: null, familyName: '  frontEND ' }, families), 'f_a');
  assert.equal(templateFamily({ familyId: null, familyName: 'backend team' }, [{ id: 'f_c', name: ' Backend Team  ' }]), 'f_c');
});

test('none when neither id nor name matches', () => {
  assert.equal(templateFamily({ familyId: 'f_old', familyName: 'Design' }, families), null);
  assert.equal(templateFamily({ familyId: null, familyName: null }, families), null);
  assert.equal(templateFamily({ familyId: null, familyName: '   ' }, families), null);
  assert.equal(templateFamily({ familyId: 'f_a', familyName: 'Frontend' }, []), null);
});

test('does not do partial name matches', () => {
  assert.equal(templateFamily({ familyId: null, familyName: 'Backend' }, families), null);
});

const tpl = (id: string, familyId: string | null, familyName: string | null): SessionTemplate => ({
  id,
  name: id,
  model: 'claude-sonnet-5-5',
  priority: 3,
  awareness: 'family',
  permission: 'ask',
  familyId,
  familyName,
  prompt: '',
  createdAt: 0,
});

test('family rename updates only templates of that family whose name changed', () => {
  const out = renamedFamilyTemplates([tpl('t1', 'f_a', 'Frontend'), tpl('t2', 'f_b', 'Backend team'), tpl('t3', 'f_a', 'UI')], 'f_a', 'UI');
  assert.deepEqual(
    out.map((t) => [t.id, t.familyName]),
    [['t1', 'UI']],
  );
});
