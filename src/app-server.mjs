import { spawn, execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { SideError, fail, identity } from './errors.mjs';
import { normalizeTurns } from './snapshot.mjs';

const execFileAsync = promisify(execFile);

// Prefer the executable shipped with the Desktop instance. An explicit override
// makes alternate installations and protocol tests possible without shell parsing.
async function findCodex() {
  if (process.env.CODEX_SIDE_SYNC_CODEX) return process.env.CODEX_SIDE_SYNC_CODEX;
  if (process.platform !== 'win32') fail('unsupported_platform');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive',
      '-Command', '(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation'],
    { windowsHide: true, timeout: 5000 });
    const install = stdout.trim();
    if (install) {
      const executable = path.join(install, 'app', 'resources', 'codex.exe');
      await access(executable);
      return executable;
    }
  } catch { /* Try a standalone executable on PATH. */ }
  try {
    const { stdout } = await execFileAsync('where.exe', ['codex.exe'],
      { windowsHide: true, timeout: 5000 });
    const executable = stdout.split(/\r?\n/).find(Boolean)?.trim();
    if (executable) return executable;
  } catch { /* Report a stable error below. */ }
  fail('app_server_unavailable');
}

class RpcSession {
  constructor(child, { signal, timeoutMs, maxLineBytes }) {
    this.child = child;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.nextId = 0;
    this.closed = false;
    this.maxLineBytes = maxLineBytes;
    this.cancel = () => this.stop(new SideError('cancelled'));
    signal?.addEventListener('abort', this.cancel, { once: true });
    this.signal = signal;
    this.finished = new Promise(resolve => child.once('close', resolve));
    this.timer = setTimeout(() => this.stop(new SideError('app_server_timeout')), timeoutMs);
    child.stdout.on('data', chunk => this.onData(chunk));
    child.on('error', () => this.stop(new SideError('app_server_unavailable')));
    child.on('close', () => this.stop(new SideError('app_server_closed')));
    child.stdin.on('error', () => this.stop(new SideError('app_server_closed')));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (!this.closed) {
      const end = this.buffer.indexOf(10);
      if (end < 0) {
        if (this.buffer.length > this.maxLineBytes) this.stop(new SideError('snapshot_too_large'));
        return;
      }
      if (end > this.maxLineBytes) { this.stop(new SideError('snapshot_too_large')); return; }
      const line = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      let message;
      try { message = JSON.parse(line.toString('utf8')); }
      catch { this.stop(new SideError('malformed_frame')); return; }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new SideError('app_server_request_failed', {
        method: pending.method, rpc_code: Number.isInteger(message.error.code) ? message.error.code : null
      }));
      else if (!Object.hasOwn(message, 'result')) pending.reject(new SideError('unsupported_app_server_shape'));
      else pending.resolve(message.result);
    }
  }

  call(method, params) {
    if (this.closed) return Promise.reject(new SideError('app_server_closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  notify(method) {
    if (this.closed) fail('app_server_closed');
    this.child.stdin.write(JSON.stringify({ method }) + '\n');
  }

  stop(error = new SideError('cancelled')) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.signal?.removeEventListener('abort', this.cancel);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.child.stdin.destroy();
    this.child.kill();
  }
}

export class AppServer {
  constructor({ command, args = ['app-server', '--stdio'], platform = process.platform, timeoutMs = 30000,
    maxLineBytes = 32 * 1024 * 1024, maxPages = 100, maxConcurrent = 4 } = {}) {
    Object.assign(this, { command, args, platform, timeoutMs, maxLineBytes, maxPages, maxConcurrent });
    this.active = new Set();
    this.disposed = false;
  }

  async executablePresent() {
    try { await access(this.command ?? await findCodex()); return true; }
    catch { return false; }
  }

