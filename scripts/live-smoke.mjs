// Explicit one-shot live verification. Does not print or save message bodies.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const { values } = parseArgs({ options: { parent: { type: 'string' }, side: { type: 'string' },
  closed: { type: 'string' }, expect: { type: 'string' } }, strict: true });
if (!values.parent || !values.side) {
  console.error('Usage: npm run smoke -- --parent UUID --side UUID [--closed UUID] [--expect TEXT]');
  process.exitCode = 1;
} else {
  const started = performance.now();
  const client = new Client({ name: 'side-sync-live-smoke', version: '0.2.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/server.mjs', import.meta.url))], stderr: 'pipe' });
  let stderrBytes = 0;
  transport.stderr?.on('data', data => { stderrBytes += data.length; });
  const measurements = [];
  async function call(name, args) {
    const before = performance.now();
    const response = await client.callTool({ name, arguments: args }, { timeout: 30000 });
    const value = response.structuredContent;
    measurements.push({ tool: name, mode: args.mode, status: value?.status,
      round_trip_ms: Math.round(performance.now() - before), timing_ms: value?.timing_ms,
      cleanup: value?.cleanup });
    assert.ok(value, 'structured result missing');
    return value;
  }
  try {
    await client.connect(transport);
    const initializationMs = Math.round(performance.now() - started);
    assert.equal((await client.listTools()).tools.length, 3);
    const args = { parent_id: values.parent, side_id: values.side,
      consumer_id: `live-smoke-${randomUUID()}`, mode: 'full' };
    assert.equal((await call('side_doctor', {})).status, 'ok');
    const full = await call('side_read', args);
    assert.equal(full.status, 'ok');
    assert.ok(full.messages.some(x => x.role === 'assistant'), 'assistant message missing');
    if (values.expect !== undefined) assert.ok(full.messages.some(x => x.role === 'assistant' && x.text === values.expect), 'expected assistant text missing');
    const deltaArgs = { ...args, mode: 'incremental', cursor: full.cursor };
    const delta = await call('side_read', deltaArgs);
    assert.ok(['ok', 'no_changes'].includes(delta.status)); // The user may be actively chatting.
    assert.equal((await call('side_read', { ...deltaArgs, consumer_id: 'different-consumer' })).status, 'cursor_mismatch');
    assert.equal((await call('side_read', { ...deltaArgs, cursor: randomUUID() })).status, 'cursor_expired');
    const listing = await call('side_list', { parent_id: values.parent, candidate_ids: [values.side] });
    assert.equal(listing.status, 'ok'); assert.equal(listing.sides[0]?.side_id, values.side);
    if (values.closed) assert.equal((await call('side_read', { ...args, side_id: values.closed })).status, 'side_unavailable');
    console.log(JSON.stringify({ status: 'passed', initialization_ms: initializationMs,
      user_messages: full.messages.filter(x => x.role === 'user').length,
      assistant_messages: full.messages.filter(x => x.role === 'assistant').length,
      assistant_text_verified: values.expect !== undefined,
      delta_counts: { added: delta.added.length, updated: delta.updated.length, removed: delta.removed_ids.length },
      measurements, stderr_bytes: stderrBytes, total_ms: Math.round(performance.now() - started) }, null, 2));
  } catch (error) {
    // Do not serialize assertion actual/expected values: they might contain bodies.
    console.error(JSON.stringify({ status: 'failed', error_type: error.name, measurements }));
    process.exitCode = 1;
  } finally { await client.close(); await transport.close(); }
}
