import CoolPropModule from './coolprop/coolprop.js';

const W = 'Water';
const C2K = 273.15;
const BAR = 1e5;

// Critical pressure of water, hoisted to a constant (was recomputed every solve via the
// dummy-argument call Q('Pcrit','P',0,'T',0)). Value per IAPWS-95 / NIST: Pc = 22.064 MPa
// (W. Wagner & A. Pruß, J. Phys. Chem. Ref. Data 31, 387 (2002); also NIST Chemistry
// WebBook, water critical point). CoolProp returns this same 22064000 Pa for 'Pcrit'.
const PCRIT_PA = 22.064e6;

let CP = null;
let _dome = null;

// ── Per-solve memoization of CoolProp lookups ────────────────────────────────
// PropsSI is a pure function of (output, name1, val1, name2, val2) for a fixed fluid, so
// caching on that exact 5-tuple is numerically lossless — every hit returns the identical
// IEEE-754 double the underlying call would have. Profiling one solveCycle at default
// sliders showed 508 PropsSI calls of which 75 (14.8%) are exact repeats (profile_solver.py);
// caching removes exactly those, verified bit-identical for all outputs (verify_cache_identical.py).
// The map is cleared at the top of solveCycle so memory stays bounded to a single solve.
let _qCache = new Map();
function _qkey(out, n1, v1, n2, v2) { return out + '|' + n1 + v1 + '|' + n2 + v2; }

export async function init() {
  if (CP) return;
  CP = await CoolPropModule();
  _dome = _buildDome();
}

export function getDome() { return _dome; }

// ── Slider-clamp helpers ────────────────────────────────────────────────────
// These let the UI enforce physically valid pressure combinations WITHOUT duplicating
// CoolProp access logic in the Svelte component. Both solve numerically (cheap — a few
// CoolProp calls each) for the minimum shell pressure that keeps the corresponding
// extraction fraction (c or g) from going negative, since the deaerator and condenser
// outlets are saturated liquid with NO TTD subtracted, unlike every FWH-to-FWH boundary
// (where the SAME TTD on both sides cancels out and pure pressure ordering is enough).

export function minPC(P_D, TTD, eta_pump, Pfw = 250) {
  const PfwPa = Pfw * BAR, P_D_Pa = P_D * BAR;
  const h12 = satH(P_D_Pa);
  const s12 = Q('S', 'P', P_D_Pa, 'Q', 0);
  const h13 = compress(h12, s12, PfwPa, eta_pump);
  let lo = P_D, hi = P_D * 5;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const h13p = fwhH(mid * BAR, PfwPa, TTD);
    if (h13p < h13) lo = mid; else hi = mid;
  }
  return hi;
}

export function minPG(T0, RH, cw_approach, cond_TTD, TTD, eta_pump, Pcond = 5) {
  const T_wb = wetbulb(T0, RH);
  const T6C = T_wb + cw_approach + cond_TTD;
  const P6 = Q('P', 'T', T6C + C2K, 'Q', 0);
  const PcondPa = Pcond * BAR;
  const h6 = satH(P6);
  const s6 = Q('S', 'P', P6, 'Q', 0);
  const h8 = compress(h6, s6, PcondPa, eta_pump);
  let lo = 0.001, hi = 50;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const h8p = fwhH(mid * BAR, PcondPa, TTD);
    if (h8p < h8) lo = mid; else hi = mid;
  }
  return hi;
}

function Q(out, n1, v1, n2, v2) {
  const k = _qkey(out, n1, v1, n2, v2);
  const hit = _qCache.get(k);
  if (hit !== undefined) return hit;
  const val = CP.PropsSI(out, n1, v1, n2, v2, W);
  _qCache.set(k, val);
  return val;
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

// Isobaric path: N+1 CoolProp points from h_in to h_out at constant P
function iso(P, h_in, h_out, N) {
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const h = h_in + (h_out - h_in) * i / N;
    try { pts.push([Q('S', 'P', P, 'H', h) / 1000, Q('T', 'P', P, 'H', h) - C2K]); } catch (_) {}
  }
  return pts;
}

// Compression path: N+1 CoolProp points with linear-h + geometric-P interpolation
// (used for pumps only — entropy is monotonically well-behaved for pump compression)
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

// Turbine expansion path: parameterized by entropy (guarantees monotonically increasing s).
// Using linear-h near the pseudo-critical region causes entropy to decrease mid-segment
// because the 250-bar isobar forms an S-curve — parameterizing by s avoids that artifact.
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
  const Tmin = 273.16;
  const Tmax = 647.09; // 0.006 K below critical; sf and sg converge here, closing the dome tip
  const N = 100;
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

