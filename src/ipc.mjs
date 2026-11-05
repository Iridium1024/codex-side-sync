import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { SideError, identity } from './errors.mjs';

export const ENDPOINT = '\\\\.\\pipe\\codex-ipc';
export const SNAPSHOT_VERSION = 11;

// A fresh connection per call. This client never owns a thread or starts a router.
// Its only outbound methods are discovery, initialize, following true/false,
// and negative responses to discovery requests addressed to this temporary client.
export class DesktopIpc {
  constructor({ endpoint = ENDPOINT, platform = process.platform,
    maxFrameBytes = 32 * 1024 * 1024, setupTimeoutMs = 5000,
    snapshotTimeoutMs = 5000, cleanupTimeoutMs = 300,
    maxConcurrent = 4 } = {}) {
    Object.assign(this, { endpoint, platform, maxFrameBytes, setupTimeoutMs,
      snapshotTimeoutMs, cleanupTimeoutMs, maxConcurrent });
    this.active = new Set();
    this.disposed = false;
  }

  discover(sideId, { signal, targetClientId } = {}) {
    return this.run(identity(sideId, 'side_id'), { signal, targetClientId, snapshot: false });
  }
  snapshot(sideId, { signal } = {}) {
    return this.run(identity(sideId, 'side_id'), { signal, snapshot: true });
  }
  dispose() {
    this.disposed = true;
    for (const cancel of [...this.active]) cancel();
  }

  run(sideId, { signal, targetClientId, snapshot }) {
    if (this.platform !== 'win32') return Promise.reject(new SideError('unsupported_platform'));
    if (this.disposed || signal?.aborted) return Promise.reject(new SideError('cancelled'));
    if (this.active.size >= this.maxConcurrent) return Promise.reject(new SideError('busy'));
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const socket = net.createConnection(this.endpoint);
      const discoveryId = randomUUID(), initId = randomUUID();
      let clientId = `side-sync-${randomUUID()}`, ownerId = null;
      let registered = false, following = false, closing = false;
      let result, failure, subscribedAt = null, unsubscribeFlushed = false;
      let header = Buffer.alloc(4), headerUsed = 0, frame = null, frameUsed = 0;
      let cleanupTimer;
      const cancel = () => finish(new SideError('cancelled'));
      this.active.add(cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      let timer = setTimeout(() => finish(new SideError('setup_timeout')), this.setupTimeoutMs);
      const send = (message, callback) => {
        const body = Buffer.from(JSON.stringify(message));
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32LE(body.length);
        socket.write(Buffer.concat([prefix, body]), callback);
      };
      const follow = (value, cb) => send({ type: 'broadcast',
        method: 'thread-stream-following-changed', version: 1, sourceClientId: clientId,
        targetClientIds: [ownerId], params: { hostId: 'local', conversationId: sideId,
          following: value } }, cb);

      // Explicit unsubscribe first; socket close is the router's fallback removal.
      // No ack exists for this broadcast: report flush, not a fabricated server ack.
      function finish(error, value) {
        if (closing) return;
        closing = true;
        failure = error;
        result = value;
        clearTimeout(timer);
        cleanupTimer = setTimeout(() => socket.destroy(), thisCleanupMs);
        if (following && socket.writable && !socket.destroyed) {
          try { follow(false, err => { unsubscribeFlushed = !err; socket.end(); }); }
          catch { socket.destroy(); }
        } else socket.end();
      }
      const thisCleanupMs = this.cleanupTimeoutMs;
      const handle = message => {
        if (message.type === 'client-discovery-request') {
          send({ type: 'client-discovery-response', requestId: message.requestId,
            response: { canHandle: false } });
          return;
        }
        if (message.type === 'response' && message.requestId === discoveryId) {
          if (message.resultType !== 'success' || typeof message.handledByClientId !== 'string') {
            finish(new SideError('side_unavailable')); return;
          }
          ownerId = message.handledByClientId;
          if (!snapshot) { finish(null, { ownerId }); return; }
          send({ type: 'request', requestId: initId, sourceClientId: clientId,
            method: 'initialize', version: 0,
            params: { clientType: 'side-readonly-diagnostic' }, timeoutMs: this.setupTimeoutMs });
          return;
        }
        if (message.type === 'response' && message.requestId === initId && !registered) {
          if (message.resultType !== 'success' || typeof message.result?.clientId !== 'string') {
            finish(new SideError('registration_failed')); return;
          }
          registered = true; clientId = message.result.clientId; following = true;
          subscribedAt = performance.now();
          clearTimeout(timer);
          timer = setTimeout(() => finish(new SideError('snapshot_timeout')), this.snapshotTimeoutMs);
          follow(true); return;
        }
        if (!following || message.type !== 'broadcast' || message.method !== 'thread-stream-state-changed'
          || message.sourceClientId !== ownerId || message.params?.hostId !== 'local'
          || message.params?.conversationId !== sideId || message.params?.change?.type !== 'snapshot') return;
        if (message.targetClientIds && !message.targetClientIds.includes(clientId)) return;
        if (message.version !== SNAPSHOT_VERSION) {
          finish(new SideError('protocol_mismatch', { expected: SNAPSHOT_VERSION,
            received: Number.isSafeInteger(message.version) ? message.version : null })); return;
        }
        const state = message.params.change.conversationState;
        if (!state || state.id !== sideId) { finish(new SideError('identity_mismatch')); return; }
        finish(null, { state, ownerId, subscriptionMs: performance.now() - subscribedAt });
      };
      socket.on('connect', () => {
        if (closing) return;
        send({ type: 'request', requestId: discoveryId, sourceClientId: clientId,
          method: 'thread-owner-discovery', version: 1,
          ...(targetClientId ? { targetClientId } : {}),
          params: { hostId: 'local', conversationId: sideId }, timeoutMs: this.setupTimeoutMs });
      });
      socket.on('data', chunk => {
        if (closing) return;
        try {
          let offset = 0;
          while (offset < chunk.length && !closing) {
            if (!frame) {
              const size = Math.min(4 - headerUsed, chunk.length - offset);
              chunk.copy(header, headerUsed, offset, offset + size);
              offset += size; headerUsed += size;
              if (headerUsed < 4) break;
              const length = header.readUInt32LE(0); headerUsed = 0;
              if (!length || length > this.maxFrameBytes) {
                finish(new SideError('snapshot_too_large', { max_frame_bytes: this.maxFrameBytes })); break;
              }
              frame = Buffer.allocUnsafe(length); frameUsed = 0;
            }
            const size = Math.min(frame.length - frameUsed, chunk.length - offset);
            chunk.copy(frame, frameUsed, offset, offset + size);
            frameUsed += size; offset += size;
            if (frameUsed === frame.length) {
              const message = JSON.parse(frame.toString('utf8')); frame = null;
              handle(message);
            }
          }
        } catch { finish(new SideError('malformed_frame')); }
      });
      socket.on('error', () => { finish(new SideError('ipc_unavailable')); socket.destroy(); });
      socket.on('end', () => { finish(new SideError('connection_closed')); socket.destroy(); });
      socket.on('close', () => {
        if (!closing) failure = new SideError('connection_closed');
        closing = true;
        clearTimeout(timer); clearTimeout(cleanupTimer);
        this.active.delete(cancel); signal?.removeEventListener('abort', cancel);
        frame = null; header = null;
        const cleanup = { connection_closed: true, registered,
          unsubscribe_flushed: unsubscribeFlushed };
        if (failure) reject(failure);
        else resolve({ ...result, temporaryClientId: registered ? clientId : null,
          durationMs: performance.now() - started, cleanup });
        result = null;
      });
    });
  }
}
