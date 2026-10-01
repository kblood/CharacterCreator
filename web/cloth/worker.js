// Cloth solver worker (module worker in the browser, worker_threads in node tests). It owns one solver per
// garment and runs the same advance() as the synchronous fallback, so both give bit-identical positions.
// Messages in:
//   { type: 'init', key, sim, restX, params }           create / replace the solver of garment `key`
//   { type: 'rest', key, restX }                         new rest shape (body sliders)
//   { type: 'params', key, params }
//   { type: 'job', key, seq, job, stats }                advance(); stats: also measure stretch / penetrations
//   { type: 'drop', key }
// Messages out:
//   { type: 'ready' }
//   { type: 'done', key, seq, x (Float32Array copy), A1ref, C1ref, L1ref (the inputs it was solved against: lag
//     compensation + drawfix.js), steps, resets, ms, stats? }
//   { type: 'error', key, message }
import { createSolver, advance } from './solver.js';

const solvers = new Map();
let port = null;

function handle(msg) {
  const { type, key } = msg;
  try {
    if (type === 'init') solvers.set(key, createSolver(msg.sim, msg.restX, msg.params));
    else if (type === 'rest') solvers.get(key)?.setRest(msg.restX);
    else if (type === 'params') solvers.get(key)?.setParams(msg.params);
    else if (type === 'drop') solvers.delete(key);
    else if (type === 'job') {
      const s = solvers.get(key);
      if (!s) return;
      const t0 = performance.now();
      const x = advance(s, msg.job);
      const ms = performance.now() - t0;
      const out = { type: 'done', key, seq: msg.seq, x: Float32Array.from(x), A1ref: msg.job.A1, C1ref: msg.job.C1, L1ref: msg.job.L1 ?? null, n: msg.job.n,
        settle: msg.job.reset ? msg.job.settle | 0 : 0,
        steps: s.steps, resets: s.resets, ms };
      if (msg.stats) out.stats = { stretch: s.stretch(), pen: s.penetrations(msg.job.C1, msg.job.floorY ?? 0, 0.002, msg.job.limit) };
      port.postMessage(out);
    }
  } catch (e) {
    port.postMessage({ type: 'error', key, message: String(e?.stack || e) });
  }
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof WorkerGlobalScope !== 'undefined') {
  port = self;
  self.onmessage = e => handle(e.data);
} else {
  const { parentPort } = await import('node:worker_threads');
  port = parentPort;
  parentPort.on('message', handle);
}
port.postMessage({ type: 'ready' });
