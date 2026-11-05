import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { DesktopIpc } from '../src/ipc.mjs';
import { SIDE, OTHER } from './fixtures.mjs';
import { fakeIpc } from './fake-ipc.mjs';

async function setup(t, options = {}) {
  const fake = await fakeIpc(options);
  const ipc = new DesktopIpc({ endpoint: fake.endpoint, platform: 'win32', setupTimeoutMs: 200,
    snapshotTimeoutMs: 150, cleanupTimeoutMs: 30, maxFrameBytes: 100000 });
  t.after(async () => { ipc.dispose(); await fake.close(); });
  return { fake, ipc };
}
test('snapshot: framing, identity noise, explicit unsubscribe and no execution methods', async t => {
  const { fake, ipc } = await setup(t, { fragment: true, noise: true });
  const result = await ipc.snapshot(SIDE);
  assert.equal(result.state.id, SIDE); assert.equal(result.cleanup.unsubscribe_flushed, true);
  await pause(20);
  assert.equal(fake.clients.size, 0); assert.equal(fake.followers.size, 0); assert.equal(ipc.active.size, 0);
  assert.deepEqual(fake.sent.filter(x => x.method === 'thread-stream-following-changed').map(x => x.params.following), [true, false]);
  const allowed = new Set(['thread-owner-discovery', 'initialize', 'thread-stream-following-changed']);
  assert.ok(fake.sent.every(x => allowed.has(x.method) || x.type === 'client-discovery-response'));
  assert.equal(fake.sent.find(x => x.type === 'client-discovery-response').response.canHandle, false);
});
test('closed Side is unavailable without registration or subscription', async t => {
  const { fake, ipc } = await setup(t);
  await assert.rejects(ipc.snapshot(OTHER), { code: 'side_unavailable' });
  assert.equal(fake.sent.length, 1);
});
for (const [name, options, code] of [
  ['timeout', { noSnapshot: true }, 'snapshot_timeout'],
  ['version mismatch', { version: 12 }, 'protocol_mismatch'],
  ['oversized frame', { oversize: 100001 }, 'snapshot_too_large'],
  ['malformed frame', { malformed: true }, 'malformed_frame'],
  ['peer disconnect', { disconnect: true }, 'connection_closed']
]) test(`${name} cleans up without retry`, async t => {
  const { fake, ipc } = await setup(t, options);
  await assert.rejects(ipc.snapshot(SIDE), { code }); await pause(20);
  assert.equal(fake.followers.size, 0); assert.equal(fake.clients.size, 0);
  assert.equal(fake.sent.filter(x => x.method === 'initialize').length, 1);
});
test('cancel during subscription', async t => {
  const control = new AbortController();
  const { fake, ipc } = await setup(t, { noSnapshot: true, onSubscribe: () => control.abort() });
  await assert.rejects(ipc.snapshot(SIDE, { signal: control.signal }), { code: 'cancelled' });
  await pause(20); assert.equal(fake.followers.size, 0);
});
test('setup timeout never starts subscription', async t => {
  const { fake, ipc } = await setup(t, { noDiscovery: true });
  await assert.rejects(ipc.snapshot(SIDE), { code: 'setup_timeout' });
  assert.equal(fake.sent.length, 1);
});
test('bounded concurrency and dispose', async t => {
  const { ipc } = await setup(t, { noSnapshot: true }); ipc.maxConcurrent = 1;
  const pending = ipc.snapshot(SIDE);
  await assert.rejects(ipc.snapshot(SIDE), { code: 'busy' });
  ipc.dispose(); await assert.rejects(pending, { code: 'cancelled' });
});
