#!/usr/bin/env node
import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// src/cli.mjs
import { createInterface } from "node:readline/promises";

// src/service.mjs
import { readdir as readdir2 } from "node:fs/promises";

// src/ipc.mjs
import net from "node:net";
import { randomUUID } from "node:crypto";

// src/errors.mjs
var SideError = class extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
};
function fail(code, details) {
  throw new SideError(code, details);
}
function errorResult(error) {
  return {
    status: error instanceof SideError ? error.code : "internal_error",
    ...error instanceof SideError ? { details: error.details } : {}
  };
}
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function identity(value, field) {
  if (typeof value !== "string" || !UUID.test(value)) fail("invalid_arguments", { field });
  return value.toLowerCase();
}

// src/ipc.mjs
var ENDPOINT = "\\\\.\\pipe\\codex-ipc";
var SNAPSHOT_VERSION = 11;
var DesktopIpc = class {
  constructor({
    endpoint = ENDPOINT,
    platform = process.platform,
    maxFrameBytes = 32 * 1024 * 1024,
    setupTimeoutMs = 5e3,
    snapshotTimeoutMs = 5e3,
    cleanupTimeoutMs = 300,
    maxConcurrent = 4
  } = {}) {
    Object.assign(this, {
      endpoint,
      platform,
      maxFrameBytes,
      setupTimeoutMs,
      snapshotTimeoutMs,
      cleanupTimeoutMs,
      maxConcurrent
    });
    this.active = /* @__PURE__ */ new Set();
    this.disposed = false;
  }
  discover(sideId, { signal, targetClientId } = {}) {
    return this.run(identity(sideId, "side_id"), { signal, targetClientId, snapshot: false });
  }
  snapshot(sideId, { signal } = {}) {
    return this.run(identity(sideId, "side_id"), { signal, snapshot: true });
  }
  dispose() {
    this.disposed = true;
    for (const cancel of [...this.active]) cancel();
  }
  run(sideId, { signal, targetClientId, snapshot }) {
    if (this.platform !== "win32") return Promise.reject(new SideError("unsupported_platform"));
    if (this.disposed || signal?.aborted) return Promise.reject(new SideError("cancelled"));
    if (this.active.size >= this.maxConcurrent) return Promise.reject(new SideError("busy"));
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const socket = net.createConnection(this.endpoint);
      const discoveryId = randomUUID(), initId = randomUUID();
      let clientId = `side-sync-${randomUUID()}`, ownerId = null;
      let registered = false, following = false, closing = false;
      let result, failure, subscribedAt = null, unsubscribeFlushed = false;
      let header = Buffer.alloc(4), headerUsed = 0, frame = null, frameUsed = 0;
      let cleanupTimer;
      const cancel = () => finish(new SideError("cancelled"));
      this.active.add(cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      let timer = setTimeout(() => finish(new SideError("setup_timeout")), this.setupTimeoutMs);
      const send = (message, callback) => {
        const body = Buffer.from(JSON.stringify(message));
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32LE(body.length);
        socket.write(Buffer.concat([prefix, body]), callback);
      };
      const follow = (value, cb) => send({
        type: "broadcast",
        method: "thread-stream-following-changed",
        version: 1,
        sourceClientId: clientId,
        targetClientIds: [ownerId],
        params: {
          hostId: "local",
          conversationId: sideId,
          following: value
        }
      }, cb);
      function finish(error, value) {
        if (closing) return;
        closing = true;
        failure = error;
        result = value;
        clearTimeout(timer);
        cleanupTimer = setTimeout(() => socket.destroy(), thisCleanupMs);
        if (following && socket.writable && !socket.destroyed) {
          try {
            follow(false, (err) => {
              unsubscribeFlushed = !err;
              socket.end();
            });
          } catch {
            socket.destroy();
          }
        } else socket.end();
      }
      const thisCleanupMs = this.cleanupTimeoutMs;
      const handle = (message) => {
        if (message.type === "client-discovery-request") {
          send({
            type: "client-discovery-response",
            requestId: message.requestId,
            response: { canHandle: false }
          });
          return;
        }
        if (message.type === "response" && message.requestId === discoveryId) {
          if (message.resultType !== "success" || typeof message.handledByClientId !== "string") {
            finish(new SideError("side_unavailable"));
            return;
          }
          ownerId = message.handledByClientId;
          if (!snapshot) {
            finish(null, { ownerId });
            return;
          }
          send({
            type: "request",
            requestId: initId,
            sourceClientId: clientId,
            method: "initialize",
            version: 0,
            params: { clientType: "side-readonly-diagnostic" },
            timeoutMs: this.setupTimeoutMs
          });
          return;
        }
        if (message.type === "response" && message.requestId === initId && !registered) {
          if (message.resultType !== "success" || typeof message.result?.clientId !== "string") {
            finish(new SideError("registration_failed"));
            return;
          }
          registered = true;
          clientId = message.result.clientId;
          following = true;
          subscribedAt = performance.now();
          clearTimeout(timer);
          timer = setTimeout(() => finish(new SideError("snapshot_timeout")), this.snapshotTimeoutMs);
          follow(true);
          return;
        }
        if (!following || message.type !== "broadcast" || message.method !== "thread-stream-state-changed" || message.sourceClientId !== ownerId || message.params?.hostId !== "local" || message.params?.conversationId !== sideId || message.params?.change?.type !== "snapshot") return;
        if (message.targetClientIds && !message.targetClientIds.includes(clientId)) return;
        if (message.version !== SNAPSHOT_VERSION) {
          finish(new SideError("protocol_mismatch", {
            expected: SNAPSHOT_VERSION,
            received: Number.isSafeInteger(message.version) ? message.version : null
          }));
          return;
        }
        const state = message.params.change.conversationState;
        if (!state || state.id !== sideId) {
          finish(new SideError("identity_mismatch"));
          return;
        }
        finish(null, { state, ownerId, subscriptionMs: performance.now() - subscribedAt });
      };
      socket.on("connect", () => {
        if (closing) return;
        send({
          type: "request",
          requestId: discoveryId,
          sourceClientId: clientId,
          method: "thread-owner-discovery",
          version: 1,
          ...targetClientId ? { targetClientId } : {},
          params: { hostId: "local", conversationId: sideId },
          timeoutMs: this.setupTimeoutMs
        });
      });
      socket.on("data", (chunk) => {
        if (closing) return;
        try {
          let offset = 0;
          while (offset < chunk.length && !closing) {
            if (!frame) {
              const size2 = Math.min(4 - headerUsed, chunk.length - offset);
              chunk.copy(header, headerUsed, offset, offset + size2);
              offset += size2;
              headerUsed += size2;
              if (headerUsed < 4) break;
              const length = header.readUInt32LE(0);
              headerUsed = 0;
              if (!length || length > this.maxFrameBytes) {
                finish(new SideError("snapshot_too_large", { max_frame_bytes: this.maxFrameBytes }));
                break;
              }
              frame = Buffer.allocUnsafe(length);
              frameUsed = 0;
            }
            const size = Math.min(frame.length - frameUsed, chunk.length - offset);
            chunk.copy(frame, frameUsed, offset, offset + size);
            frameUsed += size;
            offset += size;
            if (frameUsed === frame.length) {
              const message = JSON.parse(frame.toString("utf8"));
              frame = null;
              handle(message);
            }
          }
        } catch {
          finish(new SideError("malformed_frame"));
        }
      });
      socket.on("error", () => {
        finish(new SideError("ipc_unavailable"));
        socket.destroy();
      });
      socket.on("end", () => {
        finish(new SideError("connection_closed"));
        socket.destroy();
      });
      socket.on("close", () => {
        if (!closing) failure = new SideError("connection_closed");
        closing = true;
        clearTimeout(timer);
        clearTimeout(cleanupTimer);
        this.active.delete(cancel);
        signal?.removeEventListener("abort", cancel);
        frame = null;
        header = null;
        const cleanup = {
          connection_closed: true,
          registered,
          unsubscribe_flushed: unsubscribeFlushed
        };
        if (failure) reject(failure);
        else resolve({
          ...result,
          temporaryClientId: registered ? clientId : null,
          durationMs: performance.now() - started,
          cleanup
        });
        result = null;
      });
    });
  }
};

