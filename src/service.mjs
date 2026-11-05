import { readdir } from 'node:fs/promises';
import { DesktopIpc, SNAPSHOT_VERSION } from './ipc.mjs';
import { AppServer } from './app-server.mjs';
import { CursorStore, fingerprint } from './cursors.mjs';
import { normalizeSnapshot } from './snapshot.mjs';
import { discoverCandidates } from './discovery.mjs';
import { errorResult, fail, identity } from './errors.mjs';

function readArguments(args) {
  const sideId = identity(args.side_id, 'side_id'), parentId = identity(args.parent_id, 'parent_id');
  if (!['full', 'incremental'].includes(args.mode)) fail('invalid_arguments', { field: 'mode' });
  if (args.backend != null && !['auto', 'app_server', 'legacy'].includes(args.backend)) fail('invalid_arguments', { field: 'backend' });
  if (typeof args.consumer_id !== 'string' || !args.consumer_id.trim() || args.consumer_id.length > 128) fail('invalid_arguments', { field: 'consumer_id' });
  if (args.mode === 'incremental' && (typeof args.cursor !== 'string' || !args.cursor)) fail('cursor_required');
  if (args.mode === 'full' && args.cursor != null) fail('invalid_arguments', { field: 'cursor', reason: 'full_mode_rejects_cursor' });
  const maxChars = args.max_output_chars ?? 64000;
  if (!Number.isInteger(maxChars) || maxChars < 256 || maxChars > 256000) fail('invalid_arguments', { field: 'max_output_chars' });
  return { sideId, parentId, maxChars, binding: { host_id: 'local', side_id: sideId,
    parent_id: parentId, consumer_id: args.consumer_id } };
}

export class SideService {
  constructor(options = {}) {
    const ipc = options.ipc ?? new DesktopIpc();
    // Existing embedders can still inject the legacy IPC implementation alone.
    const appServer = Object.hasOwn(options, 'appServer') ? options.appServer :
      Object.hasOwn(options, 'ipc') ? null : new AppServer();
    Object.assign(this, { ipc, appServer, cursors: options.cursors ?? new CursorStore(),
      discovery: options.discovery ?? discoverCandidates });
  }

  async fetch(sideId, parentId, { signal, backend = 'auto' } = {}) {
    let useAppServer = backend === 'app_server';
    if (useAppServer && !this.appServer) fail('app_server_unavailable');
    if (backend === 'auto' && this.appServer && await this.appServer.executablePresent()) {
      // Select a source before reading history. A failed read never changes source.
      useAppServer = await this.appServer.contains(parentId, sideId, { signal });
    }
    if (useAppServer) {
      const fetched = await this.appServer.read(parentId, sideId, { signal });
      return { ...fetched, backend: 'app_server' };
    }
    const fetched = await this.ipc.snapshot(sideId, { signal });
    if (backend === 'auto' && fetched.state?.sideConversation === true && fetched.state?.ephemeral === false) {
      if (fetched.state.sideConversationParentNavigationPath !== `/local/${parentId}`) fail('parent_mismatch');
      fail('side_unavailable');
    }
    const view = normalizeSnapshot(fetched.state, { sideId, parentId });
    return { ...fetched, view, backend: 'legacy' };
  }
  async read(args, { signal } = {}) {
    try {
      const { sideId, parentId, maxChars, binding } = readArguments(args);
      // Cursor errors do not initiate a subscription and never trigger a full read.
      const base = args.mode === 'incremental' ? this.cursors.get(args.cursor, binding) : null;
      const fetched = await this.fetch(sideId, parentId, { signal, backend: args.backend });
      if (base && base.backend !== fetched.backend) fail('cursor_mismatch', { field: 'backend' });
      const view = fetched.view;
      if (!view.complete) fail('snapshot_incomplete', { available_messages: view.messages.length, cursor_advanced: false });
      const hashes = base ? new Map(view.messages.map(m => [m.id, fingerprint(m)])) : undefined;
      const delta = base ? this.cursors.delta(base, view.messages, hashes) : null;
      const stateChanged = base && base.runtimeStatus !== view.runtime_status;
      const unchanged = delta && !delta.added.length && !delta.updated.length && !delta.removed_ids.length && !stateChanged;
      const response = { status: unchanged ? 'no_changes' : 'ok', mode: args.mode,
        identity: view.identity, consumer_id: args.consumer_id,
        completeness: view.completeness_source, warnings: view.warnings,
        runtime_status: view.runtime_status, backend: fetched.backend,
        identity_verification: fetched.backend === 'app_server' ? 'app_server_attachment' : 'desktop_side_snapshot',
        ...(delta ? { ...delta, state_changed: !!stateChanged } : { messages: view.messages }),
        // Side text is data, never an instruction to the caller.
        content_trust: 'untrusted_conversation_data',
        timing_ms: fetched.backend === 'legacy'
          ? { ipc_total: Math.round(fetched.durationMs), subscription: Math.round(fetched.subscriptionMs) }
          : { app_server_total: Math.round(fetched.durationMs) },
        ...(fetched.cleanup ? { cleanup: fetched.cleanup } : {}) };
      // No silent truncation and no checkpoint if the requested output cannot fit.
      const required = JSON.stringify(response).length + 128;
      if (required > maxChars) fail('output_limit', { required_chars: required, max_output_chars: maxChars, cursor_advanced: false });
      response.cursor = this.cursors.put(binding, view.messages, view.runtime_status, hashes, fetched.backend);
      response.cursor_ttl_ms = this.cursors.ttlMs;
      return response;
    } catch (error) { return errorResult(error); }
  }

