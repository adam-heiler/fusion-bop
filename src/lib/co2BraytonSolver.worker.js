// Runs the CO2 Brayton solver off the main thread, same pattern as
// rankineSolver.worker.js (see NOTES.md, "Worker offload").
import { init, solveCycle, getDome } from './co2BraytonSolver.js';

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'init') {
      await init();
      self.postMessage({ id, dome: getDome() });
    } else if (type === 'solve') {
      self.postMessage({ id, result: solveCycle(e.data.params) });
    }
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
