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
  const Tmin = 273.16;
  const Tmax = 646.8; // stop below critical (647.096 K) to avoid CoolProp singularity
  const N = 80;
  const liq = [], vap = [];
  for (let i = 0; i <= N; i++) {
    const T = Tmin + (Tmax - Tmin) * i / N;
    try {
      liq.push([Q('S', 'T', T, 'Q', 0) / 1000, T - C2K]);
      vap.push([Q('S', 'T', T, 'Q', 1) / 1000, T - C2K]);
    } catch (_) {}
  }
  // Single connected path: up the liquid side then back down the vapor side.
  // Reversing vap joins the two curves at the top without a gap.
  const dome = [...liq, ...[...vap].reverse()];
  return { liq, vap, dome };
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

  // Extraction point T-s coordinates for diagram (all pressures now in scope)
  const h_A_ex = expand(h1, s1, P_VA, p.eta_HP);
  const s_A_ex = Q('S', 'P', P_VA, 'H', h_A_ex) / 1000;
  const T_A_ex = Q('T', 'P', P_VA, 'H', h_A_ex) - C2K;
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
  const h_c3 = h_c2, h_e3 = h_e2;

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

  // g + h7: FWH1 + Hotwell/Condenser mixer.
  //
  // IMPORTANT: the condenser and hotwell are modeled together as ONE combined control
  // volume, not as a simple two-stream energy-balance mixer. Why: the FWH1 drain (g3) sits
  // at FWH1's shell pressure (P_G) and throttles down through Valve G to the condenser's
  // pressure (P6), which is far lower (vacuum, ~kPa-level). That pressure ratio is large
  // enough that g3 partially flashes to vapor on the way down — a naive mixing balance
  // (flow6*h6 + g*h_g3 = flow_fwh1*h7) lets the computed h7 exceed the saturated-liquid
  // enthalpy at P6, i.e. it silently predicts a two-phase mixture entering the condensate
  // pump. Real condensate pumps cannot ingest two-phase flow (cavitation risk); real plants
  // handle this because the hotwell sits inside the condenser's own shell, with a vapor
  // space above the liquid pool — any flashed vapor from the drain simply rejoins the bulk
  // steam being condensed, and only liquid leaves toward the pump.
  //
  // Modeling this correctly: widen the control volume to include the condenser AND hotwell
  // together. Inputs: state 5 (LP exhaust) and g3 (FWH1 drain). Output: state 7 (ALL of
  // flow_fwh1, since nothing else enters or leaves this combined volume - mass is exact,
  // no separate vapor-quality bookkeeping needed). State 7 is BY DEFINITION saturated
  // liquid at P6, the condenser's own outlet condition - a direct property lookup, not a
  // solved unknown. Any "excess" enthalpy from the flashed fraction of g3 is automatically
  // absorbed into the condenser's overall heat-rejection duty (the cooling water removes
  // however much extra heat is needed to re-condense it) - this doesn't require explicit
  // tracking here since we're not currently computing condenser/circulating-water duty in
  // this function.
  //
  // This also makes the FWH1 energy balance LINEAR in g (h7/h8 no longer depend on g at
  // all), so the Newton-Raphson solve previously used here is unnecessary - deleted.
  const flow_fwh1 = m - a - b - c - d - e - f;

  const h7 = h6;
  const s7 = s6;
  const h8 = compress(h7, s7, Pcond, eta_p);

  const g = flow_fwh1 * (h8p - h8) / (h_g1 - h_g2);

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

  // T-s diagram paths

  // Boiler path: handles BOTH supercritical (smooth single-phase heating, no dome
  // crossing) and subcritical (liquid heating -> constant-temperature boiling plateau
  // across the dome -> superheating) cases correctly. A naive linear-temperature sweep
  // (the original approach) is only valid above the critical pressure; below it, the
  // two-phase region has a RANGE of valid entropies at a single (T,P) pair, so a
  // PropsSI('S','P',...,'T',Tsat,...) call at exactly the saturation temperature is
  // undefined and throws. This function explicitly builds up to 3 physically distinct
  // segments and skips whichever ones don't apply for the current T16/T1/P1 combination.
  const T16K = Q('T', 'P', Pfw, 'H', h16);
  const Pcrit = Q('Pcrit', 'P', 0, 'T', 0);
  const boilerPath = [];

  if (P1 >= Pcrit) {
    // Supercritical: no phase change possible, smooth single-phase heating throughout.
    for (let i = 0; i <= 50; i++) {
      const Tp = T16K + (T1 - T16K) * i / 50;
      boilerPath.push([Q('S', 'P', P1, 'T', Tp) / 1000, Tp - C2K]);
    }
  } else {
    // Subcritical: build liquid-heating, boiling, and superheating segments as needed.
    const Tsat = Q('T', 'P', P1, 'Q', 0);
    const EPS = 0.01; // K offset to stay off the exact saturation boundary (avoids the
                       // CoolProp singularity at T == Tsat(P), where entropy is multivalued)

    if (T16K < Tsat - EPS) {
      const n1 = 15;
      for (let i = 0; i <= n1; i++) {
        const Tp = T16K + (Tsat - EPS - T16K) * i / n1;
        boilerPath.push([Q('S', 'P', P1, 'T', Tp) / 1000, Tp - C2K]);
      }
    }
    if (T16K < Tsat + EPS && T1 > Tsat - EPS) {
      const n2 = 20;
      const sf = Q('S', 'P', P1, 'Q', 0) / 1000;
      const sg = Q('S', 'P', P1, 'Q', 1) / 1000;
      for (let i = 0; i <= n2; i++) {
        boilerPath.push([sf + (sg - sf) * i / n2, Tsat - C2K]);
      }
    }
    if (T1 > Tsat + EPS) {
      const n3 = 15;
      for (let i = 0; i <= n3; i++) {
        const Tp = (Tsat + EPS) + (T1 - (Tsat + EPS)) * i / n3;
        boilerPath.push([Q('S', 'P', P1, 'T', Tp) / 1000, Tp - C2K]);
      }
    }
  }

  // Reheater path at P3
  const reheatPath = [];
  for (let i = 0; i <= 10; i++) {
    const Tp = T2 + (T3 - T2) * i / 10;
    reheatPath.push([Q('S', 'P', P3, 'T', Tp) / 1000, Tp - C2K]);
  }

  // Turbine expansion paths with extraction waypoints
  const hpPath = [
    [s1 / 1000, p.T1],
    [s_A_ex, T_A_ex],
    [s_B_ex, T_B_ex],
    [s2 / 1000, T2 - C2K],
  ];
  const ipPath = [
    [s3 / 1000, p.T3],
    [s_C_ex, T_C_ex],
    [s_D_ex, T_D_ex],
    [s4 / 1000, T4 - C2K],
  ];
  const lpPath = [
    [s4 / 1000, T4 - C2K],
    [s_E_ex, T_E_ex],
    [s_F_ex, T_F_ex],
    [s_G_ex, T_G_ex],
    [s5 / 1000, T5],
  ];

  // Feedwater train: T-s for every state
  const T7_v  = Q('T', 'P', P6,    'H', h7)  - C2K;
  const s7_v  = Q('S', 'P', P6,    'H', h7)  / 1000;
  const T8_v  = Q('T', 'P', Pcond, 'H', h8)  - C2K;
  const s8_v  = Q('S', 'P', Pcond, 'H', h8)  / 1000;
  const s9    = Q('S', 'P', Pcond, 'H', h9)  / 1000;
  const T9    = Q('T', 'P', Pcond, 'H', h9)  - C2K;
  const T10_v = Q('T', 'P', Pcond, 'H', h10) - C2K;
  const s10_v = Q('S', 'P', Pcond, 'H', h10) / 1000;
  const s11v  = Q('S', 'P', Pcond, 'H', h11) / 1000;
  const T11v  = Q('T', 'P', Pcond, 'H', h11) - C2K;
  const s12v  = s12 / 1000;
  const T12v  = satT(P_DA) - C2K;
  const s13v  = Q('S', 'P', Pfw,   'H', h13) / 1000;
  const T13v  = Q('T', 'P', Pfw,   'H', h13) - C2K;
  const T14_v = Q('T', 'P', Pfw,   'H', h14) - C2K;
  const s14_v = Q('S', 'P', Pfw,   'H', h14) / 1000;
  const T15_v = Q('T', 'P', Pfw,   'H', h15) - C2K;
  const s15_v = Q('S', 'P', Pfw,   'H', h15) / 1000;
  const s16v  = Q('S', 'P', Pfw,   'H', h16) / 1000;
  const T16v  = T16K - C2K;

  const fwPath = [
    [s6 / 1000, T6C],
    [s7_v,  T7_v],
    [s8_v,  T8_v],
    [s9,    T9],
    [s10_v, T10_v],
    [s11v,  T11v],
    [s12v,  T12v],
    [s13v,  T13v],
    [s14_v, T14_v],
    [s15_v, T15_v],
    [s16v,  T16v],
  ];

  // FWH shell-side paths: desuperheat from extraction point to sat-vapor boundary,
  // then condense horizontally across the dome to sat-liquid
  const shellData = [
    { P: P_VA, sEx: s_A_ex, TEx: T_A_ex, name: 'FWH6 shell' },
    { P: P_B,  sEx: s_B_ex, TEx: T_B_ex, name: 'FWH5 shell' },
    { P: P_C,  sEx: s_C_ex, TEx: T_C_ex, name: 'FWH4 shell' },
    { P: P_D,  sEx: s_D_ex, TEx: T_D_ex, name: 'Deaerator' },
    { P: P_E,  sEx: s_E_ex, TEx: T_E_ex, name: 'FWH3 shell' },
    { P: P_F,  sEx: s_F_ex, TEx: T_F_ex, name: 'FWH2 shell' },
    { P: P_G,  sEx: s_G_ex, TEx: T_G_ex, name: 'FWH1 shell' },
  ];
  const fwhShellPaths = shellData.map(({ P, sEx, TEx, name }) => {
    const Tsat = satT(P) - C2K;
    const sf   = Q('S', 'P', P, 'Q', 0) / 1000;
    const sg   = Q('S', 'P', P, 'Q', 1) / 1000;
    return { name, Tsat, sf, sg, sEx, TEx };
  });

  // All state points [s kJ/kg·K, T deg C, hover label] — no m-dashes
  const statePoints = {
    1:  [s1 / 1000, p.T1,   `State 1: HP turbine inlet, ${p.T1}°C, ${p.P1} bar`],
    2:  [s2 / 1000, T2-C2K, 'State 2: HP exhaust / reheater inlet'],
    3:  [s3 / 1000, p.T3,   `State 3: Reheater outlet / IP inlet, ${p.T3}°C`],
    4:  [s4 / 1000, T4-C2K, 'State 4: IP exhaust / LP inlet'],
    5:  [s5 / 1000, T5,     'State 5: LP exhaust / condenser inlet'],
    6:  [s6 / 1000, T6C,    `State 6: Condenser outlet, ${T6C.toFixed(1)}°C`],
    7:  [s7_v,  T7_v,       'State 7: Hotwell / condenser outlet (sat. liquid)'],
    8:  [s8_v,  T8_v,       'State 8: Condensate pump outlet'],
    9:  [s9,    T9,         'State 9: After FWH2 feedwater side'],
    10: [s10_v, T10_v,      'State 10: FWH3 inlet (feedwater side)'],
    11: [s11v,  T11v,       'State 11: FWH3 outlet (feedwater side)'],
    12: [s12v,  T12v,       `State 12: Deaerator outlet (sat. liq.), ${T12v.toFixed(1)}°C`],
    13: [s13v,  T13v,       'State 13: Feedwater pump outlet'],
    14: [s14_v, T14_v,      'State 14: After FWH5 feedwater side'],
    15: [s15_v, T15_v,      'State 15: After FWH6 / mixer outlet'],
    16: [s16v,  T16v,       `State 16: Boiler inlet, ${T16v.toFixed(1)}°C`],
    A:  [s_A_ex, T_A_ex,   `Extraction A to FWH6 shell, ${p.P_VA} bar`],
    B:  [s_B_ex, T_B_ex,   `Extraction B to FWH5 shell, ${p.P_B} bar`],
    C:  [s_C_ex, T_C_ex,   `Extraction C to FWH4 shell, ${p.P_C} bar`],
    D:  [s_D_ex, T_D_ex,   `Extraction D to Deaerator, ${p.P_D} bar`],
    E:  [s_E_ex, T_E_ex,   `Extraction E to FWH3 shell, ${p.P_E} bar`],
    F:  [s_F_ex, T_F_ex,   `Extraction F to FWH2 shell, ${p.P_F} bar`],
    G:  [s_G_ex, T_G_ex,   `Extraction G to FWH1 shell, ${p.P_G} bar`],
  };

  return {
    m, a, b, c, d, e, f, g,
    h1, h2, h3, h4, h5, h6, h7, h8,
    h9, h10, h11, h12, h13, h14, h15, h16,
    W_net, W_turb, W_pumps, eta_1, eta_2,
    T6C, T_wb, P6,
    statePoints, boilerPath, reheatPath, fwPath,
    hpPath, ipPath, lpPath, fwhShellPaths,
    s1: s1/1000, s2: s2/1000, s3: s3/1000,
    s4: s4/1000, s5: s5/1000, s6: s6/1000,
  };
}