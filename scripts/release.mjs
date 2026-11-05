import { spawnSync } from 'node:child_process';
import { auditRelease, root } from './release-audit.mjs';
import { mkdir, lstat, realpath, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { zipSync, unzipSync } from 'fflate';

function run(command, args) {
  const r = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (r.error || r.status !== 0) throw new Error('release_gate_failed');
}
try {
  run(process.execPath, ['scripts/build.mjs']);
  run(process.execPath, ['--test', 'test/*.test.mjs']);
  const report = await auditRelease();
  const entries = {};
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const relative of report.files) {
    const bytes = await readFile(path.join(root, relative));
    if (digest(bytes) !== report.hashes[relative]) throw new Error('source_changed_after_audit');
    entries['codex-side-sync/' + relative] = bytes;
  }
  const zip = zipSync(entries, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
  const unpacked = unzipSync(zip);
  if (Object.keys(unpacked).length !== report.files.length) throw new Error('archive_entry_mismatch');
  for (const relative of report.files) {
    if (digest(unpacked['codex-side-sync/' + relative]) !== report.hashes[relative]) throw new Error('archive_hash_mismatch');
  }
  const output = path.join(root, 'release');
  await mkdir(output, { recursive: true });
  if ((await lstat(output)).isSymbolicLink() || path.dirname(await realpath(output)) !== await realpath(root)) throw new Error('unsafe_release_directory');
  const name = `codex-side-sync-${report.version}-${randomUUID().slice(0, 8)}.zip`;
  const archivePath = path.join(output, name);
  await writeFile(archivePath, zip, { flag: 'wx' });
  const storedHash = digest(await readFile(archivePath));
  if (storedHash !== digest(zip)) throw new Error('stored_archive_hash_mismatch');
  console.log(JSON.stringify({ status: 'created_and_verified', archive: name, files: report.files.length, bytes: zip.length, sha256: storedHash }));
} catch (error) { console.error(JSON.stringify({ status: 'failed', reason: error.message, findings: error.findings })); process.exitCode = 1; }
