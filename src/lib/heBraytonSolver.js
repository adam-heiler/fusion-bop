import CoolPropModule from './coolprop/coolprop.js';

const F = 'Helium';
const C2K = 273.15;
const BAR = 1e5;

let CP = null;

// Per-solve memoization of CoolProp lookups, same scheme as rankineSolver.js / co2BraytonSolver.js.
let _qCache = new Map();
function _qkey(out, n1, v1, n2, v2) { return out + '|' + n1 + v1 + '|' + n2 + v2; }

export async function init() {
  if (CP) return;
  CP = await CoolPropModule();
}

// No saturation dome: helium's critical point (~-268°C, 0.23 MPa) is far outside this cycle's range, so nothing to draw.

function Q(out, n1, v1, n2, v2) {
  const k = _qkey(out, n1, v1, n2, v2);
  const hit = _qCache.get(k);
  if (hit !== undefined) return hit;
  const val = CP.PropsSI(out, n1, v1, n2, v2, F);
  _qCache.set(k, val);
  return val;
}

// Water cp/density for the circulating-water loop (precooler + intercooler cold side, one combined loop per he-brayton.csv).
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

// Single-shaft recuperated Brayton, two-stage intercooled compression, states per he-brayton.csv; no recompression split so regenerator inlets are already known (no fixed-point iteration needed); regen_dP_pct is the one HX drop modeled since helium's low compressor pressure ratio makes compression work unusually sensitive to inlet pressure; validated against the ARC study (sustainability-16-07480, Tables 13/14), matching headline net power/efficiency/back-work ratio within ~1%.
export function solveCycle(p) {
  _qCache.clear();
  const warnings = [];

  const P_hi = p.P_high, P_mid = p.P_mid, P_lo = p.P_low;

  // Regenerator pressure drop, the one HX drop modeled (see file header); one slider for both sides since ARC's table shows similar drops on each; P_hi/P_lo stay anchored to compressor discharge/turbine exhaust (GateCycle Table 13), SHX/precooler stay drop-free.
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

  // Regenerator, hot side 2->3, cold side 7->8; enthalpy-based effectiveness (see NOTES.md, co2BraytonSolver.js section), inlets already known so direct calc, not iteration.
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

  // Combined circulating-water loop, precooler + intercooler branches recombine before the cooling tower (he-brayton.csv note on state 3).
  const cp_cw = QW('CPMASS', 'P', 1.5 * BAR, 'T', (T_cw_in + p.cw_range / 2) + C2K);
  const mdot_cw = (Q_pc + Q_itc) / (cp_cw * p.cw_range);
  const T_cw_out = T_cw_in + p.cw_range;

  // Incompressible ṁ·ΔP/(ρ·η) form instead of H(P,S) lookup, which fails near 0°C water (see co2BraytonSolver.js).
  const P_cw_lo = 1.5 * BAR, dP_cw = 2 * BAR;
  const rho_cw = QW('D', 'P', P_cw_lo, 'T', T_cw_in + C2K);
  const W_cwpump = mdot_cw * dP_cw / (rho_cw * p.eta_comp);

  // Gross/net power per Section 2.4's formula; validated against ARC study Table 15/17 within ~1%.
  const W_gross = W_turb * p.eta_gen;
  const W_net = (W_turb - W_comp) * p.eta_gen - W_cwpump;
  const eta_1 = W_net / Qdot;
  const eta_gross = W_gross / Qdot;

  // 2nd law (exergetic) efficiency. Ex_gas is the flow-exergy the helium
  // itself gains across the SHX - a legitimate quantity, but scoped only to
  // the gas side, so it can't see how irreversibly that heat was actually
  // transferred in. Ex_source instead prices the same duty against the
  // intermediate loop's own temperature glide (the solar-salt loop from the
  // plant diagram, same 565/505 C supply/return as the Rankine cycle - single
  // pass here, no reheat, so the full duty runs the whole 565->505 C - see
  // NOTES.md). See rankineSolver.js for the full derivation - Ex_source =
  // Qdot*(1 - T0/T_lm), independent of every gas-side slider, so eta_2 can't
  // be gamed by changing how the helium arrives at the SHX the way a
  // gas-side-only reference could be.
  const T0K = p.T0 + C2K;
  const T_SOURCE_IN = 565 + C2K;
  const T_SOURCE_OUT = 505 + C2K;
  const T_lm_source = (T_SOURCE_IN - T_SOURCE_OUT) / Math.log(T_SOURCE_IN / T_SOURCE_OUT);
  const Ex_source = Qdot * (1 - T0K / T_lm_source);

  const Ex_gas = m * ((h1 - h8) - T0K * (s1 - s8));
  const eta_2 = W_net / Ex_source;
  const Irr_shx = Ex_source - Ex_gas;  // exergy destroyed transferring heat into the helium itself
  const Irr_cycle = Ex_gas - W_net;    // exergy destroyed downstream (turbine, compressors, regenerator, precooler/intercooler)
  const Irr = Ex_source - W_net;       // total exergy destroyed, consistent with eta_2 (Irr_shx + Irr_cycle)

  const bwr = W_comp / W_turb;                           // back-work ratio
  const regen_share = Qregen / (Qregen + (h1 - h8));      // per unit mass

  // T-s diagram paths; regenerator legs use seg() (geometric P interpolation) not iso() since they're no longer isobaric once regen_dP_pct > 0.
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
    Q_pc, Q_itc, Q_regen: m * Qregen,
    Ex_source, Ex_gas, Irr, Irr_shx, Irr_cycle,
    T_wb, T_cw_in, T_cw_out, mdot_cw, T4, T6,
    statePoints, stateTable,
    shxPath, turbPath, regenHotPath, precoolPath, c1Path, itcPath, c2Path, regenColdPath,
  };
}
