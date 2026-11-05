import test from 'node:test';
import assert from 'node:assert/strict';
import { SideService } from '../src/service.mjs';
import { CursorStore } from '../src/cursors.mjs';
import { normalizeSnapshot } from '../src/snapshot.mjs';
import { SIDE, PARENT, OTHER, snapshot, agent, user } from './fixtures.mjs';

const args = { side_id: SIDE, parent_id: PARENT, consumer_id: 'test-consumer', mode: 'full' };
function setup(t, cursorOptions = {}) {
  const fake = { state: snapshot(), calls: 0, async snapshot() {
    this.calls++; return { state: structuredClone(this.state), durationMs: 2, subscriptionMs: 1,
      cleanup: { connection_closed: true, unsubscribe_flushed: true } };
  }, dispose() {} };
  const service = new SideService({ ipc: fake, cursors: new CursorStore(cursorOptions) });
  t.after(() => service.dispose()); return { fake, service };
}
test('full -> no_changes -> new + updated; old cursor remains retryable', async t => {
  const { fake, service } = setup(t);
  const first = await service.read(args); assert.equal(first.messages.length, 2);
  const incremental = { ...args, mode: 'incremental', cursor: first.cursor };
  const next = await service.read(incremental); assert.equal(next.status, 'no_changes');
  assert.deepEqual(next.added, []); assert.ok(!JSON.stringify(next).includes('first answer'));
  fake.state = snapshot([user(), agent('a1', 'edited'), agent('a2', 'edited')]);
  const changed = await service.read(incremental);
  assert.deepEqual(changed.added.map(m => m.id), ['a2']);
  assert.deepEqual(changed.updated.map(m => m.id), ['a1']);
  const retry = await service.read(incremental);
  assert.deepEqual(retry.added, changed.added); assert.deepEqual(retry.updated, changed.updated);
  assert.deepEqual((await service.read({ ...incremental, cursor: changed.cursor })).added, []);
  assert.ok(!JSON.stringify([...service.cursors.entries.values()]).includes('edited'));
});
test('required mode, required cursor, binding, and expiration never fall back', async t => {
  let clock = 1;
  const { fake, service } = setup(t, { now: () => clock, ttlMs: 1000 });
  assert.equal((await service.read({ ...args, mode: undefined })).status, 'invalid_arguments');
  assert.equal((await service.read({ ...args, mode: 'incremental' })).status, 'cursor_required');
  assert.equal(fake.calls, 0);
  const first = await service.read(args);
  for (const changes of [{ consumer_id: 'other' }, { side_id: OTHER }, { parent_id: OTHER }]) {
    assert.equal((await service.read({ ...args, mode: 'incremental', cursor: first.cursor, ...changes })).status, 'cursor_mismatch');
  }
  assert.equal(fake.calls, 1); clock = 2000;
  assert.equal((await service.read({ ...args, mode: 'incremental', cursor: first.cursor })).status, 'cursor_expired');
  assert.equal(fake.calls, 1);
});
test('new service has no durable baseline', async t => {
  const first = setup(t), second = setup(t);
  const full = await first.service.read(args);
  assert.equal((await second.service.read({ ...args, mode: 'incremental', cursor: full.cursor })).status, 'cursor_expired');
});
test('partial history does not imply deletions or advance checkpoint', async t => {
  const { fake, service } = setup(t); const first = await service.read(args);
  fake.state = snapshot([user()], { complete: false });
  assert.equal((await service.read({ ...args, mode: 'incremental', cursor: first.cursor })).status, 'snapshot_incomplete');
  assert.equal(service.cursors.entries.size, 1);
  fake.state = snapshot([user()]);
  assert.deepEqual((await service.read({ ...args, mode: 'incremental', cursor: first.cursor })).removed_ids, ['a1']);
});
test('contradictory pagination flags never produce a complete checkpoint', async t => {
  const { fake, service } = setup(t);
  fake.state.turnsPagination.hasLoadedOldest = false;
  assert.equal((await service.read(args)).status, 'snapshot_incomplete');
  fake.state = snapshot();
  fake.state.turnHistory.history.entitiesByKey.t1.itemsPagination = { hasLoadedOldest: true, olderCursor: 'pending' };
  assert.equal((await service.read(args)).status, 'snapshot_incomplete');
  assert.equal(service.cursors.entries.size, 0);
});
test('output limits fail explicitly, no baseline or silent truncation', async t => {
  const { fake, service } = setup(t); fake.state = snapshot([agent('a1', 'x'.repeat(5000))]);
  const res = await service.read({ ...args, max_output_chars: 1000 });
  assert.equal(res.status, 'output_limit'); assert.equal(service.cursors.entries.size, 0);
});
test('streaming same-ID text/status updates and runtime-only updates', async t => {
  const { fake, service } = setup(t); const first = await service.read(args);
  fake.state.turnHistory.history.entitiesByKey.t1.status = 'inProgress';
  fake.state.threadRuntimeStatus.type = 'active';
  const next = await service.read({ ...args, mode: 'incremental', cursor: first.cursor });
  assert.equal(next.updated.length, 2); assert.equal(next.state_changed, true);
});
test('reorder fails instead of inventing transcript order', async t => {
  const { fake, service } = setup(t); const first = await service.read(args);
  fake.state = snapshot([agent(), user()]);
  assert.equal((await service.read({ ...args, mode: 'incremental', cursor: first.cursor })).status, 'history_reordered');
});
test('inserted messages carry predecessor IDs without repeating existing bodies', async t => {
  const { fake, service } = setup(t); const first = await service.read(args);
  fake.state = snapshot([agent('before', 'new'), user(), agent('middle', 'new'), agent()]);
  const result = await service.read({ ...args, mode: 'incremental', cursor: first.cursor });
  assert.deepEqual(result.added.map(m => [m.id, m.after_id]), [['before', null], ['middle', 'u1']]);
  assert.deepEqual(result.updated, []);
});
test('snapshot validates parent, Side identity, shape and message boundaries', () => {
  const input = { sideId: SIDE, parentId: PARENT };
  const state = snapshot([user(), agent('a1', 'same'), agent('a2', 'same')]);
  assert.equal(normalizeSnapshot(state, input).messages.length, 3);
  assert.throws(() => normalizeSnapshot(state, { ...input, parentId: OTHER }), { code: 'parent_mismatch' });
  state.sideConversation = false;
  assert.throws(() => normalizeSnapshot(state, input), { code: 'not_side' });
  assert.throws(() => normalizeSnapshot(snapshot([agent(), agent()]), input), { code: 'ambiguous_message_id' });
  const missing = snapshot(); delete missing.turnHistory.history.entitiesByKey.t1;
  assert.throws(() => normalizeSnapshot(missing, input), { code: 'unsupported_snapshot_shape' });
});
test('multiline Markdown and non-text warning, no opaque attachment leakage', () => {
  const text = '中文\n```js\nconst x = 1;\n```\n重复\n重复';
  const u = user(); u.content.push({ type: 'image', url: 'PRIVATE_URL' });
  const view = normalizeSnapshot(snapshot([u, agent('a1', text)]), { sideId: SIDE, parentId: PARENT });
  assert.equal(view.messages[1].text, text);
  assert.deepEqual(view.warnings, ['non_text_content_not_returned']);
  assert.ok(!JSON.stringify(view).includes('PRIVATE_URL'));
});
test('bounded metadata checkpoint storage', () => {
  const store = new CursorStore({ maxEntries: 1, maxFingerprints: 3 });
  const binding = { host_id: 'local', parent_id: PARENT, side_id: SIDE, consumer_id: 'a' };
  const old = store.put(binding, [{ id: 'one' }]); store.put(binding, [{ id: 'two' }]);
  assert.equal(store.entries.size, 1); assert.throws(() => store.get(old, binding), { code: 'cursor_expired' });
  store.dispose();
});
