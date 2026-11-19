// One shared budget for every UNAB request made by this server process.
class RequestGate {
  constructor({ concurrency = 2, intervalMs = 500, maxQueue = 1000 } = {}) {
    this.concurrency = concurrency;
    this.intervalMs = intervalMs;
    this.maxQueue = maxQueue;
    this.queue = [];
    this.active = 0;
    this.nextStart = 0;
    this.pausedUntil = 0;
    this.timer = null;
  }

  run(operation, priority = 0) {
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(
        new Error('La cola de consultas UNAB está llena. Vuelve a intentarlo.')
      );
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ operation, resolve, reject, priority });
      this.queue.sort((a, b) => b.priority - a.priority);
      this.drain();
    });
  }

  pause(milliseconds) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + milliseconds);
  }

  drain() {
    if (
      this.timer ||
      this.active >= this.concurrency ||
      this.queue.length === 0
    )
      return;
    const delay = Math.max(this.nextStart, this.pausedUntil) - Date.now();
    if (delay > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, delay);
      return;
    }
    const job = this.queue.shift();
    this.active++;
    this.nextStart = Date.now() + this.intervalMs;
    Promise.resolve()
      .then(job.operation)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.active--;
        this.drain();
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
