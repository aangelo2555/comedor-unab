// Shared scheduling: paced ordinary traffic, bounded parallel opening POSTs, and provider-wide pauses.
class RequestGate {
  constructor({ concurrency = 2, intervalMs = 500, maxQueue = 1000, openingConcurrency = 50 } = {}) {
    this.concurrency = concurrency;
    this.intervalMs = intervalMs;
    this.maxQueue = maxQueue;
    this.queue = [];
    this.active = 0;
    this.activeOpening = 0;
    this.openingConcurrency = Math.max(1, Math.min(50, openingConcurrency));
    this.openingPermits = new WeakMap();
    this.nextStart = 0;
    this.pausedUntil = 0;
    this.timer = null;
  }

  openBurst({ maxStarts, durationMs = 10000 } = {}) {
    const permit = {};
    this.openingPermits.set(permit, {
      remaining: Math.max(0, Math.min(50, Math.floor(Number(maxStarts) || 0))),
      expiresAt: Date.now() + Math.max(0, Math.min(10000, durationMs))
    });
    return permit;
  }

  run(operation, priority = 0, beforeStart, openingPermit) {
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(
        new Error('La cola de consultas UNAB está llena. Vuelve a intentarlo.')
      );
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ operation, resolve, reject, priority, beforeStart, openingPermit });
      this.queue.sort((a, b) => b.priority - a.priority);
      const permit = openingPermit && this.openingPermits.get(openingPermit);
      this.drain(Boolean(permit && permit.remaining > 0 && Date.now() < permit.expiresAt));
    });
  }

  pause(milliseconds) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + milliseconds);
  }

  drain(force = false) {
    if (this.timer) {
      if (!force) return;
      clearTimeout(this.timer); this.timer = null;
    }
    if (!this.queue.length) return;
    const now = Date.now();
    let selected = -1;
    let opening = false;
    let nextWake = Infinity;
    for (let index = 0; index < this.queue.length;) {
      const job = this.queue[index];
      let early;
      try { early = job.beforeStart?.(); }
      catch (error) { this.queue.splice(index, 1); job.reject(error); continue; }
      if (early !== undefined) { this.queue.splice(index, 1); job.resolve(early); continue; }
      const permit = job.openingPermit && this.openingPermits.get(job.openingPermit);
      const isOpening = Boolean(permit && permit.remaining > 0 && now < permit.expiresAt);
      const hasCapacity = isOpening ? this.activeOpening < this.openingConcurrency : this.active < this.concurrency;
      if (!hasCapacity) { index++; continue; }
      const startAt = Math.max(this.pausedUntil, isOpening ? 0 : this.nextStart);
      if (startAt <= now) { selected = index; opening = isOpening; break; }
      nextWake = Math.min(nextWake, startAt);
      index++;
    }
    if (selected < 0) {
      if (Number.isFinite(nextWake)) this.timer = setTimeout(() => { this.timer = null; this.drain(); }, Math.max(0, nextWake - now));
      return;
    }
    const job = this.queue.splice(selected, 1)[0];
    if (opening) { this.activeOpening++; this.openingPermits.get(job.openingPermit).remaining--; }
    this.active++;
    this.nextStart = Date.now() + this.intervalMs;
    Promise.resolve()
      .then(job.operation)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.active--;
        if (opening) this.activeOpening--;
        this.drain(true);
      });
    this.drain();
  }

}

function retryDelay(header, attempt, now = Date.now()) {
  if (header !== null && header !== undefined && header !== '') {
    const seconds = Number(header);
    const milliseconds = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(header) - now;
    if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
  }
  return Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

module.exports = { RequestGate, retryDelay };
