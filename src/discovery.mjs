import { readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { identity, SideError } from './errors.mjs';

export const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

// Discovery only reads IDs/timestamps. Log text is not parsed or returned.
// Recent candidates are NOT authoritative Side identities; snapshots verify them.
export async function discoverCandidates({ home = codexHome(), lookbackHours = 24,
  limit = 16, now = Date.now() } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const candidates = new Map(), warnings = [], durable = new Set();
  let databaseCount = 0, capped = false;
  for (const dir of [home, path.join(home, 'sqlite')]) {
    let files;
    try { files = await readdir(dir); } catch { continue; }
    const stateFiles = files.filter(f => /^state_\d+\.sqlite$/.test(f));
    for (const file of stateFiles) {
      let db;
      try {
        db = new DatabaseSync(path.join(dir, file), { readOnly: true, enableExtensions: false });
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100;');
        for (const row of db.prepare('SELECT id FROM threads').iterate()) durable.add(row.id);
      } catch { warnings.push('state_index_unavailable'); } finally { db?.close(); }
    }
    for (const file of files.filter(f => /^logs_\d+\.sqlite$/.test(f))) {
      let db;
      try {
        db = new DatabaseSync(path.join(dir, file), { readOnly: true, enableExtensions: false });
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100;');
        const rows = db.prepare('SELECT thread_id, MAX(ts) AS last_seen FROM logs WHERE ts >= ? AND thread_id IS NOT NULL GROUP BY thread_id ORDER BY last_seen DESC LIMIT ?')
          .all(Math.floor(now / 1000 - lookbackHours * 3600), limit * 8 + 1);
        databaseCount++;
        if (rows.length > limit * 8) capped = true;
        for (const row of rows) {
          try { identity(row.thread_id, 'candidate'); } catch { continue; }
          candidates.set(row.thread_id, Math.max(candidates.get(row.thread_id) ?? 0, row.last_seen));
        }
      } catch { warnings.push('log_index_unavailable'); } finally { db?.close(); }
    }
  }
  if (!databaseCount) throw new SideError('discovery_unavailable');
  const sorted = [...candidates].filter(([id]) => !durable.has(id)).sort((a, b) => b[1] - a[1]);
  return { ids: sorted.slice(0, limit).map(([id]) => id),
    capped: capped || sorted.length > limit, warnings: [...new Set(warnings)],
    source: 'recent_log_ids_minus_persisted_threads', exhaustive: false };
}
