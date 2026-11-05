import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const root = fileURLToPath(new URL('..', import.meta.url));
export function contentFindings(text, { bundled = false } = {}) {
  const findings = [];
  if (/[A-Z]:[\\/]+(?:Users|Documents)[\\/]/i.test(text) || /\/(?:Users|home)\/[^\s/]+\//.test(text)) findings.push('personal_absolute_path');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) || /\b(?:sk-(?:proj-)?|ghp_|github_pat_)[A-Za-z0-9_-]{24,}/.test(text)) findings.push('possible_secret');
  if (!bundled) {
    const uuids = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? [];
    if (uuids.some(id => !/^([1-4])\1{7}-\1{4}-4\1{3}-8\1{3}-\1{12}$/.test(id))) findings.push('non_fixture_uuid');
  }
  return findings;
}
export async function auditRelease(base = root) {
  const files = JSON.parse(await readFile(path.join(base, 'release-files.json'), 'utf8'));
  if (!Array.isArray(files) || new Set(files).size !== files.length) throw new Error('invalid_release_manifest');
  const failures = [], hashes = {};
  const realRoot = await realpath(base);
  for (const relative of files) {
    if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..') ||
      path.isAbsolute(relative) || /^(?:node_modules|release|\.git|\.cache|coverage)(?:\/|$)/.test(relative) ||
      /(?:\.sqlite|\.jsonl|\.log|\.map|\.env|\.zip|\.tgz)$/.test(relative) || relative === 'docs/verification.md') {
      failures.push({ file: typeof relative === 'string' ? relative : '(invalid)', rule: 'forbidden_release_path' }); continue;
    }
    const absolute = path.resolve(base, relative);
    if (!absolute.startsWith(path.resolve(base) + path.sep)) throw new Error('release_path_escape');
    let safe = true;
    for (let current = absolute; current !== path.resolve(base); current = path.dirname(current)) {
      try { if ((await lstat(current)).isSymbolicLink()) safe = false; } catch { safe = false; }
    }
    if (!safe || !(await realpath(absolute).catch(() => '')).startsWith(realRoot + path.sep)) {
      failures.push({ file: relative, rule: 'missing_file_or_link' }); continue;
    }
    const bytes = await readFile(absolute);
    hashes[relative] = createHash('sha256').update(bytes).digest('hex');
    const bundled = relative.startsWith('dist/') || relative === 'package-lock.json';
    for (const rule of contentFindings(bytes.toString('utf8'), { bundled })) failures.push({ file: relative, rule });
  }
  for (const required of ['.codex-plugin/plugin.json', '.mcp.json', 'dist/server.mjs', 'dist/cli.mjs', 'dist/THIRD_PARTY_NOTICES.txt', 'README.md', 'LICENSE']) {
    if (!files.includes(required)) failures.push({ file: required, rule: 'missing_required_entry' });
  }
  const pkg = JSON.parse(await readFile(path.join(base, 'package.json'), 'utf8'));
  const plugin = JSON.parse(await readFile(path.join(base, '.codex-plugin/plugin.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(base, 'package-lock.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(path.join(base, '.mcp.json'), 'utf8')).mcpServers?.['codex-side-sync'];
  if (pkg.name !== 'codex-side-sync' || plugin.name !== pkg.name || pkg.version !== plugin.version || lock.packages[''].version !== pkg.version || pkg.private !== true) failures.push({ file: 'package.json', rule: 'release_metadata_mismatch' });
  if (plugin.author?.name !== 'Iridium1024' || plugin.interface?.developerName !== 'Iridium1024' || plugin.license !== 'MIT' || pkg.license !== 'MIT') failures.push({ file: '.codex-plugin/plugin.json', rule: 'publisher_or_license_mismatch' });
  if (mcp?.command !== 'node' || mcp.cwd !== '.' || JSON.stringify(mcp.args) !== JSON.stringify(['dist/server.mjs'])) failures.push({ file: '.mcp.json', rule: 'nonportable_entrypoint' });
  for (const value of Object.values(lock.packages)) {
    if (!value.resolved) continue;
    try { const u = new URL(value.resolved); if (u.protocol !== 'https:' || u.hostname !== 'registry.npmjs.org' || u.username || u.password || u.search) throw 0; }
    catch { failures.push({ file: 'package-lock.json', rule: 'nonpublic_dependency_source' }); break; }
  }
  if (failures.length) { const error = new Error('release_audit_failed'); error.findings = failures; throw error; }
  return { status: 'passed', files, hashes, version: pkg.version, secret_scan: 'heuristic_not_certification' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await auditRelease(); console.log(JSON.stringify({ status: report.status, files: report.files.length, secret_scan: report.secret_scan })); }
  catch (error) { console.error(JSON.stringify({ status: 'failed', findings: error.findings ?? [{ rule: 'audit_input_error' }] })); process.exitCode = 1; }
}
