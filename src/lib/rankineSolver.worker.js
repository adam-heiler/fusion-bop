// Runs the CoolProp-backed solver off the main thread. See NOTES.md.
import { init, solveCycle, getDome, minPC, minPG, maxPE } from './rankineSolver.js';

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'init') {
      await init();
      self.postMessage({ id, dome: getDome() });
    } else if (type === 'solve') {
      self.postMessage({ id, result: solveCycle(e.data.params) });
    } else if (type === 'minPC') {
      const { P_D, TTD, eta_pump } = e.data;
      self.postMessage({ id, value: minPC(P_D, TTD, eta_pump) });
    } else if (type === 'minPG') {
      const { T6C_est, TTD, eta_pump, Pcond } = e.data;
      self.postMessage({ id, value: minPG(T6C_est, TTD, eta_pump, Pcond) });
    } else if (type === 'maxPE') {
      const { TTD, Pcond } = e.data;
      self.postMessage({ id, value: maxPE(TTD, Pcond) });
    }
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
