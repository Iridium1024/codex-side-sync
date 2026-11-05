import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../src/mcp.mjs';
import { SideService } from '../src/service.mjs';
import { DesktopIpc } from '../src/ipc.mjs';
import { fakeIpc } from './fake-ipc.mjs';
import { SIDE, PARENT } from './fixtures.mjs';
import { assertAgentGuidance } from './guidance.mjs';

const args = { side_id: SIDE, parent_id: PARENT, consumer_id: 'mcp-test', mode: 'full' };
async function connect(t, options = {}) {
  const fake = await fakeIpc(options);
  const service = new SideService({ ipc: new DesktopIpc({ endpoint: fake.endpoint, platform: 'win32' }) });
  const { server } = createServer(service);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); service.dispose(); await fake.close(); });
  await server.connect(a); await client.connect(b);
  return { client, service, fake };
}
test('MCP discovery exposes compact mode-selection guidance without subscribing', async t => {
  const { client, fake } = await connect(t);
  assertAgentGuidance(client, (await client.listTools()).tools);
  assert.equal(fake.sent.length, 0);
});

test('MCP exposes strict explicit modes and returns structured full/delta results', async t => {
  const { client } = await connect(t);
  const listing = await client.listTools();
  assert.deepEqual(listing.tools.map(x => x.name).sort(), ['side_doctor', 'side_list', 'side_read']);
  const schema = listing.tools.find(x => x.name === 'side_read').inputSchema;
  const description = listing.tools.find(x => x.name === 'side_read').description;
  assert.ok(description.includes('after_id'));
  assert.ok(description.includes('10 minutes'));
  assert.ok(description.includes('not live dual-generation validation'));
  assert.ok(schema.required.includes('mode'));
  assert.deepEqual(schema.properties.mode.enum, ['full', 'incremental']);
  const bad = await client.callTool({ name: 'side_read', arguments: { ...args, mode: 'auto' } });
  assert.equal(bad.isError, true);
  const first = await client.callTool({ name: 'side_read', arguments: args });
  assert.equal(first.isError, false); assert.equal(first.structuredContent.messages.length, 2);
  assert.deepEqual(JSON.parse(first.content[0].text), first.structuredContent);
  const next = await client.callTool({ name: 'side_read', arguments: { ...args, mode: 'incremental', cursor: first.structuredContent.cursor } });
  assert.equal(next.structuredContent.status, 'no_changes');
  const mismatch = await client.callTool({ name: 'side_read', arguments: { ...args, consumer_id: 'other', mode: 'incremental', cursor: first.structuredContent.cursor } });
  assert.equal(mismatch.isError, true); assert.equal(mismatch.structuredContent.status, 'cursor_mismatch');
});
test('MCP cancellation reaches IPC and removes the temporary subscription', async t => {
  const subscribed = Promise.withResolvers();
  const { client, service, fake } = await connect(t, { noSnapshot: true, onSubscribe: subscribed.resolve });
  const abort = new AbortController();
  const request = client.callTool({ name: 'side_read', arguments: args }, { signal: abort.signal });
  const rejected = assert.rejects(request);
  await subscribed.promise; abort.abort(); await rejected;
  const deadline = Date.now() + 1000;
  while ((service.ipc.active.size || fake.followers.size) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.equal(service.ipc.active.size, 0); assert.equal(fake.followers.size, 0);
  assert.ok(fake.sent.some(x => x.method === 'thread-stream-following-changed' && !x.params.following));
});
