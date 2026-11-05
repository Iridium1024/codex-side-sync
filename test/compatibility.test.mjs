import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopIpc } from '../src/ipc.mjs';
import { SideService } from '../src/service.mjs';
import { fakeIpc } from './fake-ipc.mjs';
import { SIDE, PARENT, snapshot } from './fixtures.mjs';
import { codexHome, discoverCandidates } from '../src/discovery.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';

for (const version of [10, 12, '11']) test(`unsupported protocol ${JSON.stringify(version)} is rejected without fallback`, async t => {
  const fake = await fakeIpc({ version });
  const ipc = new DesktopIpc({ endpoint: fake.endpoint, platform: 'win32' });
  t.after(async () => { ipc.dispose(); await fake.close(); });
  await assert.rejects(ipc.snapshot(SIDE), { code: 'protocol_mismatch' });
  assert.equal(ipc.active.size, 0);
  assert.equal(fake.sent.filter(x => x.method === 'initialize').length, 1);
});
test('same protocol but missing assistant text fails without creating a cursor', async t => {
  const state = snapshot(); delete state.turnHistory.history.entitiesByKey.t1.items[1].text;
  const fake = await fakeIpc({ states: new Map([[SIDE, state]]) });
  const service = new SideService({ ipc: new DesktopIpc({ endpoint: fake.endpoint, platform: 'win32' }) });
  t.after(async () => { service.dispose(); await fake.close(); });
  const response = await service.read({ side_id: SIDE, parent_id: PARENT, consumer_id: 'compat', mode: 'full' });
  assert.equal(response.status, 'assistant_content_unavailable');
  assert.equal(service.cursors.entries.size, 0); assert.equal(service.ipc.active.size, 0);
});
test('unsupported platform refuses connection before touching the endpoint', async () => {
  const ipc = new DesktopIpc({ platform: 'linux', endpoint: 'not-an-endpoint' });
  await assert.rejects(ipc.snapshot(SIDE), { code: 'unsupported_platform' }); ipc.dispose();
});
test('missing pipe fails cleanly', async t => {
  const fake = await fakeIpc(); await fake.close();
  const ipc = new DesktopIpc({ endpoint: fake.endpoint, platform: 'win32' }); t.after(() => ipc.dispose());
  await assert.rejects(ipc.snapshot(SIDE), { code: 'ipc_unavailable' }); assert.equal(ipc.active.size, 0);
});
test('custom CODEX_HOME is respected and missing log schemas do not invent candidates', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'side-sync-compat-'));
  const before = process.env.CODEX_HOME;
  t.after(async () => { if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before;
    assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('side-sync-compat-'));
    await rm(dir, { recursive: true, force: true }); });
  process.env.CODEX_HOME = dir; assert.equal(codexHome(), dir);
  await assert.rejects(discoverCandidates(), { code: 'discovery_unavailable' });
  const database = path.join(dir, 'logs_1.sqlite');
  const db = new DatabaseSync(database); db.exec('CREATE TABLE changed_schema (id TEXT)'); db.close();
  const bytes = await readFile(database);
  await assert.rejects(discoverCandidates(), { code: 'discovery_unavailable' });
  assert.deepEqual(await readFile(database), bytes);
});