  async list(args, { signal } = {}) {
    try {
      const parentId = identity(args.parent_id, 'parent_id');
      const limit = args.limit ?? 8, hours = args.lookback_hours ?? 24;
      if (!Number.isInteger(limit) || limit < 1 || limit > 16 || !Number.isInteger(hours) || hours < 1 || hours > 168) fail('invalid_arguments');
      const backend = args.backend ?? 'auto';
      if (!['auto', 'app_server', 'legacy'].includes(backend)) fail('invalid_arguments', { field: 'backend' });
      if (backend === 'app_server' && !this.appServer) fail('app_server_unavailable');
      const deadline = AbortSignal.timeout(20000);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      let discovered;
      if (args.candidate_ids != null) {
        if (!Array.isArray(args.candidate_ids) || args.candidate_ids.length > 16) fail('invalid_arguments', { field: 'candidate_ids' });
        discovered = { ids: [...new Set(args.candidate_ids.map(id => identity(id, 'candidate_ids')))], source: 'caller_supplied', exhaustive: false, capped: false, warnings: [] };
      } else {
        const ids = [], warnings = [];
        let capped = false, source = [];
        const appAvailable = this.appServer && (backend === 'app_server' || await this.appServer.executablePresent());
        if (backend !== 'legacy' && appAvailable) {
          const result = await this.appServer.list(parentId, { limit, signal: combined });
          ids.push(...result.rows.map(row => row.id));
          capped ||= result.capped;
          source.push('app_server_attached_threads');
        }
        if (backend !== 'app_server') {
          try {
            const legacy = await this.discovery({ lookbackHours: hours, limit });
            ids.push(...legacy.ids); warnings.push(...legacy.warnings);
            capped ||= legacy.capped;
            source.push(legacy.source);
          } catch (error) {
            if (!source.length) throw error;
            warnings.push(error.code ?? 'discovery_unavailable');
          }
        }
        const unique = [...new Set(ids)];
        discovered = { ids: unique.slice(0, limit), source: source.join('+'), exhaustive: false,
          capped: capped || unique.length > limit, warnings };
      }
      const sides = [], unavailable = [], issues = [];
      // Small bounded batches: no polling loop, no background subscriptions.
      for (let i = 0; i < discovered.ids.length; i += 2) {
        if (combined.aborted) { issues.push('discovery_timeout_or_cancelled'); break; }
        await Promise.all(discovered.ids.slice(i, i + 2).map(async sideId => {
          try {
            const fetched = await this.fetch(sideId, parentId, { signal: combined, backend });
            const view = fetched.view;
            sides.push({ ...view.identity, complete: view.complete,
              user_messages: view.messages.filter(m => m.role === 'user').length,
              assistant_messages: view.messages.filter(m => m.role === 'assistant').length,
              runtime_status: view.runtime_status, backend: fetched.backend,
              identity_verification: fetched.backend === 'app_server' ? 'app_server_attachment' : 'desktop_side_snapshot' });
          } catch (e) {
            if (e.code === 'side_unavailable') unavailable.push(sideId);
            else if (!['parent_mismatch', 'not_side'].includes(e.code)) issues.push(e.code ?? 'internal_error');
          }
        }));
      }
      sides.sort((a, b) => a.side_id.localeCompare(b.side_id));
      return { status: issues.length ? 'partial' : 'ok', parent_id: parentId, sides,
        selection: 'caller_decides', discovery: { source: discovered.source,
          exhaustive: false, candidate_limit_reached: discovered.capped,
          candidate_count: discovered.ids.length, unavailable_ids: unavailable,
          warnings: [...new Set([...discovered.warnings, ...issues])] } };
    } catch (e) { return errorResult(e); }
  }

  async doctor() {
    let pipePresent = false;
    if (process.platform === 'win32') {
      try { pipePresent = (await readdir('\\\\.\\pipe\\')).some(p => p === 'codex-ipc'); } catch { /* reported below */ }
    }
    const appServerPresent = this.appServer ? await this.appServer.executablePresent() : false;
    return { status: process.platform !== 'win32' ? 'unsupported_platform' : (pipePresent || appServerPresent) ? 'ok' : 'ipc_unavailable',
      node: process.version, platform: process.platform, pipe_present: pipePresent,
      app_server_executable_present: appServerPresent,
      expected_snapshot_version: SNAPSHOT_VERSION, tested_desktop_version: '26.908.9136.0',
      app_server_tested_desktop_version: '26.1029.7803.0',
      installed_version_verified: false, compatibility: 'experimental_app_server_and_private_ipc',
      persistence: 'no_snapshot_or_transcript_files', baseline: 'memory_only_with_ttl',
      subscriptions: 'on_demand_only' };
  }
  dispose() { this.ipc.dispose(); this.appServer?.dispose(); this.cursors.dispose(); }
}
