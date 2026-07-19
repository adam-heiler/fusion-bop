// Promise-based facade over co2BraytonSolver.worker.js.
let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./co2BraytonSolver.worker.js', import.meta.url), { type: 'module' });
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

export async function initCO2Solver() {
  const res = await call('init', {});
  return res.dome;
}
export async function solveCO2Async(params) {
  const res = await call('solve', { params });
  return res.result;
}
