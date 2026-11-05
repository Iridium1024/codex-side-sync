#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { SideService } from './service.mjs';
import { errorResult } from './errors.mjs';

const service = new SideService();
const abort = new AbortController();
const stop = () => { abort.abort(); service.dispose(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
async function call(method, args) {
  if ((method === 'read' || method === 'list') && args.parent_id == null && process.env.CODEX_THREAD_ID) {
    args = { ...args, parent_id: process.env.CODEX_THREAD_ID };
  }
  if (method === 'read') return service.read(args, { signal: abort.signal });
  if (method === 'list') return service.list(args, { signal: abort.signal });
  if (method === 'doctor') return service.doctor();
  return { status: 'invalid_command' };
}
try {
  const [command, payload] = process.argv.slice(2);
  if (command === 'session') {
    // One JSON request per line, retaining only metadata baselines until EOF.
    // Requests are explicit; this mode does not poll or subscribe while idle.
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      let value;
      try { const request = JSON.parse(line); value = await call(request.method, request.arguments ?? {}); }
      catch { value = { status: 'invalid_json' }; }
      process.stdout.write(JSON.stringify(value) + '\n');
    }
  } else if (['read', 'list', 'doctor'].includes(command)) {
    const value = await call(command, payload ? JSON.parse(payload) : {});
    process.stdout.write(JSON.stringify(value) + '\n');
    if (!['ok', 'no_changes', 'partial'].includes(value.status)) process.exitCode = 1;
  } else {
    process.stdout.write('Usage: node dist/cli.mjs doctor | list JSON | read JSON | session\n');
    process.stdout.write('Incremental cursors live only inside a single MCP/CLI session process. No mode is chosen automatically.\n');
    if (command && command !== '--help') process.exitCode = 1;
  }
} catch (e) { process.stdout.write(JSON.stringify(errorResult(e)) + '\n'); process.exitCode = 1; }
finally { service.dispose(); }
