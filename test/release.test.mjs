import test from 'node:test';
import assert from 'node:assert/strict';
import { auditRelease, contentFindings } from '../scripts/release-audit.mjs';

test('release allowlist contains required files and no private development artifacts', async () => {
  const report = await auditRelease();
  assert.equal(report.status, 'passed');
  assert.ok(!report.files.includes('docs/verification.md'));
  assert.ok(!report.files.some(f => f.startsWith('node_modules/')));
  assert.deepEqual([...report.files].sort(), ['.codex-plugin/plugin.json', '.mcp.json', 'README.md', 'LICENSE', 'dist/server.mjs', 'dist/cli.mjs', 'dist/THIRD_PARTY_NOTICES.txt'].sort());
});
test('privacy audit reports rules without returning sensitive matching text', () => {
  assert.deepEqual(contentFindings(['C:', 'Users', 'example-person', 'project'].join('/')), ['personal_absolute_path']);
  assert.deepEqual(contentFindings('sk-' + 'a'.repeat(32)), ['possible_secret']);
  assert.deepEqual(contentFindings(['12345678', 'abcd', '4abc', '8abc', '123456789abc'].join('-')), ['non_fixture_uuid']);
  assert.deepEqual(contentFindings('11111111-1111-4111-8111-111111111111'), []);
});
