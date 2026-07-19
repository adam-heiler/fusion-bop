import CoolPropModule from './coolprop/coolprop.js';

const F = 'Helium';
const C2K = 273.15;
const BAR = 1e5;

let CP = null;

// Per-solve memoization of CoolProp lookups, same scheme as rankineSolver.js
// / co2BraytonSolver.js.
let _qCache = new Map();
function _qkey(out, n1, v1, n2, v2) { return out + '|' + n1 + v1 + '|' + n2 + v2; }

export async function init() {
  if (CP) return;
  CP = await CoolPropModule();
}

// No saturation dome: helium's critical point (~-268°C, 0.23 MPa) sits far
// outside this cycle's entire T/P range, so the working fluid is single-phase
// (ideal-gas-like) everywhere on the diagram - there's nothing to draw.

function Q(out, n1, v1, n2, v2) {
  const k = _qkey(out, n1, v1, n2, v2);
  const hit = _qCache.get(k);
  if (hit !== undefined) return hit;
  const val = CP.PropsSI(out, n1, v1, n2, v2, F);
  _qCache.set(k, val);
  return val;
}

// Water cp/density for the circulating-water loop (precooler + intercooler
// cold side, one combined loop per the site's he-brayton.csv note).
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

// Single-shaft recuperated Brayton cycle with two-stage intercooled
// compression. State numbering follows the site's he-brayton.csv exactly:
// 1 SHX->turbine, 2 turbine->regenerator (hot in), 3 regenerator (hot out)
// ->precooler, 4 precooler->main compressor (C1), 5 C1->intercooler,
// 6 intercooler->aux compressor (C2), 7 C2->regenerator (cold in),
// 8 regenerator (cold out)->SHX. Unlike the CO2 cycle there's no
// recompression split - a single mass flow runs the whole loop, so the
// regenerator's hot and cold inlet states are both already fully determined
// before its energy balance runs: no fixed-point iteration needed.
//
// Validated against the ARC study (sustainability-16-07480, Tables 13/14):
// at the paper's own exact per-state pressures, individual states match
// Table 14 almost to the kJ/kg (e.g. h5 = 1991.9 exact at P4 = 22.5 bar,
// eta_comp = 0.9), confirming the underlying CoolProp Helium properties
// agree with the paper's NASA thermodynamic data.
//
// Unlike co2BraytonSolver.js (which holds three constant pressure levels for
// its whole loop, no HX drops modeled at all), this solver models exactly
// one HX pressure drop: regen_dP_pct, applied as a % of each side's own
// local pressure across the regenerator only (SHX and precooler/intercooler
// stay drop-free). That one component turned out to matter far more here
// than any HX drop does for CO2: helium's compressors run a low enough
// pressure ratio that isentropic compression work is unusually sensitive to
// a couple of percent of inlet pressure (dh ~ T*ds, and ds from a 2%
// pressure shift is not negligible at these temperatures), and the paper's
// own regenerator drop feeds directly into the main compressor's inlet
// pressure via the precooler. With regen_dP_pct at its default 3.5%, this
// solver reproduces essentially every headline number simultaneously:
// 207.0 MW net (paper 207.5), 32.1% net efficiency (paper 32%), 88.4% gross
// efficiency (paper 88%), 63.3% back-work ratio (paper 63.5%) - a much
// tighter match than the flat-pressure version this replaced (which ran
// ~240 MW / 37% net at equivalent slider settings). eps_regen = 0.90 is
// chosen separately, to match the paper's actual hot/cold regenerator
// duties directly (states 2/3/7/8).
export function solveCycle(p) {
  _qCache.clear();
  const warnings = [];

  const P_hi = p.P_high, P_mid = p.P_mid, P_lo = p.P_low;

  // Regenerator pressure drop: the one HX drop this solver models (see
  // heBraytonSolver.js's file-header note on why the others are left flat).
  // Applied as a % of each side's own local pressure - one slider covers
  // both sides, since the ARC study's own state table shows a similarly-
  // sized drop on each (state 2->3 and state 7->8). P_hi/P_lo stay anchored
  // to the compressor discharge / turbine exhaust (the actual GateCycle
  // input values, Table 13); the SHX and precooler are still modeled as
  // drop-free, so state 1 sits at the same (reduced) pressure as state 8,
  // and state 4 at the same (reduced) pressure as state 3.
  const dP = p.regen_dP_pct;
  const P_hi_out = P_hi * (1 - dP);  // states 1 & 8
  const P_lo_out = P_lo * (1 - dP);  // states 3 & 4

  // Turbine: state 1 -> state 2
  const T1K = p.T1 + C2K;
  const h1 = Q('H', 'P', P_hi_out, 'T', T1K);
  const s1 = Q('S', 'P', P_hi_out, 'T', T1K);
  const h2 = expand(h1, s1, P_lo, p.eta_turb);
  const T2K = Q('T', 'P', P_lo, 'H', h2);
  const s2 = Q('S', 'P', P_lo, 'H', h2);

  // Cooling tower -> circulating water -> precooler/intercooler outlet temps.
  const T_wb = wetbulb(p.T0, p.RH);
  const T_cw_in = T_wb + p.cw_approach;
  const T4 = T_cw_in + p.pc_approach;
  const T4K = T4 + C2K;
  const T6 = T_cw_in + p.itc_approach;
  const T6K = T6 + C2K;

  // Main compressor (C1): state 4 -> state 5
  const h4 = Q('H', 'P', P_lo_out, 'T', T4K);
  const s4 = Q('S', 'P', P_lo_out, 'T', T4K);
  const h5 = compress(h4, s4, P_mid, p.eta_comp);
  const T5K = Q('T', 'P', P_mid, 'H', h5);
  const s5 = Q('S', 'P', P_mid, 'H', h5);

  // Aux compressor (C2): state 6 -> state 7
  const h6 = Q('H', 'P', P_mid, 'T', T6K);
  const s6 = Q('S', 'P', P_mid, 'T', T6K);
  const h7 = compress(h6, s6, P_hi, p.eta_comp);
  const T7K = Q('T', 'P', P_hi, 'H', h7);
  const s7 = Q('S', 'P', P_hi, 'H', h7);

  // Regenerator: hot side 2->3 (P_lo -> P_lo_out), cold side 7->8
  // (P_hi -> P_hi_out). Enthalpy-based effectiveness (see NOTES.md,
  // co2BraytonSolver.js section) - both inlet states are already known, so
  // this is a direct calculation, not an iteration. The "max possible"
  // counterfactual states are evaluated at each stream's own outlet
  // pressure, consistent with where Qregen ultimately lands it.
  const QmaxHot = h2 - Q('H', 'P', P_lo_out, 'T', T7K);
  const QmaxCold = Q('H', 'P', P_hi_out, 'T', T2K) - h7;
  const Qregen = p.eps_regen * Math.max(0, Math.min(QmaxHot, QmaxCold));
  const h3 = h2 - Qregen;
  const h8 = h7 + Qregen;
  const T3K = Q('T', 'P', P_lo_out, 'H', h3);
  const s3 = Q('S', 'P', P_lo_out, 'H', h3);
  const T8K = Q('T', 'P', P_hi_out, 'H', h8);
  const s8 = Q('S', 'P', P_hi_out, 'H', h8);

  if (h1 <= h8) {
    warnings.push('Secondary HTX duty went non-positive: the regenerator is returning helium hotter than the turbine inlet. Lower the regenerator effectiveness or raise T1.');
  }

  const Qdot = p.Q * 1e6;
  const m = Qdot / (h1 - h8);

  const W_turb = m * (h1 - h2);
  const W_C1 = m * (h5 - h4);
  const W_C2 = m * (h7 - h6);
  const W_comp = W_C1 + W_C2;

  const Q_pc = m * (h3 - h4);
  const Q_itc = m * (h5 - h6);

  // Combined circulating-water loop (precooler + intercooler branches
  // recombine before the cooling tower, per he-brayton.csv's note on state 3).
  const cp_cw = QW('CPMASS', 'P', 1.5 * BAR, 'T', (T_cw_in + p.cw_range / 2) + C2K);
  const mdot_cw = (Q_pc + Q_itc) / (cp_cw * p.cw_range);
  const T_cw_out = T_cw_in + p.cw_range;

  // Incompressible ṁ·ΔP/(ρ·η) form - see co2BraytonSolver.js for why this is
  // used instead of an H(P,S) lookup (fails near 0°C water).
  const P_cw_lo = 1.5 * BAR, dP_cw = 2 * BAR;
  const rho_cw = QW('D', 'P', P_cw_lo, 'T', T_cw_in + C2K);
  const W_cwpump = mdot_cw * dP_cw / (rho_cw * p.eta_comp);

  // Gross/net power follow Section 2.4's formula (validated against the
  // ARC study's Table 15/17: reproduces 568.3 MW gross / 207.5 MW net /
  // 88.0% gross eff / 32% net eff at the paper's own inputs to within ~1%).
  const W_gross = W_turb * p.eta_gen;
  const W_net = (W_turb - W_comp) * p.eta_gen - W_cwpump;
  const eta_1 = W_net / Qdot;
  const eta_gross = W_gross / Qdot;

  // 2nd law (exergetic) efficiency: flow-exergy increase across the SHX.
  const T0K = p.T0 + C2K;
  const Ex_in = m * ((h1 - h8) - T0K * (s1 - s8));
  const eta_2 = W_net / Ex_in;

  const bwr = W_comp / W_turb;                           // back-work ratio
  const regen_share = Qregen / (Qregen + (h1 - h8));      // per unit mass

  // T-s diagram paths. The regenerator legs are no longer isobaric once
  // regen_dP_pct > 0 (each side's inlet/outlet pressure now differ), so
  // those two use seg() (geometric P interpolation) instead of iso().
  const shxPath      = iso(P_hi_out, h8, h1, 30);
  const turbPath      = turbSeg(s1, P_hi_out, s2, P_lo, 16);
  const regenHotPath  = seg(h2, P_lo, h3, P_lo_out, 14);
  const precoolPath   = iso(P_lo_out, h3, h4, 12);
  const c1Path        = seg(h4, P_lo_out, h5, P_mid, 10);
  const itcPath        = iso(P_mid, h5, h6, 12);
  const c2Path        = seg(h6, P_mid, h7, P_hi, 10);
  const regenColdPath = seg(h7, P_hi, h8, P_hi_out, 14);

  const MPa = (pa) => `${(pa / 1e6).toFixed(2)} MPa`;
  const sv = (S) => S / 1000;

  // Main-loop state points (single stream), always shown.
  const statePoints = {
    1: [sv(s1), p.T1,        `State 1: Secondary HTX outlet / turbine inlet, ${p.T1}°C, ${MPa(P_hi_out)}`],
    2: [sv(s2), T2K - C2K,   `State 2: Turbine exhaust / regenerator hot inlet, ${MPa(P_lo)}`],
    3: [sv(s3), T3K - C2K,   `State 3: Regenerator hot outlet / precooler inlet, ${MPa(P_lo_out)}`],
    4: [sv(s4), T4,          `State 4: Precooler outlet / main compressor inlet, ${T4.toFixed(1)}°C, ${MPa(P_lo_out)}`],
    5: [sv(s5), T5K - C2K,   `State 5: Main compressor discharge / intercooler inlet, ${MPa(P_mid)}`],
    6: [sv(s6), T6,          `State 6: Intercooler outlet / aux compressor inlet, ${T6.toFixed(1)}°C, ${MPa(P_mid)}`],
    7: [sv(s7), T7K - C2K,   `State 7: Aux compressor discharge / regenerator cold inlet, ${MPa(P_hi)}`],
    8: [sv(s8), T8K - C2K,   `State 8: Regenerator cold outlet / secondary HTX inlet, ${MPa(P_hi_out)}`],
  };

  const K = (TK) => TK - C2K;
  const stateTable = [
    ['1', p.T1,     P_hi_out, h1, s1],
    ['2', K(T2K),   P_lo,     h2, s2],
    ['3', K(T3K),   P_lo_out, h3, s3],
    ['4', T4,       P_lo_out, h4, s4],
    ['5', K(T5K),   P_mid,    h5, s5],
    ['6', T6,       P_mid,    h6, s6],
    ['7', K(T7K),   P_hi,     h7, s7],
    ['8', K(T8K),   P_hi_out, h8, s8],
  ].map(([name, T, P, h, s]) => ({
    name, T, P: P / 1e6, h: h / 1000, s: s / 1000, flow: m,
  }));

  return {
    warnings, m,
    W_net, W_turb, W_comp, W_C1, W_C2, W_gross, W_cwpump,
    eta_1, eta_2, eta_gross, bwr, regen_share,
    Q_pc, Q_itc, Q_regen: m * Qregen, Ex_in,
    T_wb, T_cw_in, T_cw_out, mdot_cw, T4, T6,
    statePoints, stateTable,
    shxPath, turbPath, regenHotPath, precoolPath, c1Path, itcPath, c2Path, regenColdPath,
  };
}
