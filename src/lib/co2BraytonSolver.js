import CoolPropModule from './coolprop/coolprop.js';

const F = 'CarbonDioxide';
const C2K = 273.15;
const BAR = 1e5;

// CO2 critical point (Span & Wagner reference EOS, matches CoolProp).
export const TCRIT_C = 30.9782;
export const PCRIT_PA = 7.3773e6;

let CP = null;
let _dome = null;

// Per-solve memoization of CoolProp lookups, same scheme as rankineSolver.js.
let _qCache = new Map();
function _qkey(out, n1, v1, n2, v2) { return out + '|' + n1 + v1 + '|' + n2 + v2; }

export async function init() {
  if (CP) return;
  CP = await CoolPropModule();
  _dome = _buildDome();
}

export function getDome() { return _dome; }

function Q(out, n1, v1, n2, v2) {
  const k = _qkey(out, n1, v1, n2, v2);
  const hit = _qCache.get(k);
  if (hit !== undefined) return hit;
  const val = CP.PropsSI(out, n1, v1, n2, v2, F);
  _qCache.set(k, val);
  return val;
}

// Water cp for the circulating-water loop (precooler cold side).
function QW(out, n1, v1, n2, v2) {
  const k = 'W' + _qkey(out, n1, v1, n2, v2);
  const hit = _qCache.get(k);
  if (hit !== undefined) return hit;
  const val = CP.PropsSI(out, n1, v1, n2, v2, 'Water');
  _qCache.set(k, val);
  return val;
}

// Stull (2011) wet-bulb approximation. See NOTES.md (rankineSolver.js section).
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

// Isobaric T-s path, h_in to h_out at constant P.
function iso(P, h_in, h_out, N) {
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const h = h_in + (h_out - h_in) * i / N;
    try { pts.push([Q('S', 'P', P, 'H', h) / 1000, Q('T', 'P', P, 'H', h) - C2K]); } catch (_) {}
  }
  return pts;
}

// Compression T-s path (linear h, geometric P).
function seg(h_in, P_in, h_out, P_out, N) {
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    const h = h_in + f * (h_out - h_in);
    const P = P_in * Math.pow(P_out / P_in, f);
    try { pts.push([Q('S', 'P', P, 'H', h) / 1000, Q('T', 'P', P, 'H', h) - C2K]); } catch (_) {}
  }
  return pts;
}

// Turbine expansion T-s path, parameterized by entropy (see NOTES.md).
function turbSeg(s_in, P_in, s_out, P_out, N) {
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    const s = s_in + f * (s_out - s_in);
    const P = P_in * Math.pow(P_out / P_in, f);
    try { pts.push([s / 1000, Q('T', 'P', P, 'S', s) - C2K]); } catch (_) {}
  }
  return pts;
}

function _buildDome() {
  const Tmin = 217.0;   // just above CO2 triple point (216.59 K)
  const Tmax = 304.12;  // just below critical (304.1282 K), closes the dome tip
  const N = 80;
  const liq = [], vap = [];
  for (let i = 0; i <= N; i++) {
    const T = Tmin + (Tmax - Tmin) * i / N;
    try {
      liq.push([Q('S', 'T', T, 'Q', 0) / 1000, T - C2K]);
      vap.push([Q('S', 'T', T, 'Q', 1) / 1000, T - C2K]);
    } catch (_) {}
  }
  const dome = [...liq, ...[...vap].reverse()];
  return { liq, vap, dome };
}

