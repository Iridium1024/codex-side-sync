import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverCandidates } from '../src/discovery.mjs';
import { SideService } from '../src/service.mjs';
import { SIDE, PARENT, OTHER, OWNER, snapshot } from './fixtures.mjs';

test('discovery reads multiple existing DBs, removes durable IDs, never edits databases', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'side-sync-db-test-'));
  t.after(async () => {
    assert.equal(path.dirname(home), os.tmpdir());
    assert.ok(path.basename(home).startsWith('side-sync-db-test-'));
    await rm(home, { recursive: true, force: true });
  }); // Only this verified test-created directory.
  await mkdir(path.join(home, 'sqlite'));
  const now = Date.now();
  const paths = [path.join(home, 'logs_1.sqlite'), path.join(home, 'sqlite', 'logs_2.sqlite')];
  for (const [i, filename] of paths.entries()) {
    const db = new DatabaseSync(filename);
    db.exec('CREATE TABLE logs (thread_id TEXT, ts INTEGER, message TEXT)');
    const insert = db.prepare('INSERT INTO logs VALUES (?, ?, ?)');
    insert.run(i ? OTHER : SIDE, Math.floor(now / 1000) - i, 'PRIVATE-BODY');
    insert.run(PARENT, Math.floor(now / 1000), 'DO-NOT-RETURN');
    insert.run(OWNER, 1, 'TOO-OLD'); db.close();
  }
  const statePath = path.join(home, 'state_1.sqlite'); paths.push(statePath);
  const state = new DatabaseSync(statePath); state.exec('CREATE TABLE threads (id TEXT)');
  state.prepare('INSERT INTO threads VALUES (?)').run(PARENT); state.close();
  const before = await Promise.all(paths.map(p => readFile(p)));
  const found = await discoverCandidates({ home, now, limit: 8 });
  assert.deepEqual(found.ids, [SIDE, OTHER]); assert.equal(found.exhaustive, false);
  assert.ok(!JSON.stringify(found).includes('PRIVATE'));
  assert.deepEqual(await Promise.all(paths.map(p => readFile(p))), before);
  assert.equal((await discoverCandidates({ home, now, limit: 1 })).capped, true);
});
test('list verifies parent and returns multiple candidates, never auto-selects or exposes bodies', async t => {
  const states = new Map([[SIDE, snapshot()], [OTHER, snapshot(undefined, { sideId: OTHER })],
    [OWNER, snapshot(undefined, { sideId: OWNER, parentId: SIDE })]]);
  const service = new SideService({ ipc: { async snapshot(id) { return { state: states.get(id) }; }, dispose() {} },
    discovery: () => { throw new Error('Explicit IDs must bypass discovery'); } });
  t.after(() => service.dispose());
  const result = await service.list({ parent_id: PARENT, candidate_ids: [SIDE, OTHER, OWNER] });
  assert.deepEqual(result.sides.map(x => x.side_id), [SIDE, OTHER]);
  assert.equal(result.selection, 'caller_decides'); assert.equal(result.discovery.exhaustive, false);
  assert.ok(!JSON.stringify(result).includes('first answer'));
});
