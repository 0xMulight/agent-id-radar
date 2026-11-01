import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
export function emptyState() { return { schemaVersion: 1, reservations: {}, positions: {}, scan: { lastBlock: null, candidates: {} }, alerts: {}, events: [] }; }
export class Store {
  constructor(path = null) {
    this.path = path; this.lock = null; this.tail = Promise.resolve(); this.state = emptyState();
    if (path) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const lock = path + '.lock';
      try { this.lock = openSync(lock, 'wx', 0o600); } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const old = Number(readFileSync(lock, 'utf8')); let alive = true;
        if (!Number.isSafeInteger(old) || old < 1) throw new Error('Unrecognized state lock; inspect manually');
        try { process.kill(old, 0); } catch (x) { if (x.code === 'ESRCH') alive = false; }
        if (alive) throw new Error('Another Radar process owns this state');
        unlinkSync(lock); this.lock = openSync(lock, 'wx', 0o600);
      }
      writeFileSync(this.lock, String(process.pid)); fsyncSync(this.lock);
      try { if (existsSync(path)) { this.state = JSON.parse(readFileSync(path, 'utf8')); if (this.state.schemaVersion !== 1 || !this.state.reservations || !this.state.positions || !this.state.scan) throw new Error('Unsupported state; do not overwrite'); } }
      catch (e) { this.close(); throw e; }
    }
  }
  snapshot() { return structuredClone(this.state); }
  transaction(fn) {
    const work = this.tail.then(() => {
      const next = structuredClone(this.state), result = fn(next);
      if (result && typeof result.then === 'function') throw new Error('Store mutations must be synchronous');
      if (this.path) {
        const tmp = this.path + '.tmp', fd = openSync(tmp, 'w', 0o600);
        try { writeFileSync(fd, JSON.stringify(next, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(tmp, this.path);
      }
      this.state = next; return result;
    });
    this.tail = work.catch(() => {}); return work;
  }
  event(type, detail, now = Date.now()) {
    return this.transaction(s => { s.events.push({ type, at: now, ...detail }); if (s.events.length > 5000) s.events.splice(0, s.events.length - 5000); });
  }
  close() { if (this.lock !== null) { closeSync(this.lock); this.lock = null; unlinkSync(this.path + '.lock'); } }
}
export class WalletQueue {
  constructor() { this.queues = new Map(); }
  run(wallet, fn) {
    const prior = this.queues.get(wallet) || Promise.resolve(), next = prior.catch(() => {}).then(fn);
    this.queues.set(wallet, next);
    next.finally(() => { if (this.queues.get(wallet) === next) this.queues.delete(wallet); }).catch(() => {});
    return next;
  }
}