// Recompression sCO2 Brayton cycle with reheat; state numbering follows co2-brayton.csv (NOT the study's). Regenerators use enthalpy-based effectiveness (standard for sCO2, since cp varies too strongly near the critical point for a cp-based ε-NTU form): Q = ε · min(hot-side ideal duty, cold-side ideal duty).
export function solveCycle(p) {
  _qCache.clear();
  const warnings = [];

  const P_hi = p.P_high, P_md = p.P_mid, P_lo = p.P_low;
  const x = p.x_aux;           // recompression (aux compressor) mass fraction
  const mfrac = 1 - x;         // main-branch fraction

  // Cooling tower -> circulating water -> precooler CO2 outlet temperature.
  const T_wb = wetbulb(p.T0, p.RH);
  const T_cw_in = T_wb + p.cw_approach;
  const T_M2 = T_cw_in + p.pc_approach;
  const T_M2K = T_M2 + C2K;

  // Main compressor: M2 -> M3
  const h_M2 = Q('H', 'P', P_lo, 'T', T_M2K);
  const s_M2 = Q('S', 'P', P_lo, 'T', T_M2K);
  const rho_M2 = Q('D', 'P', P_lo, 'T', T_M2K);
  const h_M3 = compress(h_M2, s_M2, P_hi, p.eta_comp);
  const T_M3K = Q('T', 'P', P_hi, 'H', h_M3);

  // Turbines (both SHX passes fix the inlet temperatures)
  const T1K = p.T1 + C2K;
  const h1 = Q('H', 'P', P_hi, 'T', T1K);
  const s1 = Q('S', 'P', P_hi, 'T', T1K);
  const h2 = expand(h1, s1, P_md, p.eta_HP);
  const T2K = Q('T', 'P', P_md, 'H', h2);
  const s2 = Q('S', 'P', P_md, 'H', h2);

  const T3K = p.T3 + C2K;
  const h3 = Q('H', 'P', P_md, 'T', T3K);
  const s3 = Q('S', 'P', P_md, 'T', T3K);
  const h4 = expand(h3, s3, P_lo, p.eta_LP);
  const T4K = Q('T', 'P', P_lo, 'H', h4);
  const s4 = Q('S', 'P', P_lo, 'H', h4);

  // HTR/LTR coupled through mix point 7 (LTR needs HTR's state 5, HTR needs LTR's state 7); scalar fixed point on h5, per-unit-total-flow basis.
  let h5 = h4 - p.eps_HTR * (h4 - Q('H', 'P', P_lo, 'T', T_M3K));
  let h6 = 0, h_M4 = 0, h_A2 = 0, h7 = 0, Q_LTR = 0, Q_HTR = 0;
  const MAXIT = 60, TOL = 0.5; // J/kg
  for (let it = 0; it < MAXIT; it++) {
    const T5K = Q('T', 'P', P_lo, 'H', h5);
    const QmaxL = Math.min(
      h5 - Q('H', 'P', P_lo, 'T', T_M3K),                 // hot side to T_M3
      mfrac * (Q('H', 'P', P_hi, 'T', T5K) - h_M3),       // cold side to T5
    );
    Q_LTR = p.eps_LTR * Math.max(0, QmaxL);
    h6 = h5 - Q_LTR;
    h_M4 = h_M3 + Q_LTR / Math.max(mfrac, 1e-9);

    const s6i = Q('S', 'P', P_lo, 'H', h6);
    h_A2 = compress(h6, s6i, P_hi, p.eta_comp);
    h7 = mfrac * h_M4 + x * h_A2;

    const T7K = Q('T', 'P', P_hi, 'H', h7);
    const QmaxH = Math.min(
      h4 - Q('H', 'P', P_lo, 'T', T7K),                   // hot side to T7
      Q('H', 'P', P_hi, 'T', T4K) - h7,                   // cold side to T4
    );
    Q_HTR = p.eps_HTR * Math.max(0, QmaxH);
    const h5new = h4 - Q_HTR;
    if (Math.abs(h5new - h5) < TOL) { h5 = h5new; break; }
    h5 = h5new;
  }
  const h8 = h7 + Q_HTR;

  // Remaining state coordinates
  const T5K = Q('T', 'P', P_lo, 'H', h5);
  const T6K = Q('T', 'P', P_lo, 'H', h6);
  const s6 = Q('S', 'P', P_lo, 'H', h6);
  const T7K = Q('T', 'P', P_hi, 'H', h7);
  const s7 = Q('S', 'P', P_hi, 'H', h7);
  const T8K = Q('T', 'P', P_hi, 'H', h8);
  const s8 = Q('S', 'P', P_hi, 'H', h8);
  const T_M4K = Q('T', 'P', P_hi, 'H', h_M4);
  const T_A2K = Q('T', 'P', P_hi, 'H', h_A2);

  // Heat input per unit total flow: SHX pass 1 (8->1) + reheat pass (2->3)
  const q1 = h1 - h8;
  const qrh = h3 - h2;
  const q_in = q1 + qrh;
  if (q1 <= 0) {
    warnings.push('SHX pass 1 duty went non-positive: the HTR is returning CO2 hotter than the turbine inlet. Raise T1 or lower the HTR effectiveness.');
  }

  const Qdot = p.Q * 1e6;
  const mtot = Qdot / q_in;        // total loop flow (m+a)
  const m = mtot * mfrac;          // main-branch flow
  const aF = mtot * x;             // aux-branch flow

  // Power
  const W_HP = mtot * (h1 - h2);
  const W_LP = mtot * (h3 - h4);
  const W_turb = W_HP + W_LP;
  const W_C1 = m * (h_M3 - h_M2);
  const W_C2 = aF * (h_A2 - h6);
  const W_comp = W_C1 + W_C2;

  // Precooler heat rejection -> CW flow (from chosen CW temp rise) -> circulating pump work (2 bar head, same assumption as Rankine model's cooling loop).
  const Q_pc = m * (h6 - h_M2);
  const cp_cw = QW('CPMASS', 'P', 1.5 * BAR, 'T', (T_cw_in + p.cw_range / 2) + C2K);
  const mdot_cw = Q_pc / (cp_cw * p.cw_range);
  const T_cw_out = T_cw_in + p.cw_range;
  // Incompressible ṁ·ΔP/(ρ·η) form rather than H(P,S), which fails (Inf) for water near 0°C, reachable with cold-ambient slider settings.
  const P_cw_lo = 1.5 * BAR, dP_cw = 2 * BAR;
  const rho_cw = QW('D', 'P', P_cw_lo, 'T', T_cw_in + C2K);
  const W_cwpump = mdot_cw * dP_cw / (rho_cw * p.eta_comp);

  const W_net = (W_turb - W_comp) * p.eta_gen - W_cwpump;
  const eta_1 = W_net / Qdot;

  // 2nd law (exergetic) efficiency. Ex_gas is the flow-exergy the CO2 itself
  // gains across both SHX passes - a legitimate quantity, but scoped only to
  // the gas side, so it can't see how irreversibly that heat was actually
  // transferred in. Ex_source instead prices the same duty against the
  // intermediate loop's own temperature glide (the solar-salt loop from the
  // plant diagram, same 565/505 C supply/return as the Rankine cycle - the
  // salt splits into two parallel passes here (main + reheat), but both still
  // run the full 565->505 C, so pricing the combined duty against one T_lm is
  // exact, not an approximation - see NOTES.md). See rankineSolver.js for the
  // full derivation - Ex_source = Qdot*(1 - T0/T_lm), independent of every
  // gas-side slider, so eta_2 can't be gamed by changing how the CO2 arrives
  // at the SHX the way a gas-side-only reference could be.
  const T0K = p.T0 + C2K;
  const T_SOURCE_IN = 565 + C2K;
  const T_SOURCE_OUT = 505 + C2K;
  const T_lm_source = (T_SOURCE_IN - T_SOURCE_OUT) / Math.log(T_SOURCE_IN / T_SOURCE_OUT);
  const Ex_source = Qdot * (1 - T0K / T_lm_source);

  const Ex_gas = mtot * ((h1 - h8) - T0K * (s1 - s8) + (h3 - h2) - T0K * (s3 - s2));
  const eta_2 = W_net / Ex_source;
  const Irr_shx = Ex_source - Ex_gas;  // exergy destroyed transferring heat into the CO2 itself
  const Irr_cycle = Ex_gas - W_net;    // exergy destroyed downstream (turbines, compressors, regenerators, precooler)
  const Irr = Ex_source - W_net;       // total exergy destroyed, consistent with eta_2 (Irr_shx + Irr_cycle)

  const bwr = W_comp / W_turb;                       // back-work ratio
  const regen_share = (Q_HTR + Q_LTR) / (Q_HTR + Q_LTR + q_in);

  // T-s diagram paths
  const shx1Path    = iso(P_hi, h8, h1, 30);
  const hpPath      = turbSeg(s1, P_hi, s2, P_md, 12);
  const reheatPath  = iso(P_md, h2, h3, 10);
  const lpPath      = turbSeg(s3, P_md, s4, P_lo, 12);
  const htrHotPath  = iso(P_lo, h4, h5, 14);
  const ltrHotPath  = iso(P_lo, h5, h6, 12);
  const precoolPath = iso(P_lo, h6, h_M2, 16);
  const mainCompPath = seg(h_M2, P_lo, h_M3, P_hi, 8);
  const ltrColdPath  = iso(P_hi, h_M3, h_M4, 12);
  const auxCompPath  = seg(h6, P_lo, h_A2, P_hi, 8);
  const htrColdPath  = iso(P_hi, h7, h8, 16);

  // Mixing chamber bridges (M4 -> 7 and A2 -> 7), drawn dashed.
  const s_M4 = Q('S', 'P', P_hi, 'H', h_M4) / 1000;
  const s_A2 = Q('S', 'P', P_hi, 'H', h_A2) / 1000;
  const mixPaths = [
    [[s_M4, T_M4K - C2K], [s7 / 1000, T7K - C2K]],
    [[s_A2, T_A2K - C2K], [s7 / 1000, T7K - C2K]],
  ];

  const MPa = (pa) => `${(pa / 1e6).toFixed(1)} MPa`;
  const sv = (S) => S / 1000;
  const s_M2v = s_M2 / 1000, s_M3v = Q('S', 'P', P_hi, 'H', h_M3) / 1000;
  const s5 = Q('S', 'P', P_lo, 'H', h5);

  // Main-loop state points (combined m+a stream), always shown.
  const statePoints = {
    1: [sv(s1), p.T1,      `State 1: Secondary HTX outlet / HP turbine inlet, ${p.T1}°C, ${MPa(P_hi)}`],
    2: [sv(s2), T2K - C2K, `State 2: HP turbine exhaust, back to secondary HTX for reheat, ${MPa(P_md)}`],
    3: [sv(s3), p.T3,      `State 3: Reheat outlet / LP turbine inlet, ${p.T3}°C, ${MPa(P_md)}`],
    4: [sv(s4), T4K - C2K, `State 4: LP turbine exhaust / high-T regenerator hot inlet, ${MPa(P_lo)}`],
    5: [sv(s5), T5K - C2K, `State 5: High-T regenerator hot outlet / low-T regenerator hot inlet`],
    6: [sv(s6), T6K - C2K, `State 6: Low-T regenerator hot outlet / stream split (M1 + A1)`],
    7: [sv(s7), T7K - C2K, `State 7: Mixing chamber outlet / high-T regenerator cold inlet, ${MPa(P_hi)}`],
    8: [sv(s8), T8K - C2K, `State 8: High-T regenerator cold outlet / secondary HTX inlet, ${MPa(P_hi)}`],
  };

  // Branch state points (main branch m, aux branch a), toggleable.
  const branchStatePoints = {
    M2: [s_M2v, T_M2,       `M2: Precooler outlet / main compressor inlet, ${T_M2.toFixed(1)}°C, ${MPa(P_lo)}`],
    M3: [s_M3v, T_M3K - C2K, `M3: Main compressor discharge / low-T regenerator cold inlet, ${MPa(P_hi)}`],
    M4: [s_M4, T_M4K - C2K, `M4: Low-T regenerator cold outlet, into the mixing chamber`],
    A2: [s_A2, T_A2K - C2K, `A2: Aux compressor discharge, into the mixing chamber, ${MPa(P_hi)}`],
  };

  // Full state table (matches co2-brayton.csv rows; M1 = A1 = state 6).
  const K = (TK) => TK - C2K;
  const stateTable = [
    ['1',  p.T1,       P_hi, h1,   s1,   'm+a'],
    ['2',  K(T2K),     P_md, h2,   s2,   'm+a'],
    ['3',  p.T3,       P_md, h3,   s3,   'm+a'],
    ['4',  K(T4K),     P_lo, h4,   s4,   'm+a'],
    ['5',  K(T5K),     P_lo, h5,   s5,   'm+a'],
    ['6',  K(T6K),     P_lo, h6,   s6,   'm+a'],
    ['M1', K(T6K),     P_lo, h6,   s6,   'm'],
    ['M2', T_M2,       P_lo, h_M2, s_M2, 'm'],
    ['M3', K(T_M3K),   P_hi, h_M3, s_M3v * 1000, 'm'],
    ['M4', K(T_M4K),   P_hi, h_M4, s_M4 * 1000,  'm'],
    ['A1', K(T6K),     P_lo, h6,   s6,   'a'],
    ['A2', K(T_A2K),   P_hi, h_A2, s_A2 * 1000,  'a'],
    ['7',  K(T7K),     P_hi, h7,   s7,   'm+a'],
    ['8',  K(T8K),     P_hi, h8,   s8,   'm+a'],
  ].map(([n, T, P, h, s, f]) => ({
    name: n, T, P: P / 1e6, h: h / 1000, s: s / 1000, flow: f,
  }));

  return {
    warnings,
    mtot, m, aF,
    W_net, W_turb, W_HP, W_LP, W_comp, W_C1, W_C2, W_cwpump,
    eta_1, eta_2, bwr, regen_share,
    Q_pc, Q_HTR: mtot * Q_HTR, Q_LTR: mtot * Q_LTR,
    Ex_source, Ex_gas, Irr, Irr_shx, Irr_cycle,
    q1: mtot * q1, qrh: mtot * qrh,
    T_wb, T_cw_in, T_cw_out, mdot_cw, T_M2, rho_M2,
    statePoints, branchStatePoints, stateTable,
    shx1Path, hpPath, reheatPath, lpPath,
    htrHotPath, ltrHotPath, precoolPath,
    mainCompPath, ltrColdPath, auxCompPath, htrColdPath, mixPaths,
  };
}
