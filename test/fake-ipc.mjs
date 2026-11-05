import net from 'node:net';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { OWNER, SIDE, snapshot } from './fixtures.mjs';

export async function fakeIpc(options = {}) {
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\side-sync-test-${randomUUID()}` : path.join(os.tmpdir(), `side-sync-test-${randomUUID()}.sock`);
  const sockets = new Set(), clients = new Set(), followers = new Set(), sent = [];
  const states = options.states ?? new Map([[SIDE, snapshot()]]);
  const server = net.createServer(socket => {
    sockets.add(socket); let buffer = Buffer.alloc(0), client;
    const write = (m, fragment = false) => {
      if (!socket.writable || socket.destroyed) return;
      const bytes = Buffer.from(JSON.stringify(m)); const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
      const frame = Buffer.concat([header, bytes]);
      if (fragment) { socket.write(frame.subarray(0, 2)); setImmediate(() => { if (!socket.destroyed) socket.write(frame.subarray(2)); }); }
      else socket.write(frame);
    };
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const n = buffer.readUInt32LE(0); if (buffer.length < n + 4) return;
        const m = JSON.parse(buffer.subarray(4, n + 4).toString()); buffer = buffer.subarray(n + 4);
        sent.push(m);
        if (m.method === 'thread-owner-discovery') {
          if (options.noDiscovery) continue;
          const valid = states.has(m.params.conversationId) && (!m.targetClientId || clients.has(m.targetClientId));
          write({ type: 'response', requestId: m.requestId, resultType: valid ? 'success' : 'error',
            handledByClientId: valid ? OWNER : undefined, error: valid ? undefined : 'no-client-found' });
        } else if (m.method === 'initialize') {
          client = randomUUID(); clients.add(client);
          write({ type: 'response', requestId: m.requestId, resultType: 'success', result: { clientId: client } });
        } else if (m.method === 'thread-stream-following-changed') {
          if (!m.params.following) { followers.delete(client); continue; }
          followers.add(client);
          if (options.onSubscribe) options.onSubscribe();
          if (options.disconnect) { socket.destroy(); continue; }
          if (options.noSnapshot) continue;
          if (options.oversize) { const h = Buffer.alloc(4); h.writeUInt32LE(options.oversize); socket.write(h); continue; }
          if (options.malformed) { socket.write(Buffer.from([1, 0, 0, 0, 123])); continue; }
          const event = { type: 'broadcast', method: 'thread-stream-state-changed', version: options.version ?? 11,
            sourceClientId: OWNER, targetClientIds: [client], params: { hostId: 'local', conversationId: m.params.conversationId,
              change: { type: 'snapshot', revision: 1, conversationState: states.get(m.params.conversationId) } } };
          if (options.noise) {
            write({ ...event, sourceClientId: 'wrong-owner' });
            write({ ...event, targetClientIds: ['wrong-recipient'] });
            write({ type: 'client-discovery-request', requestId: 'noise', request: {} });
          }
          write(event, options.fragment);
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); clients.delete(client); followers.delete(client); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  return { endpoint, states, sent, clients, followers,
    async close() { for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