  async run(fn, { signal } = {}) {
    if (this.platform !== 'win32') fail('unsupported_platform');
    if (this.disposed || signal?.aborted) fail('cancelled');
    if (this.active.size >= this.maxConcurrent) fail('busy');
    // Reserve the slot before resolving the executable so simultaneous calls are bounded.
    const operation = { session: null };
    this.active.add(operation);
    try {
      const command = this.command ?? await findCodex();
      if (this.disposed || signal?.aborted) fail('cancelled');
      const child = spawn(command, this.args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const rpc = new RpcSession(child, { signal, timeoutMs: this.timeoutMs, maxLineBytes: this.maxLineBytes });
      operation.session = rpc;
      await rpc.call('initialize', { clientInfo: { name: 'codex-side-sync', version: '0.2.0' },
        capabilities: { experimentalApi: true } });
      rpc.notify('initialized');
      return await fn(rpc);
    } finally {
      if (operation.session) {
        operation.session.stop();
        let timeout;
        await Promise.race([operation.session.finished, new Promise(resolve => { timeout = setTimeout(resolve, 2000); })]);
        clearTimeout(timeout);
      }
      this.active.delete(operation);
    }
  }

  async attached(rpc, parentId, { limit = 16, sideId } = {}) {
    // Older servers may ignore unknown JSON fields. Refuse results if a random,
    // unrelated parent also produces entries instead of applying the filter.
    const probe = await rpc.call('thread/list', { attachedToThreadId: randomUUID(),
      useStateDbOnly: true, limit: 1 });
    if (!Array.isArray(probe?.data) || !Object.hasOwn(probe, 'nextCursor')) fail('unsupported_app_server_shape');
    if (probe.data.length || probe.nextCursor != null) fail('attachment_filter_unsupported');
    const rows = [], seen = new Set(), cursors = new Set();
    let cursor = null;
    for (let page = 0; page < this.maxPages; page++) {
      const response = await rpc.call('thread/list', { attachedToThreadId: parentId,
        useStateDbOnly: true, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(response?.data) || !Object.hasOwn(response, 'nextCursor')) fail('unsupported_app_server_shape');
      for (const row of response.data) {
        const id = identity(row?.id, 'candidate');
        if (seen.has(id)) fail('ambiguous_history');
        seen.add(id);
        if (row.ephemeral !== false) fail('unsupported_app_server_shape');
        rows.push({ id, runtimeStatus: typeof row.status?.type === 'string' ? row.status.type : 'unknown' });
        if (sideId === id) return { rows, found: true, capped: false };
        if (!sideId && rows.length > limit) return { rows: rows.slice(0, limit), capped: true };
      }
      const next = response.nextCursor;
      if (next == null) return { rows, found: false, capped: false };
      if (typeof next !== 'string' || !next || cursors.has(next)) fail('snapshot_incomplete');
      cursors.add(next); cursor = next;
    }
    fail('snapshot_incomplete');
  }

  async history(rpc, sideId) {
    const messages = [], warnings = new Set(), seenTurns = new Set(), seenMessages = new Set(), cursors = new Set();
    let historyChars = 0;
    let cursor = null;
    for (let page = 0; page < this.maxPages; page++) {
      const response = await rpc.call('thread/turns/list', { threadId: sideId,
        itemsView: 'full', sortDirection: 'asc', limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(response?.data) || !Object.hasOwn(response, 'nextCursor')) fail('unsupported_app_server_shape');
      for (const turn of response.data) {
        if (typeof turn?.id !== 'string' || !turn.id || seenTurns.has(turn.id) ||
          !Array.isArray(turn.items) || turn.itemsView !== 'full' || typeof turn.status !== 'string') {
          fail('unsupported_app_server_shape');
        }
        if (turn.itemsPagination && (turn.itemsPagination.hasLoadedOldest !== true ||
          turn.itemsPagination.olderCursor != null || turn.itemsPagination.isLoadingOlder)) fail('snapshot_incomplete');
        if (turn.status === 'inProgress') fail('snapshot_incomplete', { reason: 'turn_in_progress', cursor_advanced: false });
        seenTurns.add(turn.id);
        const normalized = normalizeTurns([{ ...turn, turnId: turn.id }]);
        for (const message of normalized.messages) {
          if (seenMessages.has(message.id)) fail('ambiguous_message_id');
          if (messages.length >= 5000) fail('message_limit', { max_messages: 5000 });
          historyChars += message.text.length;
          if (historyChars > 32 * 1024 * 1024) fail('snapshot_too_large');
          seenMessages.add(message.id);
          messages.push(message);
        }
        for (const warning of normalized.warnings) warnings.add(warning);
      }
      const next = response.nextCursor;
      if (next == null) return { messages, warnings: [...warnings] };
      if (typeof next !== 'string' || !next || cursors.has(next)) fail('snapshot_incomplete');
      cursors.add(next); cursor = next;
    }
    fail('snapshot_incomplete');
  }

  async list(parentId, { limit = 16, signal } = {}) {
    identity(parentId, 'parent_id');
    return this.run(rpc => this.attached(rpc, parentId, { limit }), { signal });
  }

  async contains(parentId, sideId, { signal } = {}) {
    identity(parentId, 'parent_id'); identity(sideId, 'side_id');
    return this.run(async rpc => (await this.attached(rpc, parentId, { sideId })).found, { signal });
  }

  async read(parentId, sideId, { signal } = {}) {
    identity(parentId, 'parent_id'); identity(sideId, 'side_id');
    const started = performance.now();
    return this.run(async rpc => {
      const matches = await this.attached(rpc, parentId, { sideId });
      if (!matches.found) fail('parent_mismatch');
      const first = await this.history(rpc, sideId);
      const second = await this.history(rpc, sideId);
      const digest = view => createHash('sha256').update(JSON.stringify(view)).digest('hex');
      if (digest(first) !== digest(second)) fail('snapshot_incomplete', { reason: 'history_changed', cursor_advanced: false });
      if (!(await this.attached(rpc, parentId, { sideId })).found) fail('parent_mismatch');
      return { view: { identity: { host_id: 'local', parent_id: parentId, side_id: sideId },
        complete: true, completeness_source: 'two_matching_app_server_scans_not_transactional',
        ...second, runtime_status: matches.rows.find(row => row.id === sideId).runtimeStatus },
      durationMs: performance.now() - started };
    }, { signal });
  }

  dispose() {
    this.disposed = true;
    for (const operation of this.active) operation.session?.stop();
  }
}