export function solveCycle(p) {
  _qCache.clear();   // bound cache to a single solve (see memo note at top of file)
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
  const x5 = Q('Q', 'P', P5, 'H', h5); // LP exhaust steam quality (-1 if superheated)

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

  // Extraction point T-s coordinates for diagram (all pressures now in scope).
  // Stream A is tapped BEFORE the HP turbine, so state a1 IS state 1 — it is NOT a bleed
  // expanded down to P_VA (source: rankinecycle_v2.xlsx "states" sheet: "a1 same state as
  // 1"; "streams" sheet: "a: extraction before main stream enters hp turbine"). The steam
  // that reaches the FWH6 shell is state a3 (after the reheater + Valve A), handled below.
  const s_A_ex = s1 / 1000;
  const T_A_ex = p.T1;
  const s_B_ex = Q('S', 'P', P_B,  'H', h_b1)  / 1000;
  const T_B_ex = Q('T', 'P', P_B,  'H', h_b1)  - C2K;
  const s_C_ex = Q('S', 'P', P_C,  'H', h_c1)  / 1000;
  const T_C_ex = Q('T', 'P', P_C,  'H', h_c1)  - C2K;
  const s_D_ex = Q('S', 'P', P_D,  'H', h_d1)  / 1000;
  const T_D_ex = Q('T', 'P', P_D,  'H', h_d1)  - C2K;
  const s_E_ex = Q('S', 'P', P_E,  'H', h_e1)  / 1000;
  const T_E_ex = Q('T', 'P', P_E,  'H', h_e1)  - C2K;
  const s_F_ex = Q('S', 'P', P_F,  'H', h_f1)  / 1000;
  const T_F_ex = Q('T', 'P', P_F,  'H', h_f1)  - C2K;
  const s_G_ex = Q('S', 'P', P_G,  'H', h_g1)  / 1000;
  const T_G_ex = Q('T', 'P', P_G,  'H', h_g1)  - C2K;

  // TTD-determined FWH outlet enthalpies (flow-independent property lookups).
  // Variable names match v2 state numbering (rankinecycle_v2.xlsx): old state 7 (hotwell)
  // dropped — merged into new state 6. Old 8->7, 9->8, 10->9, 11->10, 12->11, 13->12,
  // 14->13, 15->14, 16->15. Prime (') suffix denotes intermediate FWH outlet before mixing.
  const h7p  = fwhH(P_FWH1, Pcond, TTD);  // FWH1 feedwater outlet (new state 7')
  const h8p  = fwhH(P_FWH2, Pcond, TTD);  // FWH2 feedwater outlet (new state 8')
  const h10  = fwhH(P_FWH3, Pcond, TTD);  // FWH3 feedwater outlet (new state 10)
  const h12p = fwhH(P_FWH4, Pfw,   TTD);  // FWH4 feedwater outlet (new state 12')
  const h13p = fwhH(P_FWH5, Pfw,   TTD);  // FWH5 feedwater outlet (new state 13')
  const h15  = fwhH(P_FWH6, Pfw,   TTD);  // FWH6 feedwater outlet = boiler inlet (new 15)

  // Drain enthalpies
  const h_g2 = drainH(P_FWH1, sub);
  const h_f2 = drainH(P_FWH2, sub);
  const h_e2 = drainH(P_FWH3, sub);
  const h_c2 = drainH(P_FWH4, sub);
  const h_b2 = drainH(P_FWH5, sub);
  const h_a4 = drainH(P_FWH6, sub);
  const h_c3 = h_c2;   // Valve C isenthalpic (h_e3 would equal h_e2 likewise; E3 states
                       // are computed directly from h_e2 below, so no binding is needed).

  // Mass flow rate (new state 15 = boiler inlet, replaces old state 16)
  const Qdot = p.Q * 1e6;
  const m = Qdot / (h1 - h15);

  // Pump A: FWH6 drain → feedwater pump pressure
  const s_a4 = Q('S', 'P', P_FWH6, 'H', h_a4);
  const h_a5 = compress(h_a4, s_a4, Pfw, eta_p);

  // Pump B: FWH5 drain → feedwater pump pressure
  const s_b2 = Q('S', 'P', P_FWH5, 'H', h_b2);
  const h_b3 = compress(h_b2, s_b2, Pfw, eta_p);

  // Deaerator outlet (new state 11) + feedwater pump outlet (new state 12)
  const h11 = satH(P_DA);
  const s11 = Q('S', 'P', P_DA, 'Q', 0);
  const h12 = compress(h11, s11, Pfw, eta_p);

  // Pump F: FWH2 drain → condensate pump pressure
  const s_f2 = Q('S', 'P', P_FWH2, 'H', h_f2);
  const h_f3 = compress(h_f2, s_f2, Pcond, eta_p);

  // ── Solve extraction fractions (direct algebraic, no iteration) ──────────

  // ── Extraction fractions, v2 state numbering throughout ──────────────────
  // Primed states (7', 8', 12', 13') are intermediate FWH outlets before mixing junctions.

  // a + b: Reheater + FWH6 + M5 mixer + FWH5 + M4 mixer, solved simultaneously.
  //
  // KEY CORRECTION vs. an earlier version: the reheater COLD side carries m-a-b, not m-a.
  // Stream b bleeds off inside the HP turbine (states 1' -> b1) BEFORE the HP exhaust
  // reaches the reheater, so states 2 and 3 both carry mass flow m-a-b
  // (source: rankinecycle_v2.xlsx "states" sheet — states 2 and 3 list mass flow "m-a-b").
  // Charging (m-a) to the reheater cold side silently discarded b*(h3-h2) of energy and
  // over-extracted stream a; the whole-plant First Law then failed to close by exactly
  // that amount (source: audit_reheater_balance.py — 51.49 MW residual = b*(h3-h2)).
  //
  // Stream a is tapped BEFORE the HP turbine at state 1 (source: rankinecycle_v2.xlsx
  // "streams" sheet — "a: extraction before main stream enters hp turbine"; and "states"
  // sheet — "a1 same state as 1"). It is NOT a turbine bleed: it flows a1 -> reheater
  // (hot side) -> Valve A -> FWH6 shell. Reheater hot-side balance:
  //   a*h1 + (m-a-b)*h2 = a*h_a2 + (m-a-b)*h3  ->  h_a2 = h1 - (m-a-b)*(h3-h2)/a.
  //
  // Because b = (m-a)*beta with beta flow-independent, substituting into the coupled
  // Reheater+FWH6+M5 balance keeps a closed-form (no iteration). Derivation and a
  // per-control-volume First Law check (all residuals 0.000000 MW) are in validate_v2.py.
  const beta = (h13p - h12p) / (h_b1 - h_b2 + h_b3 - h12p);
  const R = h3 - h2;
  const a = m * (R + h15 - h13p - beta * R) / (h1 + R - h13p - h_a4 + h_a5 - beta * R);
  const b = (m - a) * beta;
  const h_a2 = h1 - (m - a - b) * R / a;   // state a2: reheater hot-side outlet (at ~P1)
  const h_a3 = h_a2;                        // state a3: Valve A isenthalpic -> FWH6 shell
  const h14 = ((m - a) * h13p + a * h_a5) / m;      // new state 14 (M5 outlet = FWH6 inlet)
  const h13 = h13p - b * (h_b1 - h_b2) / (m - a);   // new state 13 (M4 outlet = FWH5 inlet)

  // c: FWH4 (purely linear). New states 12', 12, 11.
  const c = (m - a - b) * (h12p - h12) / (h_c1 - h_c2);

  // d: Deaerator mixer (linear). New states 10, 11.
  const flow_abc = m - a - b - c;
  const d = ((m - a - b) * h11 - flow_abc * h10 - c * h_c3) / (h_d1 - h10);

  // e: FWH3 + M2 mixer. New states 9, 8', 10.
  // h_e3 = h_e2 (isenthalpic Valve E), so denominator simplifies to h_e1 - h8p.
  const flow_fwh3 = m - a - b - c - d;
  const e = flow_fwh3 * (h10 - h8p) / (h_e1 - h8p);
  const h9 = h10 - e * (h_e1 - h_e2) / flow_fwh3;  // new state 9 (M2 outlet = FWH3 inlet)

  // f: FWH2 + M1 mixer. New states 8, 7', 8'.
  // M1 mixes state 7' (flow = flow_fwh2-f, enthalpy h7p) with Pump F drain f3 (flow=f,
  // enthalpy h_f3) to produce state 8 (flow = flow_fwh2). Correct M1 energy balance:
  //   (flow_fwh2-f)*h7p + f*h_f3 = flow_fwh2*h8new
  // Combined with FWH2 tube-side: flow_fwh2*(h8p-h8new) = f*(h_f1-h_f2).
  // Denominator includes -h7p term (previously missing in an older version of this code).
  const flow_fwh2 = m - a - b - c - d - e;
  const f = flow_fwh2 * (h8p - h7p) / (h_f1 - h_f2 + h_f3 - h7p);
  const h8 = ((flow_fwh2 - f) * h7p + f * h_f3) / flow_fwh2;  // new state 8 (M1 outlet)

  // g + state 6: FWH1 + combined Condenser+Hotwell control volume.
  //
  // New state 6 = combined condenser+hotwell outlet = sat. liquid at P6.
  // Old states 6 and 7 are merged into new state 6 (they were thermodynamically identical:
  // h_old7 = h_old6 = h_sat_liq(P6) by construction of the combined control volume model).
  //
  // The condenser and hotwell are ONE combined control volume because the FWH1 drain (g3)
  // throttles from P_G (~1.5 bar) to condenser vacuum (~3 kPa) through Valve G — a large
  // enough pressure ratio that g3 partially flashes to vapor. A naive two-stream mixer
  // would predict a two-phase mixture entering the condensate pump (cavitation risk).
  // Instead: the hotwell sits inside the condenser shell with a vapor space above the liquid
  // pool; flashed vapor rejoins the bulk steam and is re-condensed. The combined volume
  // outlet is therefore always sat. liquid at P6, regardless of how much g3 flashes.
  // This also makes the FWH1 balance LINEAR in g (new state 6 no longer depends on g).
  const flow_fwh1 = m - a - b - c - d - e - f;
  // h6 and s6 already declared in the cooling tower section above:
  //   h6 = satH(P6) = sat. liquid at condenser pressure (new state 6)
  //   s6 = Q('S','P',P6,'Q',0)
  const h7 = compress(h6, s6, Pcond, eta_p);     // new state 7: condensate pump outlet

  const g = flow_fwh1 * (h7p - h7) / (h_g1 - h_g2);

  // ── Derived power outputs ─────────────────────────────────────────────────

  const flow_cond = m - a - b - c - d - e - f - g;

  const W_HP  = (m - a) * h1 - (m - a - b) * h2 - b * h_b1;
  const W_IP  = (m - a - b) * h3 - (m - a - b - c - d) * h4 - c * h_c1 - d * h_d1;
  const W_LP  = (m - a - b - c - d) * h4 - flow_cond * h5 - e * h_e1 - f * h_f1 - g * h_g1;
  const W_turb = W_HP + W_IP + W_LP;

  const W_condpump = flow_fwh1 * (h7 - h6);       // condensate pump: new states 6→7
  const W_pA = a * (h_a5 - h_a4);
  const W_pB = b * (h_b3 - h_b2);
  const W_pF = f * (h_f3 - h_f2);
  const W_fwp = (m - a - b) * (h12 - h11);        // feedwater pump: new states 11→12
  const W_pumps = W_condpump + W_pA + W_pB + W_pF + W_fwp;

  const W_net = (W_turb - W_pumps) * p.eta_gen;
  const eta_1 = W_net / Qdot;

  // 2nd law (exergetic) efficiency and steam-generator exergy input share ONE denominator.
  // Ex_sg = external exergy delivered to the working fluid by the steam generator (boiler):
  //   Ex_sg = m·[(h1−h15) − T0·(s1−s15)]   (flow-exergy increase across the boiler).
  // The reheater is internally heated by extraction stream a (working-fluid-to-working-fluid),
  // so it adds NO external exergy — stream a was already heated in the boiler as part of m,
  // and its exergy is already inside the term below. An earlier version added a reheat term
  // to Ex_sg only (not to eta_2's denominator): that double-counted internal reheat (~78.7 MW),
  // so the readout and the gauge disagreed and W_net/Ex_sg (~71.5%) fell below the true
  // eta_2 (~81.6%) — source: diagnose.py. Defining Ex_sg once and dividing keeps them equal.
  // (State 15 = boiler inlet, was old state 16 before v2 renumbering.)
  const T0K = p.T0 + C2K;
  const s15_si = Q('S', 'P', Pfw, 'H', h15); // J/kg/K
  const Ex_sg = m * ((h1 - h15) - T0K * (s1 - s15_si));
  const eta_2 = W_net / Ex_sg;

  // T-s diagram paths

  // Boiler path: new state 15 (boiler inlet) to state 1 (boiler outlet).
  // Handles both supercritical (smooth) and subcritical (plateau) cases.
  const T15K = Q('T', 'P', Pfw, 'H', h15);
  const Pcrit = PCRIT_PA;   // hoisted constant (see PCRIT_PA definition + source at top)
  const boilerPath = [];

  if (P1 >= Pcrit) {
    for (let i = 0; i <= 35; i++) {
      const Tp = T15K + (T1 - T15K) * i / 35;
      boilerPath.push([Q('S', 'P', P1, 'T', Tp) / 1000, Tp - C2K]);
    }
  } else {
    const Tsat = Q('T', 'P', P1, 'Q', 0);
    const EPS = 0.01;
    if (T15K < Tsat - EPS) {
      const n1 = 10;
      for (let i = 0; i <= n1; i++) {
        const Tp = T15K + (Tsat - EPS - T15K) * i / n1;
        boilerPath.push([Q('S', 'P', P1, 'T', Tp) / 1000, Tp - C2K]);
      }
    }
    if (T15K < Tsat + EPS && T1 > Tsat - EPS) {
      const n2 = 12;
      const sf = Q('S', 'P', P1, 'Q', 0) / 1000;
      const sg = Q('S', 'P', P1, 'Q', 1) / 1000;
      for (let i = 0; i <= n2; i++) {
        boilerPath.push([sf + (sg - sf) * i / n2, Tsat - C2K]);
      }
    }
    if (T1 > Tsat + EPS) {
      const n3 = 10;
      for (let i = 0; i <= n3; i++) {
        const Tp = (Tsat + EPS) + (T1 - (Tsat + EPS)) * i / n3;
        boilerPath.push([Q('S', 'P', P1, 'T', Tp) / 1000, Tp - C2K]);
      }
    }
  }

  // Reheater path at P3
  const reheatPath = [];
  for (let i = 0; i <= 8; i++) {
    const Tp = T2 + (T3 - T2) * i / 8;
    reheatPath.push([Q('S', 'P', P3, 'T', Tp) / 1000, Tp - C2K]);
  }

  // Turbine expansion paths — entropy-parameterized (turbSeg) to avoid the
  // "curved inward" artifact caused by the 250-bar pseudo-critical S-curve.
  // HP turbine expansion: state 1 -> B bleed (P_B) -> state 2 exhaust (P2).
  // Stream A is tapped BEFORE the HP turbine (a1 = state 1, source: rankinecycle_v2.xlsx
  // streams sheet "a: extraction before main stream enters hp turbine"), so it is NOT a
  // waypoint on this expansion line. Routing the path through the old A point drew a
  // spurious constant-entropy vertical drop, because s_A_ex now equals s1 — the first leg
  // turbSeg(s1 -> s1) held entropy pinned at s1 while pressure fell 250->117 bar
  // (verified in diagnose.py: seven points all at s = 6.1416 kJ/kg·K). B (P_B = 100 bar,
  // between P1 and P2) is a genuine on-turbine bleed and stays.
  const hpPath = [
    ...turbSeg(s1,          P1,  s_B_ex*1000, P_B, 10),
    ...turbSeg(s_B_ex*1000, P_B, s2,          P2,  10).slice(1),
  ];
  const ipPath = [
    ...turbSeg(s3,          P3,  s_C_ex*1000, P_C, 8),
    ...turbSeg(s_C_ex*1000, P_C, s_D_ex*1000, P_D, 5).slice(1),
    ...turbSeg(s_D_ex*1000, P_D, s4,          P4,  8).slice(1),
  ];
  const lpPath = [
    ...turbSeg(s4,          P4,  s_E_ex*1000, P_E, 7),
    ...turbSeg(s_E_ex*1000, P_E, s_F_ex*1000, P_F, 5).slice(1),
    ...turbSeg(s_F_ex*1000, P_F, s_G_ex*1000, P_G, 5).slice(1),
    ...turbSeg(s_G_ex*1000, P_G, s5,          P5,  8).slice(1),
  ];

  // Feedwater train T-s coordinates — v2 numbering.
  // State 6 = combined condenser+hotwell outlet (sat. liquid at P6).
  // State 7 = condensate pump outlet. States 8-15 follow from there.
  const s6v   = s6 / 1000;                              // new state 6
  const T6v   = T6C;
  const T7v   = Q('T', 'P', Pcond, 'H', h7)  - C2K;   // new state 7
  const s7v   = Q('S', 'P', Pcond, 'H', h7)  / 1000;
  const T8v   = Q('T', 'P', Pcond, 'H', h8)  - C2K;   // new state 8
  const s8v   = Q('S', 'P', Pcond, 'H', h8)  / 1000;
  const T9v   = Q('T', 'P', Pcond, 'H', h9)  - C2K;   // new state 9
  const s9v   = Q('S', 'P', Pcond, 'H', h9)  / 1000;
  const T10v  = Q('T', 'P', Pcond, 'H', h10) - C2K;   // new state 10
  const s10v  = Q('S', 'P', Pcond, 'H', h10) / 1000;
  const s11v  = s11 / 1000;                             // new state 11 (deaerator outlet)
  const T11v  = satT(P_DA) - C2K;
  const T12v  = Q('T', 'P', Pfw,   'H', h12) - C2K;   // new state 12
  const s12v  = Q('S', 'P', Pfw,   'H', h12) / 1000;
  const T13v  = Q('T', 'P', Pfw,   'H', h13) - C2K;   // new state 13
  const s13v  = Q('S', 'P', Pfw,   'H', h13) / 1000;
  const T14v  = Q('T', 'P', Pfw,   'H', h14) - C2K;   // new state 14
  const s14v  = Q('S', 'P', Pfw,   'H', h14) / 1000;
  const T15v  = T15K - C2K;                             // new state 15 (boiler inlet)
  const s15v  = Q('S', 'P', Pfw,   'H', h15) / 1000;

  // Condenser: isobar from LP exhaust to sat liquid at P6
  const condenserPath = iso(P6, h5, h6, 8);

  // Feedwater train — isobars for heating legs, seg() for pump compressions.
  // State 10→11 is a mixing jump across pressures (Pcond→P_DA in deaerator); bridge with
  // a single deaerator-outlet point so pathD draws one straight bridging segment rather
  // than producing a phantom iso segment at the wrong pressure.
  const fwPath = [
    ...seg(h6,  P6,   h7,  Pcond, 4),          // condensate pump 6→7
    ...iso(Pcond, h7,  h8,  8).slice(1),         // LP FWH tube heating 7→8
    ...iso(Pcond, h8,  h9,  6).slice(1),         // LP FWH tube heating 8→9
    ...iso(Pcond, h9,  h10, 6).slice(1),         // FWH3 tube heating 9→10
    [s11v, T11v],                                 // deaerator outlet bridge (10→11 mixing jump)
    ...seg(h11, P_DA, h12, Pfw, 5).slice(1),    // feedwater pump 11→12
    ...iso(Pfw, h12, h13, 5).slice(1),           // M4 mixing/heating 12→13
    ...iso(Pfw, h13, h14, 6).slice(1),           // FWH5 tube heating 13→14
    ...iso(Pfw, h14, h15, 6).slice(1),           // FWH6 tube heating 14→15
  ];

  // FWH shell-side paths: desuperheat from extraction point to sat-vapor boundary,
  // then condense horizontally across the dome to sat-liquid
  const shellData = [
    { P: P_VA, hEx: h_a3, sEx: s_A_ex, TEx: T_A_ex, name: 'FWH6 shell' },
    { P: P_B,  hEx: h_b1,  sEx: s_B_ex, TEx: T_B_ex, name: 'FWH5 shell' },
    { P: P_C,  hEx: h_c1,  sEx: s_C_ex, TEx: T_C_ex, name: 'FWH4 shell' },
    { P: P_D,  hEx: h_d1,  sEx: s_D_ex, TEx: T_D_ex, name: 'Deaerator' },
    { P: P_E,  hEx: h_e1,  sEx: s_E_ex, TEx: T_E_ex, name: 'FWH3 shell' },
    { P: P_F,  hEx: h_f1,  sEx: s_F_ex, TEx: T_F_ex, name: 'FWH2 shell' },
    { P: P_G,  hEx: h_g1,  sEx: s_G_ex, TEx: T_G_ex, name: 'FWH1 shell' },
  ];
  const fwhShellPaths = shellData.map(({ P, hEx, sEx, TEx, name }) => {
    const Tsat = satT(P) - C2K;
    const sf   = Q('S', 'P', P, 'Q', 0) / 1000;
    const sg   = Q('S', 'P', P, 'Q', 1) / 1000;
    const h_sg = Q('H', 'P', P, 'Q', 1);
    // If the extraction steam is already two-phase at the shell pressure, there is no
    // superheated region to desuperheat — condensation starts at the entry entropy inside
    // the dome. This is the case for FWH6, whose steam has passed through the reheater and
    // Valve A and enters wet (h_a3 << h_sat_vapor at P_VA — source: validate_v2.py:
    // h_a3 = 1731.8 kJ/kg < h_g(117 bar) = 2691.9 kJ/kg, quality ~0.21). Drawing an
    // iso(hEx -> h_sg) leg here would sweep backwards toward the sat-vapor line.
    if (hEx <= h_sg) {
      const s_in = Q('S', 'P', P, 'H', hEx) / 1000;
      return { name, Tsat, sf, sg: s_in, sEx, TEx, desupPath: [] };
    }
    const desupPath = iso(P, hEx, h_sg, 6);
    return { name, Tsat, sf, sg, sEx, TEx, desupPath };
  });

  // All 15 main cycle state points — always shown on the T-s diagram.
  const statePoints = {
    1:  [s1/1000,  p.T1,    `State 1: Boiler outlet / HP turbine inlet, ${p.T1}°C, ${p.P1} bar`],
    2:  [s2/1000,  T2-C2K,  'State 2: HP turbine exhaust / reheater inlet'],
    3:  [s3/1000,  p.T3,    `State 3: Reheater outlet / IP turbine inlet, ${p.T3}°C`],
    4:  [s4/1000,  T4-C2K,  'State 4: IP turbine exhaust / LP turbine inlet'],
    5:  [s5/1000,  T5,      'State 5: LP turbine exhaust / condenser inlet'],
    6:  [s6v,      T6v,     `State 6: Condenser+hotwell outlet (sat. liquid), ${T6C.toFixed(1)}°C`],
    7:  [s7v,      T7v,     'State 7: Condensate pump outlet'],
    8:  [s8v,      T8v,     'State 8: M1 outlet / FWH2 tube inlet'],
    9:  [s9v,      T9v,     'State 9: M2 outlet / FWH3 tube inlet'],
    10: [s10v,     T10v,    'State 10: FWH3 tube outlet'],
    11: [s11v,     T11v,    `State 11: Deaerator outlet (sat. liquid), ${T11v.toFixed(1)}°C`],
    12: [s12v,     T12v,    'State 12: Feedwater pump outlet'],
    13: [s13v,     T13v,    'State 13: M4 outlet / FWH5 tube inlet'],
    14: [s14v,     T14v,    'State 14: M5 outlet / FWH6 tube inlet'],
    15: [s15v,     T15v,    `State 15: Boiler inlet, ${T15v.toFixed(1)}°C`],
  };

  // Extraction and drain state points — shown via the checkbox panel.
  // X1 = extraction steam entering the FWH shell (on the turbine line).
  // X2 = shell drain (subcooled liquid leaving the shell at shell pressure).
  // X3 = drain after the associated booster pump (where applicable).
  // A-stream: five panel states a1..a5 (source: rankinecycle_v2.xlsx "states" sheet).
  // a1 = state 1 (s_A_ex/T_A_ex above); a2 = reheater outlet (at ~P1, since Valve A is the
  // only pressure-dropping device between a2 and the FWH6 shell); a3 = Valve A outlet
  // (isenthalpic, at P_VA — enters the shell already two-phase); a4 = shell drain; a5 =
  // after pump A.
  const s_A2 = Q('S','P',P1,   'H',h_a2)/1000; const T_A2 = Q('T','P',P1,   'H',h_a2)-C2K;
  const s_A3 = Q('S','P',P_VA, 'H',h_a3)/1000; const T_A3 = Q('T','P',P_VA, 'H',h_a3)-C2K;
  const s_A4 = Q('S','P',P_VA, 'H',h_a4)/1000; const T_A4 = Q('T','P',P_VA, 'H',h_a4)-C2K;
  const s_A5 = Q('S','P',Pfw,  'H',h_a5)/1000; const T_A5 = Q('T','P',Pfw,  'H',h_a5)-C2K;
  const s_B2 = Q('S','P',P_B,  'H',h_b2)/1000; const T_B2 = Q('T','P',P_B,  'H',h_b2)-C2K;
  const s_B3 = Q('S','P',Pfw,  'H',h_b3)/1000; const T_B3 = Q('T','P',Pfw,  'H',h_b3)-C2K;
  const s_C2 = Q('S','P',P_C,  'H',h_c2)/1000; const T_C2 = Q('T','P',P_C,  'H',h_c2)-C2K;
  const s_E2 = Q('S','P',P_E,  'H',h_e2)/1000; const T_E2 = Q('T','P',P_E,  'H',h_e2)-C2K;
  const s_F2 = Q('S','P',P_F,  'H',h_f2)/1000; const T_F2 = Q('T','P',P_F,  'H',h_f2)-C2K;
  const s_F3 = Q('S','P',Pcond,'H',h_f3)/1000; const T_F3 = Q('T','P',Pcond,'H',h_f3)-C2K;
  const s_G2 = Q('S','P',P_G,  'H',h_g2)/1000; const T_G2 = Q('T','P',P_G,  'H',h_g2)-C2K;

  // Valve outlet states (X3 for streams C, E, G): isenthalpic throttle to destination pressure
  const s_C3 = Q('S','P',P_DA,  'H',h_c2)/1000; const T_C3 = Q('T','P',P_DA,  'H',h_c2)-C2K;
  const s_E3 = Q('S','P',Pcond, 'H',h_e2)/1000; const T_E3 = Q('T','P',Pcond, 'H',h_e2)-C2K;
  const s_G3 = Q('S','P',P6,    'H',h_g2)/1000; const T_G3 = Q('T','P',P6,    'H',h_g2)-C2K;

  const extractionStatePoints = {
    A1: [s_A_ex, T_A_ex, `A1: Extraction to reheater (= state 1), ${p.P1} bar`],
    A2: [s_A2,   T_A2,   `A2: Reheater outlet / Valve A inlet, ${p.P1} bar`],
    A3: [s_A3,   T_A3,   `A3: Valve A outlet / FWH6 shell inlet, ${p.P_VA} bar`],
    A4: [s_A4,   T_A4,   `A4: FWH6 shell drain (subcooled), ${p.P_VA} bar`],
    A5: [s_A5,   T_A5,   `A5: FWH6 drain after pump A, ${p.P_feedpump} bar`],
    B1: [s_B_ex, T_B_ex, `B1: FWH5 extraction steam, ${p.P_B} bar`],
    B2: [s_B2,   T_B2,   `B2: FWH5 shell drain (subcooled), ${p.P_B} bar`],
    B3: [s_B3,   T_B3,   `B3: FWH5 drain after pump B, ${p.P_feedpump} bar`],
    C1: [s_C_ex, T_C_ex, `C1: FWH4 extraction steam, ${p.P_C} bar`],
    C2: [s_C2,   T_C2,   `C2: FWH4 shell drain (subcooled), ${p.P_C} bar`],
    C3: [s_C3,   T_C3,   `C3: FWH4 drain after valve C, ${p.P_D} bar (deaerator)`],
    D1: [s_D_ex, T_D_ex, `D1: Deaerator extraction steam, ${p.P_D} bar`],
    E1: [s_E_ex, T_E_ex, `E1: FWH3 extraction steam, ${p.P_E} bar`],
    E2: [s_E2,   T_E2,   `E2: FWH3 shell drain (subcooled), ${p.P_E} bar`],
    E3: [s_E3,   T_E3,   `E3: FWH3 drain after valve E, ${p.P_condpump} bar`],
    F1: [s_F_ex, T_F_ex, `F1: FWH2 extraction steam, ${p.P_F} bar`],
    F2: [s_F2,   T_F2,   `F2: FWH2 shell drain (subcooled), ${p.P_F} bar`],
    F3: [s_F3,   T_F3,   `F3: FWH2 drain after pump F, ${p.P_condpump} bar`],
    G1: [s_G_ex, T_G_ex, `G1: FWH1 extraction steam, ${p.P_G} bar`],
    G2: [s_G2,   T_G2,   `G2: FWH1 shell drain (subcooled), ${p.P_G} bar`],
    G3: [s_G3,   T_G3,   `G3: FWH1 drain after valve G, condenser P`],
  };

  // Drain process paths: pump compressions (seg) and isenthalpic valve drops (two points)
  const drainPaths = [
    iso(P1, h1, h_a2, 6),                    // reheater hot side: A1 -> A2 (cooling at ~P1)
    [[s_A2, T_A2], [s_A3, T_A3]],            // valve A: A2 -> A3 (isenthalpic to shell P)
    seg(h_a4, P_VA, h_a5, Pfw,   4),        // pump A: A4 -> A5
    seg(h_b2, P_B,  h_b3, Pfw,   4),        // pump B: B2 -> B3
    [[s_C2, T_C2], [s_C3, T_C3]],            // valve C: C2 -> C3 (deaerator)
    [[s_E2, T_E2], [s_E3, T_E3]],            // valve E: E2 -> E3 (condensate header)
    seg(h_f2, P_F,  h_f3, Pcond, 4),        // pump F: F2 -> F3
    [[s_G2, T_G2], [s_G3, T_G3]],            // valve G: G2 -> G3 (condenser flash)
  ];

  return {
    m, a, b, c, d, e, f, g,
    h1, h2, h3, h4, h5, h6, h7,
    h8, h9, h10, h11, h12, h13, h14, h15,
    W_net, W_turb, W_pumps, eta_1, eta_2, x5, Ex_sg,
    T6C, T_wb, P6, flow_cond,
    statePoints, extractionStatePoints,
    boilerPath, reheatPath, fwPath,
    hpPath, ipPath, lpPath, fwhShellPaths, condenserPath, drainPaths,
    s1: s1/1000, s2: s2/1000, s3: s3/1000,
    s4: s4/1000, s5: s5/1000, s6: s6v,
  };
}