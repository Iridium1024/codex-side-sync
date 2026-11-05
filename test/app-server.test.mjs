import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AppServer } from '../src/app-server.mjs';
import { SideService } from '../src/service.mjs';
import { SIDE, PARENT, OTHER, snapshot } from './fixtures.mjs';
import { SideError } from '../src/errors.mjs';

function setup(t, options = {}) {
  const fixture = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
  const config = { side: SIDE, parent: PARENT, ...options };
  const appServer = new AppServer({ command: process.execPath, platform: 'win32', args: [fixture, JSON.stringify(config)] });
  const ipc = { async snapshot() { throw new Error('unexpected legacy read'); }, dispose() {} };
  const service = new SideService({ ipc, appServer });
  t.after(() => service.dispose());
  return { appServer, service };
}

const args = { side_id: SIDE, parent_id: PARENT, consumer_id: 'app-test', mode: 'full', backend: 'app_server' };

test('attached discovery, full paginated history and unchanged incremental keep tool output private', async t => {
  const { service } = setup(t);
  const listing = await service.list({ parent_id: PARENT, backend: 'app_server' });
  assert.equal(listing.status, 'ok');
  assert.equal(listing.sides[0].side_id, SIDE);
  assert.equal(listing.sides[0].user_messages, 1);
  assert.equal(listing.sides[0].assistant_messages, 2);
  assert.ok(!JSON.stringify(listing).includes('question'));
  const full = await service.read(args);
  assert.equal(full.status, 'ok');
  assert.deepEqual(full.messages.map(message => message.id), ['u1', 'a1', 'a2']);
  assert.ok(!JSON.stringify(full).includes('SECRET-TOOL-OUTPUT'));
  const delta = await service.read({ ...args, mode: 'incremental', cursor: full.cursor });
  assert.equal(delta.status, 'no_changes');
  assert.ok(!JSON.stringify(delta).includes('first answer'));
  assert.equal((await service.read({ ...args, parent_id: OTHER })).status, 'parent_mismatch');
});

test('unapplied attachment filter is rejected and never creates a cursor', async t => {
  const { service } = setup(t, { ignoreFilter: true });
  assert.equal((await service.read(args)).status, 'attachment_filter_unsupported');
  assert.equal(service.cursors.entries.size, 0);
});

test('changing paginated history and active turns do not create cursors', async t => {
  for (const options of [{ changeDuringRead: true }, { inProgress: true }]) {
    const { service } = setup(t, options);
    const result = await service.read(args);
    assert.equal(result.status, 'snapshot_incomplete');
    assert.equal(service.cursors.entries.size, 0);
  }
});

test('automatic routing keeps legacy callers working and does not fall back after an App Server error', async t => {
  let legacyCalls = 0;
  const ipc = { async snapshot() {
    legacyCalls++;
    return { state: snapshot(), durationMs: 1, subscriptionMs: 1, cleanup: {} };
  }, dispose() {} };
  const appServer = {
    async executablePresent() { return true; },
    async contains() { return false; },
    dispose() {}
  };
  const service = new SideService({ ipc, appServer });
  t.after(() => service.dispose());
  const automatic = { ...args };
  delete automatic.backend;
  const legacy = await service.read(automatic);
  assert.equal(legacy.status, 'ok');
  assert.equal(legacy.backend, 'legacy');
  appServer.contains = async () => { throw new SideError('app_server_timeout'); };
  assert.equal((await service.read(automatic)).status, 'app_server_timeout');
  assert.equal(legacyCalls, 1);
});

test('a cursor cannot compare snapshots from different backends', async t => {
  const { service } = setup(t);
  service.ipc.snapshot = async () => ({ state: snapshot(), durationMs: 1, subscriptionMs: 1, cleanup: {} });
  const first = await service.read(args);
  const result = await service.read({ ...args, backend: 'legacy', mode: 'incremental', cursor: first.cursor });
  assert.equal(result.status, 'cursor_mismatch');
  assert.equal(result.details.field, 'backend');
});
