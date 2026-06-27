import CoolPropModule from './coolprop/coolprop.js';

const W = 'Water';
const C2K = 273.15;
const BAR = 1e5;

let CP = null;
let _dome = null;

export async function init() {
  if (CP) return;
  CP = await CoolPropModule();
  _dome = _buildDome();
}

export function getDome() { return _dome; }

function Q(out, n1, v1, n2, v2) {
  return CP.PropsSI(out, n1, v1, n2, v2, W);
}

function wetbulb(T, RH) {
  return (
    T * Math.atan(0.151977 * Math.sqrt(RH + 8.313659)) +
    Math.atan(T + RH) -
    Math.atan(RH - 1.676331) +
    0.00391838 * Math.pow(RH, 1.5) * Math.atan(0.023101 * RH) -
    4.686035
  );
}

function expand(h, s, Pout, eta) {
  const hs = Q('H', 'P', Pout, 'S', s);
  return h - eta * (h - hs);
}

function compress(h, s, Pout, eta) {
  const hs = Q('H', 'P', Pout, 'S', s);
  return h + (hs - h) / eta;
}

function satH(P) { return Q('H', 'P', P, 'Q', 0); }
function satT(P) { return Q('T', 'P', P, 'Q', 0); }

function fwhH(Pshell, Pfw, TTD) {
  return Q('H', 'P', Pfw, 'T', satT(Pshell) - TTD);
}

function drainH(Pshell, subcool) {
  const hsat = satH(Pshell);
  const cp = Q('CPMASS', 'P', Pshell, 'Q', 0);
  return hsat - subcool * cp;
}

function _buildDome() {
  const Tmin = 273.16, Tcrit = 647.096;
  const N = 80;
  const liq = [], vap = [];
  for (let i = 0; i <= N; i++) {
    const T = Tmin + (Tcrit - Tmin) * i / N;
    try {
      liq.push([Q('S', 'T', T, 'Q', 0) / 1000, T - C2K]);
      vap.push([Q('S', 'T', T, 'Q', 1) / 1000, T - C2K]);
    } catch (_) {}
  }
  return { liq, vap };
}