// src/app-server.mjs
import { spawn, execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { randomUUID as randomUUID2, createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

// src/snapshot.mjs
function normalizeSnapshot(state, { sideId, parentId, maxMessages = 5e3 } = {}) {
  sideId = identity(sideId, "side_id");
  parentId = identity(parentId, "parent_id");
  if (state?.id !== sideId || state.hostId !== "local") fail("identity_mismatch");
  if (state.sideConversation !== true || state.ephemeral !== true) fail("not_side");
  if (state.forkedFromId !== parentId || state.sideConversationParentNavigationPath !== `/local/${parentId}`) fail("parent_mismatch");
  let turns, complete = false;
  const history = state.turnHistory;
  if (history?.kind === "canonical") {
    const h = history.history;
    if (!Array.isArray(h?.islands) || !h?.entitiesByKey || typeof h.isComplete !== "boolean") fail("unsupported_snapshot_shape");
    turns = [];
    const entities = /* @__PURE__ */ new Set();
    for (const island of h.islands) {
      if (!Array.isArray(island.entries)) fail("unsupported_snapshot_shape");
      for (const entry of island.entries) {
        if (typeof entry.value !== "string" || !Object.hasOwn(h.entitiesByKey, entry.value)) fail("unsupported_snapshot_shape");
        if (entities.has(entry.value)) fail("ambiguous_history");
        entities.add(entry.value);
        turns.push(h.entitiesByKey[entry.value]);
      }
    }
    complete = h.isComplete === true;
  } else if (history == null && Array.isArray(state.turns)) {
    turns = state.turns;
    complete = state.turnsPagination?.hasLoadedOldest === true && state.turnsPagination?.olderCursor == null;
  } else fail("unsupported_snapshot_shape");
  if (state.turnsPagination?.hasLoadedOldest === false || state.turnsPagination?.isLoadingOlder || state.turnsPagination?.olderCursor != null) complete = false;
  for (const turn of turns) {
    if (turn?.itemsPagination && (turn.itemsPagination.hasLoadedOldest !== true || turn.itemsPagination.olderCursor != null || turn.itemsPagination.isLoadingOlder)) complete = false;
  }
  const { messages, warnings } = normalizeTurns(turns, maxMessages);
  return {
    identity: { host_id: "local", parent_id: parentId, side_id: sideId },
    complete,
    completeness_source: "desktop_snapshot_flags_not_independently_verified",
    messages,
    warnings,
    runtime_status: typeof state.threadRuntimeStatus?.type === "string" ? state.threadRuntimeStatus.type : "unknown"
  };
}
function normalizeTurns(turns, maxMessages = 5e3) {
  const messages = [], ids = /* @__PURE__ */ new Set(), warnings = /* @__PURE__ */ new Set();
  for (const turn of turns) {
    if (!turn || !Array.isArray(turn.items)) fail("unsupported_snapshot_shape");
    for (const item of turn.items) {
      if (item?.type !== "userMessage" && item?.type !== "agentMessage") continue;
      if (typeof item.id !== "string" || !item.id || ids.has(item.id)) fail("ambiguous_message_id");
      if (messages.length >= maxMessages) fail("message_limit", { max_messages: maxMessages });
      ids.add(item.id);
      let text, nonText = false;
      if (item.type === "agentMessage") {
        if (typeof item.text !== "string") fail("assistant_content_unavailable");
        text = item.text;
      } else {
        if (!Array.isArray(item.content)) fail("unsupported_snapshot_shape");
        if (item.content.some((x) => x?.type === "text" && typeof x.text !== "string")) fail("unsupported_snapshot_shape");
        text = item.content.filter((x) => x?.type === "text").map((x) => x.text).join("\n");
        nonText = item.content.some((x) => x?.type !== "text");
        if (nonText) warnings.add("non_text_content_not_returned");
      }
      messages.push({
        id: item.id,
        turn_id: typeof turn.turnId === "string" ? turn.turnId : null,
        role: item.type === "agentMessage" ? "assistant" : "user",
        text,
        phase: typeof item.phase === "string" ? item.phase : null,
        turn_status: typeof turn.status === "string" ? turn.status : null,
        has_non_text_content: nonText
      });
    }
  }
  return { messages, warnings: [...warnings] };
}

// src/app-server.mjs
var execFileAsync = promisify(execFile);
async function findCodex() {
  if (process.env.CODEX_SIDE_SYNC_CODEX) return process.env.CODEX_SIDE_SYNC_CODEX;
  if (process.platform !== "win32") fail("unsupported_platform");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation"
      ],
      { windowsHide: true, timeout: 5e3 }
    );
    const install = stdout.trim();
    if (install) {
      const executable = path.join(install, "app", "resources", "codex.exe");
      await access(executable);
      return executable;
    }
  } catch {
  }
  try {
    const { stdout } = await execFileAsync(
      "where.exe",
      ["codex.exe"],
      { windowsHide: true, timeout: 5e3 }
    );
    const executable = stdout.split(/\r?\n/).find(Boolean)?.trim();
    if (executable) return executable;
  } catch {
  }
  fail("app_server_unavailable");
}
var RpcSession = class {
  constructor(child, { signal, timeoutMs, maxLineBytes }) {
    this.child = child;
    this.pending = /* @__PURE__ */ new Map();
    this.buffer = Buffer.alloc(0);
    this.nextId = 0;
    this.closed = false;
    this.maxLineBytes = maxLineBytes;
    this.cancel = () => this.stop(new SideError("cancelled"));
    signal?.addEventListener("abort", this.cancel, { once: true });
    this.signal = signal;
    this.finished = new Promise((resolve) => child.once("close", resolve));
    this.timer = setTimeout(() => this.stop(new SideError("app_server_timeout")), timeoutMs);
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.on("error", () => this.stop(new SideError("app_server_unavailable")));
    child.on("close", () => this.stop(new SideError("app_server_closed")));
    child.stdin.on("error", () => this.stop(new SideError("app_server_closed")));
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (!this.closed) {
      const end = this.buffer.indexOf(10);
      if (end < 0) {
        if (this.buffer.length > this.maxLineBytes) this.stop(new SideError("snapshot_too_large"));
        return;
      }
      if (end > this.maxLineBytes) {
        this.stop(new SideError("snapshot_too_large"));
        return;
      }
      const line = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      let message;
      try {
        message = JSON.parse(line.toString("utf8"));
      } catch {
        this.stop(new SideError("malformed_frame"));
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new SideError("app_server_request_failed", {
        method: pending.method,
        rpc_code: Number.isInteger(message.error.code) ? message.error.code : null
      }));
      else if (!Object.hasOwn(message, "result")) pending.reject(new SideError("unsupported_app_server_shape"));
      else pending.resolve(message.result);
    }
  }
  call(method, params) {
    if (this.closed) return Promise.reject(new SideError("app_server_closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  notify(method) {
    if (this.closed) fail("app_server_closed");
    this.child.stdin.write(JSON.stringify({ method }) + "\n");
  }
  stop(error = new SideError("cancelled")) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.cancel);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.child.stdin.destroy();
    this.child.kill();
  }
};
var AppServer = class {
  constructor({
    command,
    args = ["app-server", "--stdio"],
    platform = process.platform,
    timeoutMs = 3e4,
    maxLineBytes = 32 * 1024 * 1024,
    maxPages = 100,
    maxConcurrent = 4
  } = {}) {
    Object.assign(this, { command, args, platform, timeoutMs, maxLineBytes, maxPages, maxConcurrent });
    this.active = /* @__PURE__ */ new Set();
    this.disposed = false;
  }
  async executablePresent() {
    try {
      await access(this.command ?? await findCodex());
      return true;
    } catch {
      return false;
    }
  }
  async run(fn, { signal } = {}) {
    if (this.platform !== "win32") fail("unsupported_platform");
    if (this.disposed || signal?.aborted) fail("cancelled");
    if (this.active.size >= this.maxConcurrent) fail("busy");
    const operation = { session: null };
    this.active.add(operation);
    try {
      const command = this.command ?? await findCodex();
      if (this.disposed || signal?.aborted) fail("cancelled");
      const child = spawn(command, this.args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      const rpc = new RpcSession(child, { signal, timeoutMs: this.timeoutMs, maxLineBytes: this.maxLineBytes });
      operation.session = rpc;
      await rpc.call("initialize", {
        clientInfo: { name: "codex-side-sync", version: "0.2.0" },
        capabilities: { experimentalApi: true }
      });
      rpc.notify("initialized");
      return await fn(rpc);
    } finally {
      if (operation.session) {
        operation.session.stop();
        let timeout;
        await Promise.race([operation.session.finished, new Promise((resolve) => {
          timeout = setTimeout(resolve, 2e3);
        })]);
        clearTimeout(timeout);
      }
      this.active.delete(operation);
    }
  }
  async attached(rpc, parentId, { limit = 16, sideId } = {}) {
    const probe = await rpc.call("thread/list", {
      attachedToThreadId: randomUUID2(),
      useStateDbOnly: true,
      limit: 1
    });
    if (!Array.isArray(probe?.data) || !Object.hasOwn(probe, "nextCursor")) fail("unsupported_app_server_shape");
    if (probe.data.length || probe.nextCursor != null) fail("attachment_filter_unsupported");
    const rows = [], seen = /* @__PURE__ */ new Set(), cursors = /* @__PURE__ */ new Set();
    let cursor = null;
    for (let page = 0; page < this.maxPages; page++) {
      const response = await rpc.call("thread/list", {
        attachedToThreadId: parentId,
        useStateDbOnly: true,
        limit: 100,
        ...cursor ? { cursor } : {}
      });
      if (!Array.isArray(response?.data) || !Object.hasOwn(response, "nextCursor")) fail("unsupported_app_server_shape");
      for (const row of response.data) {
        const id = identity(row?.id, "candidate");
        if (seen.has(id)) fail("ambiguous_history");
        seen.add(id);
        if (row.ephemeral !== false) fail("unsupported_app_server_shape");
        rows.push({ id, runtimeStatus: typeof row.status?.type === "string" ? row.status.type : "unknown" });
        if (sideId === id) return { rows, found: true, capped: false };
        if (!sideId && rows.length > limit) return { rows: rows.slice(0, limit), capped: true };
      }
      const next = response.nextCursor;
      if (next == null) return { rows, found: false, capped: false };
      if (typeof next !== "string" || !next || cursors.has(next)) fail("snapshot_incomplete");
      cursors.add(next);
      cursor = next;
    }
    fail("snapshot_incomplete");
  }
  async history(rpc, sideId) {
    const messages = [], warnings = /* @__PURE__ */ new Set(), seenTurns = /* @__PURE__ */ new Set(), seenMessages = /* @__PURE__ */ new Set(), cursors = /* @__PURE__ */ new Set();
    let historyChars = 0;
    let cursor = null;
    for (let page = 0; page < this.maxPages; page++) {
      const response = await rpc.call("thread/turns/list", {
        threadId: sideId,
        itemsView: "full",
        sortDirection: "asc",
        limit: 100,
        ...cursor ? { cursor } : {}
      });
      if (!Array.isArray(response?.data) || !Object.hasOwn(response, "nextCursor")) fail("unsupported_app_server_shape");
      for (const turn of response.data) {
        if (typeof turn?.id !== "string" || !turn.id || seenTurns.has(turn.id) || !Array.isArray(turn.items) || turn.itemsView !== "full" || typeof turn.status !== "string") {
          fail("unsupported_app_server_shape");
        }
        if (turn.itemsPagination && (turn.itemsPagination.hasLoadedOldest !== true || turn.itemsPagination.olderCursor != null || turn.itemsPagination.isLoadingOlder)) fail("snapshot_incomplete");
        if (turn.status === "inProgress") fail("snapshot_incomplete", { reason: "turn_in_progress", cursor_advanced: false });
        seenTurns.add(turn.id);
        const normalized = normalizeTurns([{ ...turn, turnId: turn.id }]);
        for (const message of normalized.messages) {
          if (seenMessages.has(message.id)) fail("ambiguous_message_id");
          if (messages.length >= 5e3) fail("message_limit", { max_messages: 5e3 });
          historyChars += message.text.length;
          if (historyChars > 32 * 1024 * 1024) fail("snapshot_too_large");
          seenMessages.add(message.id);
          messages.push(message);
        }
        for (const warning of normalized.warnings) warnings.add(warning);
      }
      const next = response.nextCursor;
      if (next == null) return { messages, warnings: [...warnings] };
      if (typeof next !== "string" || !next || cursors.has(next)) fail("snapshot_incomplete");
      cursors.add(next);
      cursor = next;
    }
    fail("snapshot_incomplete");
  }
  async list(parentId, { limit = 16, signal } = {}) {
    identity(parentId, "parent_id");
    return this.run((rpc) => this.attached(rpc, parentId, { limit }), { signal });
  }
  async contains(parentId, sideId, { signal } = {}) {
    identity(parentId, "parent_id");
    identity(sideId, "side_id");
    return this.run(async (rpc) => (await this.attached(rpc, parentId, { sideId })).found, { signal });
  }
  async read(parentId, sideId, { signal } = {}) {
    identity(parentId, "parent_id");
    identity(sideId, "side_id");
    const started = performance.now();
    return this.run(async (rpc) => {
      const matches = await this.attached(rpc, parentId, { sideId });
      if (!matches.found) fail("parent_mismatch");
      const first = await this.history(rpc, sideId);
      const second = await this.history(rpc, sideId);
      const digest = (view) => createHash("sha256").update(JSON.stringify(view)).digest("hex");
      if (digest(first) !== digest(second)) fail("snapshot_incomplete", { reason: "history_changed", cursor_advanced: false });
      if (!(await this.attached(rpc, parentId, { sideId })).found) fail("parent_mismatch");
      return {
        view: {
          identity: { host_id: "local", parent_id: parentId, side_id: sideId },
          complete: true,
          completeness_source: "two_matching_app_server_scans_not_transactional",
          ...second,
          runtime_status: matches.rows.find((row) => row.id === sideId).runtimeStatus
        },
        durationMs: performance.now() - started
      };
    }, { signal });
  }
  dispose() {
    this.disposed = true;
    for (const operation of this.active) operation.session?.stop();
  }
};

// src/cursors.mjs
import { createHash as createHash2, randomUUID as randomUUID3 } from "node:crypto";
var fingerprint = (message) => createHash2("sha256").update(JSON.stringify(message)).digest("hex");
var bindingKey = (binding) => JSON.stringify([binding.host_id, binding.parent_id, binding.side_id, binding.consumer_id]);
var CursorStore = class {
  constructor({
    ttlMs = 10 * 60 * 1e3,
    maxEntries = 128,
    maxFingerprints = 5e4,
    now = Date.now
  } = {}) {
    Object.assign(this, { ttlMs, maxEntries, maxFingerprints, now });
    this.entries = /* @__PURE__ */ new Map();
    this.timer = setInterval(() => this.prune(), Math.min(ttlMs, 3e4));
    this.timer.unref();
  }
  prune() {
    for (const [key, value] of this.entries) if (value.expires <= this.now()) this.entries.delete(key);
  }
  get(cursor, binding) {
    this.prune();
    const value = this.entries.get(cursor);
    if (!value) fail("cursor_expired");
    if (value.binding !== bindingKey(binding)) fail("cursor_mismatch");
    return value;
  }
  put(binding, messages, runtimeStatus, hashes = new Map(messages.map((m) => [m.id, fingerprint(m)])), backend) {
    this.prune();
    if (messages.length > this.maxFingerprints) fail("cursor_capacity");
    let size = [...this.entries.values()].reduce((n, v) => n + v.hashes.size, 0);
    while (this.entries.size && (this.entries.size >= this.maxEntries || size + messages.length > this.maxFingerprints)) {
      const key = this.entries.keys().next().value;
      size -= this.entries.get(key).hashes.size;
      this.entries.delete(key);
    }
    const cursor = randomUUID3();
    this.entries.set(cursor, {
      binding: bindingKey(binding),
      hashes,
      order: messages.map((m) => m.id),
      runtimeStatus,
      backend,
      expires: this.now() + this.ttlMs
    });
    return cursor;
  }
  delta(baseline, messages, hashes = new Map(messages.map((m) => [m.id, fingerprint(m)]))) {
    const retained = messages.filter((m) => baseline.hashes.has(m.id)).map((m) => m.id);
    const priorRetained = baseline.order.filter((id) => hashes.has(id));
    if (JSON.stringify(retained) !== JSON.stringify(priorRetained)) fail("history_reordered");
    return {
      added: messages.flatMap((m, index) => baseline.hashes.has(m.id) ? [] : [{ ...m, after_id: index ? messages[index - 1].id : null }]),
      updated: messages.filter((m) => baseline.hashes.has(m.id) && baseline.hashes.get(m.id) !== hashes.get(m.id)),
      removed_ids: baseline.order.filter((id) => !hashes.has(id))
    };
  }
  dispose() {
    clearInterval(this.timer);
    this.entries.clear();
  }
};

// src/discovery.mjs
import { readdir } from "node:fs/promises";
import path2 from "node:path";
import os from "node:os";
var codexHome = () => process.env.CODEX_HOME || path2.join(os.homedir(), ".codex");
async function discoverCandidates({
  home = codexHome(),
  lookbackHours = 24,
  limit = 16,
  now = Date.now()
} = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const candidates = /* @__PURE__ */ new Map(), warnings = [], durable = /* @__PURE__ */ new Set();
  let databaseCount = 0, capped = false;
  for (const dir of [home, path2.join(home, "sqlite")]) {
    let files;
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    const stateFiles = files.filter((f) => /^state_\d+\.sqlite$/.test(f));
    for (const file of stateFiles) {
      let db;
      try {
        db = new DatabaseSync(path2.join(dir, file), { readOnly: true, enableExtensions: false });
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100;");
        for (const row of db.prepare("SELECT id FROM threads").iterate()) durable.add(row.id);
      } catch {
        warnings.push("state_index_unavailable");
      } finally {
        db?.close();
      }
    }
    for (const file of files.filter((f) => /^logs_\d+\.sqlite$/.test(f))) {
      let db;
      try {
        db = new DatabaseSync(path2.join(dir, file), { readOnly: true, enableExtensions: false });
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100;");
        const rows = db.prepare("SELECT thread_id, MAX(ts) AS last_seen FROM logs WHERE ts >= ? AND thread_id IS NOT NULL GROUP BY thread_id ORDER BY last_seen DESC LIMIT ?").all(Math.floor(now / 1e3 - lookbackHours * 3600), limit * 8 + 1);
        databaseCount++;
        if (rows.length > limit * 8) capped = true;
        for (const row of rows) {
          try {
            identity(row.thread_id, "candidate");
          } catch {
            continue;
          }
          candidates.set(row.thread_id, Math.max(candidates.get(row.thread_id) ?? 0, row.last_seen));
        }
      } catch {
        warnings.push("log_index_unavailable");
      } finally {
        db?.close();
      }
    }
  }
  if (!databaseCount) throw new SideError("discovery_unavailable");
  const sorted = [...candidates].filter(([id]) => !durable.has(id)).sort((a, b) => b[1] - a[1]);
  return {
    ids: sorted.slice(0, limit).map(([id]) => id),
    capped: capped || sorted.length > limit,
    warnings: [...new Set(warnings)],
    source: "recent_log_ids_minus_persisted_threads",
    exhaustive: false
  };
}

// src/service.mjs
function readArguments(args) {
  const sideId = identity(args.side_id, "side_id"), parentId = identity(args.parent_id, "parent_id");
  if (!["full", "incremental"].includes(args.mode)) fail("invalid_arguments", { field: "mode" });
  if (args.backend != null && !["auto", "app_server", "legacy"].includes(args.backend)) fail("invalid_arguments", { field: "backend" });
  if (typeof args.consumer_id !== "string" || !args.consumer_id.trim() || args.consumer_id.length > 128) fail("invalid_arguments", { field: "consumer_id" });
  if (args.mode === "incremental" && (typeof args.cursor !== "string" || !args.cursor)) fail("cursor_required");
  if (args.mode === "full" && args.cursor != null) fail("invalid_arguments", { field: "cursor", reason: "full_mode_rejects_cursor" });
  const maxChars = args.max_output_chars ?? 64e3;
  if (!Number.isInteger(maxChars) || maxChars < 256 || maxChars > 256e3) fail("invalid_arguments", { field: "max_output_chars" });
  return { sideId, parentId, maxChars, binding: {
    host_id: "local",
    side_id: sideId,
    parent_id: parentId,
    consumer_id: args.consumer_id
  } };
}
var SideService = class {
  constructor(options = {}) {
    const ipc = options.ipc ?? new DesktopIpc();
    const appServer = Object.hasOwn(options, "appServer") ? options.appServer : Object.hasOwn(options, "ipc") ? null : new AppServer();
    Object.assign(this, {
      ipc,
      appServer,
      cursors: options.cursors ?? new CursorStore(),
      discovery: options.discovery ?? discoverCandidates
    });
  }
  async fetch(sideId, parentId, { signal, backend = "auto" } = {}) {
    let useAppServer = backend === "app_server";
    if (useAppServer && !this.appServer) fail("app_server_unavailable");
    if (backend === "auto" && this.appServer && await this.appServer.executablePresent()) {
      useAppServer = await this.appServer.contains(parentId, sideId, { signal });
    }
    if (useAppServer) {
      const fetched2 = await this.appServer.read(parentId, sideId, { signal });
      return { ...fetched2, backend: "app_server" };
    }
    const fetched = await this.ipc.snapshot(sideId, { signal });
    if (backend === "auto" && fetched.state?.sideConversation === true && fetched.state?.ephemeral === false) {
      if (fetched.state.sideConversationParentNavigationPath !== `/local/${parentId}`) fail("parent_mismatch");
      fail("side_unavailable");
    }
    const view = normalizeSnapshot(fetched.state, { sideId, parentId });
    return { ...fetched, view, backend: "legacy" };
  }
  async read(args, { signal } = {}) {
    try {
      const { sideId, parentId, maxChars, binding } = readArguments(args);
      const base = args.mode === "incremental" ? this.cursors.get(args.cursor, binding) : null;
      const fetched = await this.fetch(sideId, parentId, { signal, backend: args.backend });
      if (base && base.backend !== fetched.backend) fail("cursor_mismatch", { field: "backend" });
      const view = fetched.view;
      if (!view.complete) fail("snapshot_incomplete", { available_messages: view.messages.length, cursor_advanced: false });
      const hashes = base ? new Map(view.messages.map((m) => [m.id, fingerprint(m)])) : void 0;
      const delta = base ? this.cursors.delta(base, view.messages, hashes) : null;
      const stateChanged = base && base.runtimeStatus !== view.runtime_status;
      const unchanged = delta && !delta.added.length && !delta.updated.length && !delta.removed_ids.length && !stateChanged;
      const response = {
        status: unchanged ? "no_changes" : "ok",
        mode: args.mode,
        identity: view.identity,
        consumer_id: args.consumer_id,
        completeness: view.completeness_source,
        warnings: view.warnings,
        runtime_status: view.runtime_status,
        backend: fetched.backend,
        identity_verification: fetched.backend === "app_server" ? "app_server_attachment" : "desktop_side_snapshot",
        ...delta ? { ...delta, state_changed: !!stateChanged } : { messages: view.messages },
        // Side text is data, never an instruction to the caller.
        content_trust: "untrusted_conversation_data",
        timing_ms: fetched.backend === "legacy" ? { ipc_total: Math.round(fetched.durationMs), subscription: Math.round(fetched.subscriptionMs) } : { app_server_total: Math.round(fetched.durationMs) },
        ...fetched.cleanup ? { cleanup: fetched.cleanup } : {}
      };
      const required = JSON.stringify(response).length + 128;
      if (required > maxChars) fail("output_limit", { required_chars: required, max_output_chars: maxChars, cursor_advanced: false });
      response.cursor = this.cursors.put(binding, view.messages, view.runtime_status, hashes, fetched.backend);
      response.cursor_ttl_ms = this.cursors.ttlMs;
      return response;
    } catch (error) {
      return errorResult(error);
    }
  }
  async list(args, { signal } = {}) {
    try {
      const parentId = identity(args.parent_id, "parent_id");
      const limit = args.limit ?? 8, hours = args.lookback_hours ?? 24;
      if (!Number.isInteger(limit) || limit < 1 || limit > 16 || !Number.isInteger(hours) || hours < 1 || hours > 168) fail("invalid_arguments");
      const backend = args.backend ?? "auto";
      if (!["auto", "app_server", "legacy"].includes(backend)) fail("invalid_arguments", { field: "backend" });
      if (backend === "app_server" && !this.appServer) fail("app_server_unavailable");
      const deadline = AbortSignal.timeout(2e4);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      let discovered;
      if (args.candidate_ids != null) {
        if (!Array.isArray(args.candidate_ids) || args.candidate_ids.length > 16) fail("invalid_arguments", { field: "candidate_ids" });
        discovered = { ids: [...new Set(args.candidate_ids.map((id) => identity(id, "candidate_ids")))], source: "caller_supplied", exhaustive: false, capped: false, warnings: [] };
      } else {
        const ids = [], warnings = [];
        let capped = false, source = [];
        const appAvailable = this.appServer && (backend === "app_server" || await this.appServer.executablePresent());
        if (backend !== "legacy" && appAvailable) {
          const result = await this.appServer.list(parentId, { limit, signal: combined });
          ids.push(...result.rows.map((row) => row.id));
          capped ||= result.capped;
          source.push("app_server_attached_threads");
        }
        if (backend !== "app_server") {
          try {
            const legacy = await this.discovery({ lookbackHours: hours, limit });
            ids.push(...legacy.ids);
            warnings.push(...legacy.warnings);
            capped ||= legacy.capped;
            source.push(legacy.source);
          } catch (error) {
            if (!source.length) throw error;
            warnings.push(error.code ?? "discovery_unavailable");
          }
        }
        const unique = [...new Set(ids)];
        discovered = {
          ids: unique.slice(0, limit),
          source: source.join("+"),
          exhaustive: false,
          capped: capped || unique.length > limit,
          warnings
        };
      }
      const sides = [], unavailable = [], issues = [];
      for (let i = 0; i < discovered.ids.length; i += 2) {
        if (combined.aborted) {
          issues.push("discovery_timeout_or_cancelled");
          break;
        }
        await Promise.all(discovered.ids.slice(i, i + 2).map(async (sideId) => {
          try {
            const fetched = await this.fetch(sideId, parentId, { signal: combined, backend });
            const view = fetched.view;
            sides.push({
              ...view.identity,
              complete: view.complete,
              user_messages: view.messages.filter((m) => m.role === "user").length,
              assistant_messages: view.messages.filter((m) => m.role === "assistant").length,
              runtime_status: view.runtime_status,
              backend: fetched.backend,
              identity_verification: fetched.backend === "app_server" ? "app_server_attachment" : "desktop_side_snapshot"
            });
          } catch (e) {
            if (e.code === "side_unavailable") unavailable.push(sideId);
            else if (!["parent_mismatch", "not_side"].includes(e.code)) issues.push(e.code ?? "internal_error");
          }
        }));
      }
      sides.sort((a, b) => a.side_id.localeCompare(b.side_id));
      return {
        status: issues.length ? "partial" : "ok",
        parent_id: parentId,
        sides,
        selection: "caller_decides",
        discovery: {
          source: discovered.source,
          exhaustive: false,
          candidate_limit_reached: discovered.capped,
          candidate_count: discovered.ids.length,
          unavailable_ids: unavailable,
          warnings: [.../* @__PURE__ */ new Set([...discovered.warnings, ...issues])]
        }
      };
    } catch (e) {
      return errorResult(e);
    }
  }
  async doctor() {
    let pipePresent = false;
    if (process.platform === "win32") {
      try {
        pipePresent = (await readdir2("\\\\.\\pipe\\")).some((p) => p === "codex-ipc");
      } catch {
      }
    }
    const appServerPresent = this.appServer ? await this.appServer.executablePresent() : false;
    return {
      status: process.platform !== "win32" ? "unsupported_platform" : pipePresent || appServerPresent ? "ok" : "ipc_unavailable",
      node: process.version,
      platform: process.platform,
      pipe_present: pipePresent,
      app_server_executable_present: appServerPresent,
      expected_snapshot_version: SNAPSHOT_VERSION,
      tested_desktop_version: "26.908.9136.0",
      app_server_tested_desktop_version: "26.1029.7803.0",
      installed_version_verified: false,
      compatibility: "experimental_app_server_and_private_ipc",
      persistence: "no_snapshot_or_transcript_files",
      baseline: "memory_only_with_ttl",
      subscriptions: "on_demand_only"
    };
  }
  dispose() {
    this.ipc.dispose();
    this.appServer?.dispose();
    this.cursors.dispose();
  }
};

// src/cli.mjs
var service = new SideService();
var abort = new AbortController();
var stop = () => {
  abort.abort();
  service.dispose();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
async function call(method, args) {
  if ((method === "read" || method === "list") && args.parent_id == null && process.env.CODEX_THREAD_ID) {
    args = { ...args, parent_id: process.env.CODEX_THREAD_ID };
  }
  if (method === "read") return service.read(args, { signal: abort.signal });
  if (method === "list") return service.list(args, { signal: abort.signal });
  if (method === "doctor") return service.doctor();
  return { status: "invalid_command" };
}
try {
  const [command, payload] = process.argv.slice(2);
  if (command === "session") {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      let value;
      try {
        const request = JSON.parse(line);
        value = await call(request.method, request.arguments ?? {});
      } catch {
        value = { status: "invalid_json" };
      }
      process.stdout.write(JSON.stringify(value) + "\n");
    }
  } else if (["read", "list", "doctor"].includes(command)) {
    const value = await call(command, payload ? JSON.parse(payload) : {});
    process.stdout.write(JSON.stringify(value) + "\n");
    if (!["ok", "no_changes", "partial"].includes(value.status)) process.exitCode = 1;
  } else {
    process.stdout.write("Usage: node dist/cli.mjs doctor | list JSON | read JSON | session\n");
    process.stdout.write("Incremental cursors live only inside a single MCP/CLI session process. No mode is chosen automatically.\n");
    if (command && command !== "--help") process.exitCode = 1;
  }
} catch (e) {
  process.stdout.write(JSON.stringify(errorResult(e)) + "\n");
  process.exitCode = 1;
} finally {
  service.dispose();
}
