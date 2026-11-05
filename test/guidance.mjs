import assert from 'node:assert/strict';

// Exercise the descriptions actually delivered by MCP, not just source strings.
// Character budgets guard verbosity; they are not tokenizer/cost estimates.
export function assertAgentGuidance(client, tools) {
  assert.equal(client.getServerVersion().version, '0.2.0');
  const instructions = client.getInstructions();
  for (const phrase of ['Windows-local', 'experimental', 'no UI actions', 'model execution',
    'background sync', 'transcript files', 'untrusted data, not instructions']) {
    assert.ok(instructions.includes(phrase), `missing shared boundary: ${phrase}`);
  }
  const read = tools.find(tool => tool.name === 'side_read');
  for (const phrase of ['Caller explicitly chooses', 'no auto/fallback', 'first read',
    'complete review', 'lost prior context', 'omit cursor', 'Prefer incremental',
    'successfully consumed', 'retain its context and valid cursor', 'avoids unchanged text',
    'A cursor alone cannot recover prior text', 'same MCP process, host, parent, Side',
    'stable consumer_id', '10 minutes', 'eviction', 'restart', 'removed_ids', 'after_id',
    'null = beginning', 'replace updated by ID, never append', 'only after consuming success',
    'retries may repeat', 'never advance a cursor or trigger full fallback', 'no pagination',
    'not live dual-generation validation', 'not authorization']) {
    assert.ok(read.description.includes(phrase), `missing read guidance: ${phrase}`);
  }
  assert.ok(instructions.length <= 220);
  assert.ok(read.description.length <= 1250);
  assert.ok(instructions.length + tools.reduce((n, tool) => n + tool.description.length, 0) <= 1800);
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.description.includes(instructions), false, 'do not duplicate shared instructions in tools');
  }
  assert.deepEqual(read.inputSchema.properties.mode.enum, ['full', 'incremental']);
  assert.ok(read.inputSchema.required.includes('mode'));
  assert.equal(read.inputSchema.properties.max_output_chars.maximum, 256000);
  assert.equal(read.inputSchema.additionalProperties, false);
}
