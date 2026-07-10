// Promise-based facade over rankineSolver.worker.js - callers await these
// exactly like they'd await the direct (main-thread) solver calls, but the
// actual computation happens on the worker thread so the page stays
// responsive (painting, compositing, CSS animations) while it runs.
let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./rankineSolver.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(e.data);
    };
  }
  return worker;
}

function call(type, payload) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, type, ...payload });
  });
}

export async function initSolver() {
  const res = await call('init', {});
  return res.dome;
}
export async function solveCycleAsync(params) {
  const res = await call('solve', { params });
  return res.result;
}
export async function minPCAsync(P_D, TTD, eta_pump) {
  const res = await call('minPC', { P_D, TTD, eta_pump });
  return res.value;
}
export async function minPGAsync(T6C_est, TTD, eta_pump) {
  const res = await call('minPG', { T6C_est, TTD, eta_pump });
  return res.value;
}
export async function maxPEAsync(TTD, Pcond) {
  const res = await call('maxPE', { TTD, Pcond });
  return res.value;
}
