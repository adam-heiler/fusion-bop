// Runs the CoolProp-backed solver off the main thread. The solve is a few
// hundred synchronous PropsSI calls into WASM - measured at ~300-400ms per
// call - and while that runs, a normal (main-thread) call blocks *everything*:
// no repaint, no compositing, no CSS animation, regardless of how cheap
// those animations are individually. Moving the computation itself into a
// Worker is the only way to keep the page alive during that stretch; no
// amount of CSS tuning on the main thread can fix a main-thread block.
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
      const { T6C_est, TTD, eta_pump } = e.data;
      self.postMessage({ id, value: minPG(T6C_est, TTD, eta_pump) });
    } else if (type === 'maxPE') {
      const { TTD, Pcond } = e.data;
      self.postMessage({ id, value: maxPE(TTD, Pcond) });
    }
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
