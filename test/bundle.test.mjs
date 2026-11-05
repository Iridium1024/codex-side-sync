import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, mkdir, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { assertAgentGuidance } from './guidance.mjs';

test('bundled MCP starts outside the source tree without node_modules', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'side-sync-bundle-test-'));
  const client = new Client({ name: 'bundle-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('side-sync-bundle-test-'));
    await rm(dir, { recursive: true, force: true });
  });
  const relocated = path.join(dir, 'relocated package 中文');
  await mkdir(path.join(relocated, 'dist'), { recursive: true });
  await copyFile(new URL('../dist/server.mjs', import.meta.url), path.join(relocated, 'dist', 'server.mjs'));
  const config = JSON.parse(await readFile(new URL('../.mcp.json', import.meta.url), 'utf8')).mcpServers['codex-side-sync'];
  assert.equal(config.cwd, '.');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: config.args, cwd: path.resolve(relocated, config.cwd), stderr: 'pipe' });
  let errors = '';
  transport.stderr.on('data', chunk => { errors += chunk.toString(); });
  await client.connect(transport);
  const tools = await client.listTools(); assert.equal(tools.tools.length, 3);
  assertAgentGuidance(client, tools.tools);
  // Schema-only inspection: no Desktop calls or subscriptions in the test suite.
  await client.close(); assert.equal(errors, '');
});