export function solveCycle(p) {
  const TTD = p.TTD, sub = p.subcool, eta_p = p.eta_pump;

  // Cooling tower / condenser
  const T_wb = wetbulb(p.T0, p.RH);
  const T6C = T_wb + p.cw_approach + p.cond_TTD;
  const P6 = Q('P', 'T', T6C + C2K, 'Q', 0);
  const h6 = satH(P6);
  const s6 = Q('S', 'P', P6, 'Q', 0);
  const P5 = P6;

  // Boiler outlet (supercritical)
  const P1 = p.P1 * BAR;
  const T1 = p.T1 + C2K;
  const h1 = Q('H', 'P', P1, 'T', T1);
  const s1 = Q('S', 'P', P1, 'T', T1);

  // HP turbine
  const P2 = p.P2 * BAR;
  const h2 = expand(h1, s1, P2, p.eta_HP);
  const s2 = Q('S', 'P', P2, 'H', h2);
  const T2 = Q('T', 'P', P2, 'H', h2);

  const P_B = p.P_B * BAR;
  const h_b1 = expand(h1, s1, P_B, p.eta_HP);

  // Reheater
  const P3 = P2 * (1 - p.reheat_dP_pct / 100);
  const T3 = p.T3 + C2K;
  const h3 = Q('H', 'P', P3, 'T', T3);
  const s3 = Q('S', 'P', P3, 'T', T3);

  // IP turbine
  const P4 = p.P4 * BAR;
  const h4 = expand(h3, s3, P4, p.eta_IP);
  const s4 = Q('S', 'P', P4, 'H', h4);
  const T4 = Q('T', 'P', P4, 'H', h4);

  const P_C = p.P_C * BAR;
  const h_c1 = expand(h3, s3, P_C, p.eta_IP);
  const P_D = p.P_D * BAR;
  const h_d1 = expand(h3, s3, P_D, p.eta_IP);

  // LP turbine
  const h5 = expand(h4, s4, P5, p.eta_LP);
  const s5 = Q('S', 'P', P5, 'H', h5);
  const T5 = T6C; // condenser saturation temp

  const P_E = p.P_E * BAR;
  const h_e1 = expand(h4, s4, P_E, p.eta_LP);
  const P_F = p.P_F * BAR;
  const h_f1 = expand(h4, s4, P_F, p.eta_LP);
  const P_G = p.P_G * BAR;
  const h_g1 = expand(h4, s4, P_G, p.eta_LP);

  // FWH shell pressures
  const P_VA = p.P_VA * BAR;
  const P_FWH1 = P_G, P_FWH2 = P_F, P_FWH3 = P_E;
  const P_FWH4 = P_C, P_FWH5 = P_B, P_FWH6 = P_VA;
  const P_DA = P_D;
  const Pfw = p.P_feedpump * BAR;
  const Pcond = p.P_condpump * BAR;

  // TTD-determined FWH outlet enthalpies (flow-independent property lookups)
  const h8p  = fwhH(P_FWH1, Pcond, TTD);
  const h9p  = fwhH(P_FWH2, Pcond, TTD);
  const h11  = fwhH(P_FWH3, Pcond, TTD);
  const h13p = fwhH(P_FWH4, Pfw,   TTD);
  const h14p = fwhH(P_FWH5, Pfw,   TTD);
  const h16  = fwhH(P_FWH6, Pfw,   TTD);

  // Drain enthalpies
  const h_g2 = drainH(P_FWH1, sub);
  const h_f2 = drainH(P_FWH2, sub);
  const h_e2 = drainH(P_FWH3, sub);
  const h_c2 = drainH(P_FWH4, sub);
  const h_b2 = drainH(P_FWH5, sub);
  const h_a4 = drainH(P_FWH6, sub);
  const h_c3 = h_c2, h_g3 = h_g2, h_e3 = h_e2;

  // Mass flow rate
  const Qdot = p.Q * 1e6;
  const m = Qdot / (h1 - h16);

  // Pump A: FWH6 drain → feedwater pump pressure
  const s_a4 = Q('S', 'P', P_FWH6, 'H', h_a4);
  const h_a5 = compress(h_a4, s_a4, Pfw, eta_p);

  // Pump B: FWH5 drain → feedwater pump pressure
  const s_b2 = Q('S', 'P', P_FWH5, 'H', h_b2);
  const h_b3 = compress(h_b2, s_b2, Pfw, eta_p);

  // Deaerator outlet + feedwater pump
  const h12 = satH(P_DA);
  const s12 = Q('S', 'P', P_DA, 'Q', 0);
  const h13 = compress(h12, s12, Pfw, eta_p);

  // Pump F: FWH2 drain → condensate pump pressure
  const s_f2 = Q('S', 'P', P_FWH2, 'H', h_f2);
  const h_f3 = compress(h_f2, s_f2, Pcond, eta_p);

  // ── Solve extraction fractions (direct algebraic, no iteration) ──────────

  // a: Reheater + FWH6 + M5 mixer (2 eq / 2 unknown → closed-form linear in a)
  // Derived by combining eq_fwh6 and eq_rh and substituting h15 and a·h_a2
  const a = m * (h3 - h2 + h16 - h14p) / (h1 + h3 - h2 - h14p - h_a4 + h_a5);
  const h_a2 = h1 - (m - a) * (h3 - h2) / a;
  const h15 = ((m - a) * h14p + a * h_a5) / m;

  // b: FWH5 + M4 mixer
  const b = (m - a) * (h14p - h13p) / (h_b1 - h_b2 + h_b3 - h13p);
  const h14 = h14p - b * (h_b1 - h_b2) / (m - a);

  // c: FWH4 (purely linear)
  const c = (m - a - b) * (h13p - h13) / (h_c1 - h_c2);

  // d: Deaerator mixer (linear)
  const flow_abc = m - a - b - c;
  const d = ((m - a - b) * h12 - flow_abc * h11 - c * h_c3) / (h_d1 - h11);

  // e: FWH3 + M2 mixer (h_e3 = h_e2, so denominator simplifies to h_e1 - h9p)
  const flow_fwh3 = m - a - b - c - d;
  const e = flow_fwh3 * (h11 - h9p) / (h_e1 - h9p);
  const h10 = h11 - e * (h_e1 - h_e2) / flow_fwh3;

  // f: FWH2 + M1 mixer (ported faithfully from validated Python reference)
  const flow_fwh2 = m - a - b - c - d - e;
  const f = flow_fwh2 * (h9p - h8p) / (h_f1 - h_f2 + h_f3);
  const h9 = h8p + f * h_f3 / flow_fwh2;

  // g + h7: FWH1 + Hotwell mixer — one genuine nonlinearity because h8 depends on
  // h7 via entropy; resolve with Newton-Raphson (converges in ~4 iterations)
  const flow_fwh1 = m - a - b - c - d - e - f;
  const dstep = flow_fwh1 * 0.001;

  function R_g(gv) {
    const h7_ = h6 + gv * (h_g3 - h6) / flow_fwh1;
    const s7_ = Q('S', 'P', P6, 'H', h7_);
    const h8_ = compress(h7_, s7_, Pcond, eta_p);
    return flow_fwh1 * (h8p - h8_) - gv * (h_g1 - h_g2);
  }

  let g = 0.07 * flow_fwh1;
  for (let i = 0; i < 20; i++) {
    const r0 = R_g(g);
    const dr = (R_g(g + dstep) - r0) / dstep;
    if (Math.abs(dr) < 1e-10) break;
    const step = -r0 / dr;
    g = Math.max(1e-6, Math.min(0.9999 * flow_fwh1, g + step));
    if (Math.abs(step) < 1e-4) break;
  }
  const h7 = h6 + g * (h_g3 - h6) / flow_fwh1;
  const s7 = Q('S', 'P', P6, 'H', h7);
  const h8 = compress(h7, s7, Pcond, eta_p);

  // ── Derived power outputs ─────────────────────────────────────────────────

  const flow_cond = m - a - b - c - d - e - f - g;

  const W_HP  = (m - a) * h1 - (m - a - b) * h2 - b * h_b1;
  const W_IP  = (m - a - b) * h3 - (m - a - b - c - d) * h4 - c * h_c1 - d * h_d1;
  const W_LP  = (m - a - b - c - d) * h4 - flow_cond * h5 - e * h_e1 - f * h_f1 - g * h_g1;
  const W_turb = W_HP + W_IP + W_LP;

  const W_condpump = flow_fwh1 * (h8 - h7);
  const W_pA = a * (h_a5 - h_a4);
  const W_pB = b * (h_b3 - h_b2);
  const W_pF = f * (h_f3 - h_f2);
  const W_fwp = (m - a - b) * (h13 - h12);
  const W_pumps = W_condpump + W_pA + W_pB + W_pF + W_fwp;

  const W_net = (W_turb - W_pumps) * p.eta_gen;
  const eta_1 = W_net / Qdot;

  // 2nd law (exergetic) efficiency: W_net / exergy added in boiler
  // Ex_boiler = m·[(h1−h16) − T0·(s1−s16)]  (flow exergy increase in steam generator)
  const T0K = p.T0 + C2K;
  const s16_si = Q('S', 'P', Pfw, 'H', h16); // J/kg/K, computed directly
  const eta_2 = W_net / (m * ((h1 - h16) - T0K * (s1 - s16_si)));

  // ── T-s diagram paths ─────────────────────────────────────────────────────

  // Boiler path: supercritical heating at P1 from h16 temp up to T1
  const T16K = Q('T', 'P', Pfw, 'H', h16);
  const boilerPath = [];
  for (let i = 0; i <= 16; i++) {
    const Tp = T16K + (T1 - T16K) * i / 16;
    boilerPath.push([Q('S', 'P', P1, 'T', Tp) / 1000, Tp - C2K]);
  }

  // Reheater path at P3 from T2 to T3
  const reheatPath = [];
  for (let i = 0; i <= 10; i++) {
    const Tp = T2 + (T3 - T2) * i / 10;
    reheatPath.push([Q('S', 'P', P3, 'T', Tp) / 1000, Tp - C2K]);
  }

  // Feedwater path: connect key states with computed entropy
  const s9   = Q('S', 'P', Pcond, 'H', h9)  / 1000;
  const T9   = Q('T', 'P', Pcond, 'H', h9)  - C2K;
  const s11v = Q('S', 'P', Pcond, 'H', h11) / 1000;
  const T11v = Q('T', 'P', Pcond, 'H', h11) - C2K;
  const s12v = s12 / 1000;
  const T12v = satT(P_DA) - C2K;
  const s13v = Q('S', 'P', Pfw,   'H', h13) / 1000;
  const T13v = Q('T', 'P', Pfw,   'H', h13) - C2K;
  const s16v = Q('S', 'P', Pfw,   'H', h16) / 1000;
  const T16v = T16K - C2K;

  const fwPath = [
    [s6 / 1000, T6C],
    [s9,   T9],
    [s11v, T11v],
    [s12v, T12v],
    [s13v, T13v],
    [s16v, T16v],
  ];

  // State point coordinates for labels [s kJ/kg/K, T °C]
  const statePoints = {
    1:  [s1 / 1000, p.T1],
    2:  [s2 / 1000, T2 - C2K],
    3:  [s3 / 1000, p.T3],
    4:  [s4 / 1000, T4 - C2K],
    5:  [s5 / 1000, T5],
    6:  [s6 / 1000, T6C],
    12: [s12v, T12v],
    16: [s16v, T16v],
  };

  return {
    // Extraction fractions (kg/s)
    m, a, b, c, d, e, f, g,
    // Key state enthalpies (J/kg)
    h1, h2, h3, h4, h5, h6, h7, h8,
    h9, h10, h11, h12, h13, h14, h15, h16,
    // Derived outputs
    W_net, W_turb, W_pumps, eta_1, eta_2,
    T6C, T_wb, P6,
    // T-s diagram data
    statePoints, boilerPath, reheatPath, fwPath,
    // Turbine entropies (kJ/kg/K)
    s1: s1 / 1000, s2: s2 / 1000, s3: s3 / 1000,
    s4: s4 / 1000, s5: s5 / 1000, s6: s6 / 1000,
  };
}
