import { createHash, randomUUID } from 'node:crypto';
import { fail } from './errors.mjs';

export const fingerprint = message => createHash('sha256').update(JSON.stringify(message)).digest('hex');
const bindingKey = binding => JSON.stringify([binding.host_id, binding.parent_id, binding.side_id, binding.consumer_id]);

// Immutable checkpoints: retrying an old cursor never silently advances it.
// Only IDs and fingerprints are retained, never messages or snapshots.
export class CursorStore {
  constructor({ ttlMs = 10 * 60 * 1000, maxEntries = 128, maxFingerprints = 50000,
    now = Date.now } = {}) {
    Object.assign(this, { ttlMs, maxEntries, maxFingerprints, now });
    this.entries = new Map();
    this.timer = setInterval(() => this.prune(), Math.min(ttlMs, 30000));
    this.timer.unref();
  }
  prune() {
    for (const [key, value] of this.entries) if (value.expires <= this.now()) this.entries.delete(key);
  }
  get(cursor, binding) {
    this.prune();
    const value = this.entries.get(cursor);
    if (!value) fail('cursor_expired');
    if (value.binding !== bindingKey(binding)) fail('cursor_mismatch');
    return value;
  }
  put(binding, messages, runtimeStatus, hashes = new Map(messages.map(m => [m.id, fingerprint(m)])), backend) {
    this.prune();
    if (messages.length > this.maxFingerprints) fail('cursor_capacity');
    let size = [...this.entries.values()].reduce((n, v) => n + v.hashes.size, 0);
    while (this.entries.size && (this.entries.size >= this.maxEntries || size + messages.length > this.maxFingerprints)) {
      const key = this.entries.keys().next().value;
      size -= this.entries.get(key).hashes.size; this.entries.delete(key);
    }
    const cursor = randomUUID();
    this.entries.set(cursor, { binding: bindingKey(binding),
      hashes,
      order: messages.map(m => m.id), runtimeStatus, backend,
      expires: this.now() + this.ttlMs });
    return cursor;
  }
  delta(baseline, messages, hashes = new Map(messages.map(m => [m.id, fingerprint(m)]))) {
    const retained = messages.filter(m => baseline.hashes.has(m.id)).map(m => m.id);
    const priorRetained = baseline.order.filter(id => hashes.has(id));
    if (JSON.stringify(retained) !== JSON.stringify(priorRetained)) fail('history_reordered');
    return { added: messages.flatMap((m, index) => baseline.hashes.has(m.id) ? [] :
      [{ ...m, after_id: index ? messages[index - 1].id : null }]),
      updated: messages.filter(m => baseline.hashes.has(m.id) && baseline.hashes.get(m.id) !== hashes.get(m.id)),
      removed_ids: baseline.order.filter(id => !hashes.has(id)) };
  }
  dispose() { clearInterval(this.timer); this.entries.clear(); }
}
