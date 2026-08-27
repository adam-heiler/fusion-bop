import CoolPropModule from './coolprop/coolprop.js';

const W = 'Water';
const C2K = 273.15;
const BAR = 1e5;

// Critical pressure of water (IAPWS-95/NIST). See NOTES.md.
const PCRIT_PA = 22.064e6;

let CP = null;
let _dome = null;

// Per-solve memoization of CoolProp lookups. See NOTES.md.
let _qCache = new Map();
function _qkey(out, n1, v1, n2, v2) { return out + '|' + n1 + v1 + '|' + n2 + v2; }

export async function init() {
  if (CP) return;
  CP = await CoolPropModule();
  _dome = _buildDome();
}

export function getDome() { return _dome; }

// Slider-clamp helpers so the UI can reject invalid pressure combos (Pa/degC, see NOTES.md)

// Minimum P_C keeping FWH4's extraction fraction non-negative.
export function minPC(P_D, TTD, eta_pump, Pfw = 25e6) {
  const h12 = satH(P_D);
  const s12 = Q('S', 'P', P_D, 'Q', 0);
  const h13 = compress(h12, s12, Pfw, eta_pump);
  let lo = P_D, hi = P_D * 5;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const h13p = fwhH(mid, Pfw, TTD);
    if (h13p < h13) lo = mid; else hi = mid;
  }
  return hi;
}

// Minimum P_G keeping FWH1's extraction fraction non-negative.
export function minPG(T6C_est, TTD, eta_pump, Pcond = 5e5) {
  const P6 = Q('P', 'T', T6C_est + C2K, 'Q', 0);
  const h6 = satH(P6);
  const s6 = Q('S', 'P', P6, 'Q', 0);
  const h8 = compress(h6, s6, Pcond, eta_pump);
  let lo = 100, hi = 5e6;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const h8p = fwhH(mid, Pcond, TTD);
    if (h8p < h8) lo = mid; else hi = mid;
  }
  return hi;
}

// Maximum P_E before FWH3's feedwater outlet flashes to vapor.
export function maxPE(TTD, Pcond = 5e5) {
  const Tlimit = satT(Pcond) + TTD;
  return Q('P', 'T', Tlimit, 'Q', 0);
}

function Q(out, n1, v1, n2, v2) {
  const k = _qkey(out, n1, v1, n2, v2);
  const hit = _qCache.get(k);
  if (hit !== undefined) return hit;
  const val = CP.PropsSI(out, n1, v1, n2, v2, W);
  _qCache.set(k, val);
  return val;
}

// Stull (2011) wet-bulb approximation. See NOTES.md.
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

// Isobaric T-s path, h_in to h_out at constant P.
function iso(P, h_in, h_out, N) {
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const h = h_in + (h_out - h_in) * i / N;
    try { pts.push([Q('S', 'P', P, 'H', h) / 1000, Q('T', 'P', P, 'H', h) - C2K]); } catch (_) {}
  }
  return pts;
}

// Pump compression T-s path (linear h, geometric P).
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

// Turbine expansion T-s path, parameterized by entropy. See NOTES.md.
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
  const Tmax = 647.09; // just below critical, closes the dome tip
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
  _qCache.clear();
  const TTD = p.TTD, sub = p.subcool, eta_p = p.eta_pump;
  // Feedwater-heater bypass: forces every extraction fraction (a-g) to zero and
  // routes the feedwater straight through both pumps with no FWH/deaerator/reheat
  // heat addition, so the UI can show the efficiency hit from regeneration alone.
  const bypassFWH = !!p.bypassFWH;

  // Cooling tower: cold circulating-water temp into the condenser. See NOTES.md.
  const T_wb = wetbulb(p.T0, p.RH);
  const T_cw_in = T_wb + p.cw_approach;
  const cp_cw = Q('CPMASS', 'P', 1.5 * BAR, 'T', (T_cw_in + 8) + C2K);

  // Steam generator outlet (supercritical)
  const P1 = p.P1;
  const T1 = p.T1 + C2K;
  const h1 = Q('H', 'P', P1, 'T', T1);
  const s1 = Q('S', 'P', P1, 'T', T1);

  // HP turbine
  const P2 = p.P2;
  const h2 = expand(h1, s1, P2, p.eta_HP);
  const s2 = Q('S', 'P', P2, 'H', h2);
  const T2 = Q('T', 'P', P2, 'H', h2);

  const P_B = p.P_B;
  const h_b1 = expand(h1, s1, P_B, p.eta_HP);

  // Reheater: normally powered by stream A (tapped before the HP turbine); with
  // bypassFWH that stream is zeroed along with every other extraction, so the IP
  // turbine just picks up where the HP turbine left off (no reheat occurs).
  let P3, h3, s3, T3C;
  if (bypassFWH) {
    P3 = P2; h3 = h2; s3 = s2; T3C = T2 - C2K;
  } else {
    P3 = P2 * (1 - p.reheat_dP_pct / 100);
    const T3 = p.T3 + C2K;
    h3 = Q('H', 'P', P3, 'T', T3);
    s3 = Q('S', 'P', P3, 'T', T3);
    T3C = p.T3;
  }
  const T3K = T3C + C2K;

  // IP turbine
  const P4 = p.P4;
  const h4 = expand(h3, s3, P4, p.eta_IP);
  const s4 = Q('S', 'P', P4, 'H', h4);
  const T4 = Q('T', 'P', P4, 'H', h4);

  const P_C = p.P_C;
  const h_c1 = expand(h3, s3, P_C, p.eta_IP);
  const P_D = p.P_D;
  const h_d1 = expand(h3, s3, P_D, p.eta_IP);

  // LP turbine extraction enthalpies (P6-independent); LP exhaust computed after condenser converges, below
  const P_E = p.P_E;
  const h_e1 = expand(h4, s4, P_E, p.eta_LP);
  const P_F = p.P_F;
  const h_f1 = expand(h4, s4, P_F, p.eta_LP);
  const P_G = p.P_G;
  const h_g1 = expand(h4, s4, P_G, p.eta_LP);

  // FWH shell pressures
  const P_VA = p.P_VA;
  const P_FWH1 = P_G, P_FWH2 = P_F, P_FWH3 = P_E;
  const P_FWH4 = P_C, P_FWH5 = P_B, P_FWH6 = P_VA;
  const P_DA = P_D;
  const Pfw = p.P_feedpump;
  const Pcond = p.P_condpump;

  // Extraction point T-s coordinates; stream A is tapped before the HP turbine (a1 = state 1), see NOTES.md
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

  // Drain enthalpies (pure functions of shell pressure + subcooling, so these stay
  // valid even at zero flow)
  const h_g2 = drainH(P_FWH1, sub);
  const h_f2 = drainH(P_FWH2, sub);
  const h_e2 = drainH(P_FWH3, sub);
  const h_c2 = drainH(P_FWH4, sub);
  const h_b2 = drainH(P_FWH5, sub);
  const h_a4 = drainH(P_FWH6, sub);
  const h_c3 = h_c2;   // Valve C isenthalpic

  const Qdot = p.Q * 1e6;

  let m, beta, a, b, c, d, e, f, g;
  let h_a2, h_a3, h_a5, h_b3, h_e3, h_f3;
  let h7, h8, h9, h10, h11, h12, h13, h14, h15, s11;
  let flow_fwh1, flow_fwh2, flow_fwh3, flow_cond, Q_cond;
  let T6C, P6, h6, s6, h5;

  if (bypassFWH) {
    // No extraction anywhere: a-g = 0, and the feedwater carries straight
    // through both pumps with no FWH/deaerator heat addition. m and T6C are
    // now coupled only through the condenser's own UA (no FWH energy balance
    // ties them together), so solve both together via damped fixed-point
    // iteration instead of the usual "m first, then condenser" shortcut.
    a = b = c = d = e = f = g = beta = 0;
    h_a2 = h1; h_a3 = h1; h_a5 = h_a4; h_b3 = h_b2; h_e3 = h_e2; h_f3 = h_f2;

    m = Qdot / (h1 - Q('H', 'P', Pfw, 'T', T_cw_in + 40 + C2K));  // rough seed
    T6C = T_cw_in + 13;
    for (let it = 0; it < 60; it++) {
      const mdot_cw = p.r_cw * m;
      const C_cw = mdot_cw * cp_cw;
      const eps_cond = 1 - Math.exp(-p.UA / C_cw);

      const P6it = Q('P', 'T', T6C + C2K, 'Q', 0);
      const h6it = satH(P6it);
      const h5it = expand(h4, s4, P6it, p.eta_LP);
      const T6C_new = T_cw_in + (m * (h5it - h6it)) / (eps_cond * C_cw);

      const s6it = Q('S', 'P', P6it, 'Q', 0);
      const h7it = compress(h6it, s6it, Pcond, eta_p);
      const s11it = Q('S', 'P', P_DA, 'H', h7it);
      const h12it = compress(h7it, s11it, Pfw, eta_p);
      const m_new = Qdot / (h1 - h12it);

      const converged = Math.abs(T6C_new - T6C) < 1e-5 && Math.abs(m_new - m) < 1e-6 * m;
      T6C = 0.5 * T6C + 0.5 * T6C_new;
      m = 0.5 * m + 0.5 * m_new;
      if (converged) break;
    }

    // Recompute every state at the converged (m, T6C) for self-consistency.
    P6 = Q('P', 'T', T6C + C2K, 'Q', 0);
    h6 = satH(P6);
    s6 = Q('S', 'P', P6, 'Q', 0);
    h5 = expand(h4, s4, P6, p.eta_LP);
    h7 = compress(h6, s6, Pcond, eta_p);
    h8 = h7; h9 = h7; h10 = h7;
    h11 = h10;                                     // deaerator bypassed (isenthalpic staging step)
    s11 = Q('S', 'P', P_DA, 'H', h11);
    h12 = compress(h11, s11, Pfw, eta_p);
    h13 = h12; h14 = h12; h15 = h12;
    Q_cond = m * (h5 - h6);
    flow_cond = flow_fwh1 = flow_fwh2 = flow_fwh3 = m;
  } else {
    // TTD-determined FWH outlet enthalpies. State numbers use v2 numbering (NOTES.md).
    const h7p  = fwhH(P_FWH1, Pcond, TTD);  // FWH1 feedwater outlet (state 7')
    const h8p  = fwhH(P_FWH2, Pcond, TTD);  // FWH2 feedwater outlet (state 8')
    h10        = fwhH(P_FWH3, Pcond, TTD);  // FWH3 feedwater outlet (state 10)
    const h12p = fwhH(P_FWH4, Pfw,   TTD);  // FWH4 feedwater outlet (state 12')
    const h13p = fwhH(P_FWH5, Pfw,   TTD);  // FWH5 feedwater outlet (state 13')
    h15        = fwhH(P_FWH6, Pfw,   TTD);  // FWH6 feedwater outlet = boiler inlet (state 15)

    // Mass flow rate. m depends only on h1 and h15 (both P6-independent).
    m = Qdot / (h1 - h15);

    // Pump A: FWH6 drain -> feedwater pump pressure
    const s_a4 = Q('S', 'P', P_FWH6, 'H', h_a4);
    h_a5 = compress(h_a4, s_a4, Pfw, eta_p);

    // Pump B: FWH5 drain -> feedwater pump pressure
    const s_b2 = Q('S', 'P', P_FWH5, 'H', h_b2);
    h_b3 = compress(h_b2, s_b2, Pfw, eta_p);

    // Deaerator outlet (state 11) + feedwater pump outlet (state 12)
    h11 = satH(P_DA);
    s11 = Q('S', 'P', P_DA, 'Q', 0);
    h12 = compress(h11, s11, Pfw, eta_p);

    // Pump F: FWH2 drain -> condensate pump pressure
    const s_f2 = Q('S', 'P', P_FWH2, 'H', h_f2);
    h_f3 = compress(h_f2, s_f2, Pcond, eta_p);

    // Pump E: FWH3 drain -> condensate pump pressure; a pump not a valve since chain ordering guarantees Pcond > P_E
    const s_e2 = Q('S', 'P', P_FWH3, 'H', h_e2);
    h_e3 = compress(h_e2, s_e2, Pcond, eta_p);

    // Extraction fractions (closed-form, v2 numbering); see NOTES.md for the reheater mass-balance derivation
    beta = (h13p - h12p) / (h_b1 - h_b2 + h_b3 - h12p);
    const R = h3 - h2;
    a = m * (R + h15 - h13p - beta * R) / (h1 + R - h13p - h_a4 + h_a5 - beta * R);
    b = (m - a) * beta;
    h_a2 = h1 - (m - a - b) * R / a;   // state a2: reheater hot-side outlet (~P1)
    h_a3 = h_a2;                        // state a3: Valve A isenthalpic -> FWH6 shell
    h14 = ((m - a) * h13p + a * h_a5) / m;      // state 14 (M5 outlet = FWH6 inlet)
    h13 = h13p - b * (h_b1 - h_b2) / (m - a);   // state 13 (M4 outlet = FWH5 inlet)

    // c: FWH4 (linear). States 12', 12, 11.
    c = (m - a - b) * (h12p - h12) / (h_c1 - h_c2);

    // d: Deaerator mixer (linear). States 10, 11.
    const flow_abc = m - a - b - c;
    d = ((m - a - b) * h11 - flow_abc * h10 - c * h_c3) / (h_d1 - h10);

    // e: FWH3 + M2 mixer. States 9, 8', 10.
    flow_fwh3 = m - a - b - c - d;
    e = flow_fwh3 * (h10 - h8p) / (h_e1 - h8p);
    h9 = h10 - e * (h_e1 - h_e2) / flow_fwh3;  // state 9 (M2 outlet = FWH3 inlet)

    // f: FWH2 + M1 mixer. States 8, 7', 8'. See NOTES.md for the M1 balance.
    flow_fwh2 = m - a - b - c - d - e;
    f = flow_fwh2 * (h8p - h7p) / (h_f1 - h_f2 + h_f3 - h7p);
    h8 = ((flow_fwh2 - f) * h7p + f * h_f3) / flow_fwh2;  // state 8 (M1 outlet)

    flow_fwh1 = m - a - b - c - d - e - f;

    // Condenser: ε-NTU model, bounded fixed point on T_cond. See NOTES.md.
    const mdot_cw = p.r_cw * m;
    const C_cw = mdot_cw * cp_cw;
    const NTU_cond = p.UA / C_cw;
    const eps_cond = 1 - Math.exp(-NTU_cond);

    T6C = T_cw_in + 13;   // initial guess for condenser saturation temperature (°C)
    const COND_MAXIT = 40, COND_TOL = 1e-5;
    for (let it = 0; it < COND_MAXIT; it++) {
      P6 = Q('P', 'T', T6C + C2K, 'Q', 0);
      h6 = satH(P6);
      s6 = Q('S', 'P', P6, 'Q', 0);
      h5 = expand(h4, s4, P6, p.eta_LP);            // LP exhaust at condenser pressure
      h7 = compress(h6, s6, Pcond, eta_p);          // condensate pump outlet (state 7)
      g  = flow_fwh1 * (h7p - h7) / (h_g1 - h_g2);  // FWH1 extraction fraction
      flow_cond = flow_fwh1 - g;
      Q_cond = flow_cond * h5 + g * h_g2 - flow_fwh1 * h6;
      const T6C_new = T_cw_in + Q_cond / (eps_cond * C_cw);
      if (Math.abs(T6C_new - T6C) < COND_TOL && it > 0) { T6C = T6C_new; break; }
      T6C = T6C_new;
    }
    // Recompute at the converged T6C for a self-consistent condenser pressure.
    P6 = Q('P', 'T', T6C + C2K, 'Q', 0);
    h6 = satH(P6);
    s6 = Q('S', 'P', P6, 'Q', 0);
    h5 = expand(h4, s4, P6, p.eta_LP);
    h7 = compress(h6, s6, Pcond, eta_p);
    g  = flow_fwh1 * (h7p - h7) / (h_g1 - h_g2);
    flow_cond = flow_fwh1 - g;
    Q_cond = flow_cond * h5 + g * h_g2 - flow_fwh1 * h6;
  }

  const P5 = P6;
  const s5 = Q('S', 'P', P5, 'H', h5);
  const x5 = Q('Q', 'P', P5, 'H', h5);         // LP exhaust steam quality (-1 if superheated)
  // T5 needs its own lookup when superheated. See NOTES.md.
  const T5 = x5 >= 0 ? T6C : Q('T', 'P', P5, 'H', h5) - C2K;

  // Emergent circulating-water metrics (readouts, not inputs).
  const mdot_cw = p.r_cw * m;
  const C_cw = mdot_cw * cp_cw;
  const NTU_cond = p.UA / C_cw;
  const eps_cond = 1 - Math.exp(-NTU_cond);
  const cond_range   = Q_cond / C_cw;          // CW temperature rise across the condenser
  const T_cw_out     = T_cw_in + cond_range;
  const cond_TTD_eff = T6C - T_cw_out;         // condenser terminal temperature difference

  // Derived power outputs

  const W_HP  = (m - a) * h1 - (m - a - b) * h2 - b * h_b1;
  const W_IP  = (m - a - b) * h3 - (m - a - b - c - d) * h4 - c * h_c1 - d * h_d1;
  const W_LP  = (m - a - b - c - d) * h4 - flow_cond * h5 - e * h_e1 - f * h_f1 - g * h_g1;
  const W_turb = W_HP + W_IP + W_LP;

  const W_condpump = flow_fwh1 * (h7 - h6);       // condensate pump: states 6->7
  const W_pA = a * (h_a5 - h_a4);
  const W_pB = b * (h_b3 - h_b2);
  const W_pF = f * (h_f3 - h_f2);
  const W_pE = e * (h_e3 - h_e2);
  const W_fwp = (m - a - b) * (h12 - h11);        // feedwater pump: states 11->12

  // Circulating water pump, basin -> condenser inlet -> back up to the tower
  // distribution deck. This cycle is modeled with a natural-draft hyperbolic
  // tower (buoyancy-driven, no fan) rather than a mechanical-draft one, but
  // that mainly changes the empty chimney shell above the fill - the pump only
  // has to lift water to the top of the fill/distribution deck, which for a
  // large natural-draft tower is still a modest height, not the tower's full
  // structural height. No piping/tower layout is modeled, so head is split
  // into two representative terms instead of one flat guess: a static lift to
  // that distribution deck (plant geometry doesn't depend on flow), plus a
  // friction term anchored to a reference CW flow and scaled by velocity^2
  // (~mdot_cw^2) like any real piping/tube-side loss, so it actually responds
  // to r_cw and the solved cycle instead of sitting fixed. Both anchor figures
  // are generic plant-scale ballparks, not a specific site's design - see
  // NOTES.md.
  const P_cw_lo = 1.5 * BAR;
  const rho_cw = Q('DMASS', 'P', P_cw_lo, 'T', T_cw_in + C2K);
  const H_LIFT = 15;                  // m, typical fill/distribution-deck height above the basin for a large natural-draft tower
  const dP_lift = rho_cw * 9.81 * H_LIFT;
  const MDOT_CW_REF = 12300;          // kg/s, representative CW flow for a large fossil-fuel unit's condenser (a fixed anchor, deliberately not tied to whatever the Q/r_cw sliders currently default to)
  const dP_FRICTION_REF = 0.9 * BAR;  // piping + condenser tube-side friction at that reference flow
  const dP_cw = dP_lift + dP_FRICTION_REF * (mdot_cw / MDOT_CW_REF) ** 2;
  const h_cwin = Q('H', 'P', P_cw_lo, 'T', T_cw_in + C2K);
  const s_cwin = Q('S', 'P', P_cw_lo, 'T', T_cw_in + C2K);
  const h_cwout = compress(h_cwin, s_cwin, P_cw_lo + dP_cw, eta_p);
  const W_cwpump = mdot_cw * (h_cwout - h_cwin);

  const W_pumps = W_condpump + W_pA + W_pB + W_pF + W_pE + W_fwp + W_cwpump;

  const W_net = (W_turb - W_pumps) * p.eta_gen;
  const eta_1 = W_net / Qdot;

  // 2nd law (exergetic) efficiency. See NOTES.md.
  //
  // Ex_steam is the exergy the WORKING FLUID gains crossing the boiler - a
  // legitimate textbook quantity, but scoped only to the steam side. It has no
  // way to see how irreversibly that heat was actually transferred in, so a
  // slider change that forces the boiler to heat much colder feedwater (e.g.
  // bypassing every FWH) can make eta_2 look *better* even though the plant is
  // strictly worse: cutting the FWHs' own mixing/throttling losses can outweigh
  // the (invisible, to Ex_steam) extra irreversibility of the wider-ΔT boiler
  // heat exchange, unless there's an actual external reference to check against.
  //
  // Ex_source fixes that by pricing the SAME heat Qdot against the
  // intermediate loop's own temperature glide instead of the steam's. This is
  // the solar-salt loop from the plant diagram (60% NaNO3/40% KNO3, MANTA
  // Collaboration 2024) - distinct from the FLiBe primary loop, which cools
  // the blanket but never reaches the power cycle. It enters the steam
  // generator at 565 C and leaves at 505 C (Colliva et al. 2024, Table 1 -
  // same supply/return regardless of which paper's intermediate fluid is
  // used, since the exergy calc below only needs the two temperatures and
  // the duty, not the fluid's mass flow or cp). For a sensible-heat stream of
  // ~constant cp, the exergy it gives up cooling from T_in to T_out at duty
  // Qdot is Qdot*(1 - T0/T_lm), where T_lm is the log-mean (entropic-average)
  // temperature of that stream. Ex_source is therefore independent of every
  // steam-side slider, so eta_2 = W_net/Ex_source now moves the same
  // direction as eta_1 for changes that make the boiler's job harder,
  // closing the loophole above.
  const T0K = p.T0 + C2K;
  const T_SOURCE_IN = 565 + C2K;   // intermediate (solar-salt) loop supply to the steam generator
  const T_SOURCE_OUT = 505 + C2K;  // intermediate loop return
  const T_lm_source = (T_SOURCE_IN - T_SOURCE_OUT) / Math.log(T_SOURCE_IN / T_SOURCE_OUT);
  const Ex_source = Qdot * (1 - T0K / T_lm_source);

  const s15_si = Q('S', 'P', Pfw, 'H', h15); // J/kg/K
  const Ex_steam = m * ((h1 - h15) - T0K * (s1 - s15_si));
  const eta_2 = W_net / Ex_source;
  const Irr_sg = Ex_source - Ex_steam;  // exergy destroyed transferring heat into the steam itself
  const Irr_cycle = Ex_steam - W_net;   // exergy destroyed downstream of the boiler (turbines, condenser, pumps, FWH mixing)
  const Irr = Ex_source - W_net;        // total exergy destroyed, consistent with eta_2 (Irr_sg + Irr_cycle)

  // T-s diagram paths

  // Steam-generator path, state 15 to state 1; handles both supercritical and subcritical cases
  const T15K = Q('T', 'P', Pfw, 'H', h15);
  const Pcrit = PCRIT_PA;
  const steamGenPath = [];

  if (P1 >= Pcrit) {
    for (let i = 0; i <= 35; i++) {
      const Tp = T15K + (T1 - T15K) * i / 35;
      steamGenPath.push([Q('S', 'P', P1, 'T', Tp) / 1000, Tp - C2K]);
    }
  } else {
    const Tsat = Q('T', 'P', P1, 'Q', 0);
    const EPS = 0.01;
    if (T15K < Tsat - EPS) {
      const n1 = 10;
      for (let i = 0; i <= n1; i++) {
        const Tp = T15K + (Tsat - EPS - T15K) * i / n1;
        steamGenPath.push([Q('S', 'P', P1, 'T', Tp) / 1000, Tp - C2K]);
      }
    }
    if (T15K < Tsat + EPS && T1 > Tsat - EPS) {
      const n2 = 12;
      const sf = Q('S', 'P', P1, 'Q', 0) / 1000;
      const sg = Q('S', 'P', P1, 'Q', 1) / 1000;
      for (let i = 0; i <= n2; i++) {
        steamGenPath.push([sf + (sg - sf) * i / n2, Tsat - C2K]);
      }
    }
    if (T1 > Tsat + EPS) {
      const n3 = 10;
      for (let i = 0; i <= n3; i++) {
        const Tp = (Tsat + EPS) + (T1 - (Tsat + EPS)) * i / n3;
        steamGenPath.push([Q('S', 'P', P1, 'T', Tp) / 1000, Tp - C2K]);
      }
    }
  }

  // Reheater path at P3
  const reheatPath = [];
  for (let i = 0; i <= 8; i++) {
    const Tp = T2 + (T3K - T2) * i / 8;
    reheatPath.push([Q('S', 'P', P3, 'T', Tp) / 1000, Tp - C2K]);
  }

  // Turbine expansion paths, entropy-parameterized. See NOTES.md.
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

  // Feedwater train T-s coordinates, v2 numbering (state 6 = condenser+hotwell outlet, state 7 = condensate pump outlet)
  const s6v   = s6 / 1000;                              // state 6
  const T6v   = T6C;
  const T7v   = Q('T', 'P', Pcond, 'H', h7)  - C2K;   // state 7
  const s7v   = Q('S', 'P', Pcond, 'H', h7)  / 1000;
  const T8v   = Q('T', 'P', Pcond, 'H', h8)  - C2K;   // state 8
  const s8v   = Q('S', 'P', Pcond, 'H', h8)  / 1000;
  const T9v   = Q('T', 'P', Pcond, 'H', h9)  - C2K;   // state 9
  const s9v   = Q('S', 'P', Pcond, 'H', h9)  / 1000;
  const T10v  = Q('T', 'P', Pcond, 'H', h10) - C2K;   // state 10
  const s10v  = Q('S', 'P', Pcond, 'H', h10) / 1000;
  const s11v  = s11 / 1000;                             // state 11 (deaerator outlet)
  const T11v  = Q('T', 'P', P_DA, 'H', h11) - C2K;    // sat. liquid normally; subcooled if bypassed
  const T12v  = Q('T', 'P', Pfw,   'H', h12) - C2K;   // state 12
  const s12v  = Q('S', 'P', Pfw,   'H', h12) / 1000;
  const T13v  = Q('T', 'P', Pfw,   'H', h13) - C2K;   // state 13
  const s13v  = Q('S', 'P', Pfw,   'H', h13) / 1000;
  const T14v  = Q('T', 'P', Pfw,   'H', h14) - C2K;   // state 14
  const s14v  = Q('S', 'P', Pfw,   'H', h14) / 1000;
  const T15v  = T15K - C2K;                             // state 15 (boiler inlet)
  const s15v  = Q('S', 'P', Pfw,   'H', h15) / 1000;

  // Condenser: isobar from LP exhaust to sat liquid at P6
  const condenserPath = iso(P6, h5, h6, 8);

  // Feedwater train isobars; state 10->11 bridges as a single point (mixing jump, not an isobar)
  const fwPath = [
    ...seg(h6,  P6,   h7,  Pcond, 4),          // condensate pump 6->7
    ...iso(Pcond, h7,  h8,  8).slice(1),         // LP FWH tube heating 7->8
    ...iso(Pcond, h8,  h9,  6).slice(1),         // LP FWH tube heating 8->9
    ...iso(Pcond, h9,  h10, 6).slice(1),         // FWH3 tube heating 9->10
    [s11v, T11v],                                 // deaerator outlet bridge
    ...seg(h11, P_DA, h12, Pfw, 5).slice(1),    // feedwater pump 11->12
    ...iso(Pfw, h12, h13, 5).slice(1),           // M4 mixing/heating 12->13
    ...iso(Pfw, h13, h14, 6).slice(1),           // FWH5 tube heating 13->14
    ...iso(Pfw, h14, h15, 6).slice(1),           // FWH6 tube heating 14->15
  ];

  // FWH shell-side paths: desuperheat to sat-vapor, then condense across the dome.
  const shellData = [
    { P: P_VA, hEx: h_a3, sEx: s_A_ex, TEx: T_A_ex, name: 'FWH6 shell' },
    { P: P_B,  hEx: h_b1,  sEx: s_B_ex, TEx: T_B_ex, name: 'FWH5 shell' },
    { P: P_C,  hEx: h_c1,  sEx: s_C_ex, TEx: T_C_ex, name: 'FWH4 shell' },
    { P: P_D,  hEx: h_d1,  sEx: s_D_ex, TEx: T_D_ex, name: 'Deaerator' },
    { P: P_E,  hEx: h_e1,  sEx: s_E_ex, TEx: T_E_ex, name: 'FWH3 shell' },
    { P: P_F,  hEx: h_f1,  sEx: s_F_ex, TEx: T_F_ex, name: 'FWH2 shell' },
    { P: P_G,  hEx: h_g1,  sEx: s_G_ex, TEx: T_G_ex, name: 'FWH1 shell' },
  ];
  // No steam actually flows to any shell when bypassed, so there's nothing to draw.
  const fwhShellPaths = bypassFWH ? [] : shellData.map(({ P, hEx, sEx, TEx, name }) => {
    const Tsat = satT(P) - C2K;
    const sf   = Q('S', 'P', P, 'Q', 0) / 1000;
    const sg   = Q('S', 'P', P, 'Q', 1) / 1000;
    const h_sg = Q('H', 'P', P, 'Q', 1);
    // Already two-phase at entry (e.g. FWH6): skip the desuperheat leg. See NOTES.md.
    if (hEx <= h_sg) {
      const s_in = Q('S', 'P', P, 'H', hEx) / 1000;
      return { name, Tsat, sf, sg: s_in, sEx, TEx, desupPath: [] };
    }
    const desupPath = iso(P, hEx, h_sg, 6);
    return { name, Tsat, sf, sg, sEx, TEx, desupPath };
  });

  // All 15 main cycle state points - always shown on the T-s diagram.
  const statePoints = {
    1:  [s1/1000,  p.T1,    `State 1: Boiler outlet / HP turbine inlet, ${p.T1}°C, ${(p.P1/1e6).toFixed(1)} MPa`],
    2:  [s2/1000,  T2-C2K,  bypassFWH ? 'State 2: HP turbine exhaust / IP turbine inlet (no reheat)' : 'State 2: HP turbine exhaust / reheater inlet'],
    3:  [s3/1000,  T3C,     bypassFWH ? `State 3: = state 2, reheat bypassed` : `State 3: Reheater outlet / IP turbine inlet, ${T3C}°C`],
    4:  [s4/1000,  T4-C2K,  'State 4: IP turbine exhaust / LP turbine inlet'],
    5:  [s5/1000,  T5,      'State 5: LP turbine exhaust / condenser inlet'],
    6:  [s6v,      T6v,     `State 6: Condenser+hotwell outlet (sat. liquid), ${T6C.toFixed(1)}°C`],
    7:  [s7v,      T7v,     'State 7: Condensate pump outlet'],
    8:  [s8v,      T8v,     'State 8: M1 outlet / FWH2 tube inlet'],
    9:  [s9v,      T9v,     'State 9: M2 outlet / FWH3 tube inlet'],
    10: [s10v,     T10v,    'State 10: FWH3 tube outlet'],
    11: [s11v,     T11v,    bypassFWH ? `State 11: Deaerator bypassed (subcooled), ${T11v.toFixed(1)}°C` : `State 11: Deaerator outlet (sat. liquid), ${T11v.toFixed(1)}°C`],
    12: [s12v,     T12v,    'State 12: Feedwater pump outlet'],
    13: [s13v,     T13v,    'State 13: M4 outlet / FWH5 tube inlet'],
    14: [s14v,     T14v,    'State 14: M5 outlet / FWH6 tube inlet'],
    15: [s15v,     T15v,    `State 15: Boiler inlet, ${T15v.toFixed(1)}°C`],
  };

  // Extraction/drain state points, shown via the checkbox panel; see NOTES.md for the naming scheme
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

  // Valve outlet states (X3 for C, G); E3 is a pump outlet, not a throttle, see note by W_pE
  const s_C3 = Q('S','P',P_DA,  'H',h_c2)/1000; const T_C3 = Q('T','P',P_DA,  'H',h_c2)-C2K;
  const s_E3 = Q('S','P',Pcond, 'H',h_e3)/1000; const T_E3 = Q('T','P',Pcond, 'H',h_e3)-C2K;
  const s_G3 = Q('S','P',P6,    'H',h_g2)/1000; const T_G3 = Q('T','P',P6,    'H',h_g2)-C2K;

  const MPa = (pa) => `${(pa/1e6).toFixed(1)} MPa`;
  const kPa = (pa) => `${(pa/1e3).toFixed(0)} kPa`;

  // No steam actually flows to any extraction/drain point when bypassed, so
  // there's nothing real to plot - matches fwhShellPaths/drainPaths above.
  const extractionStatePoints = bypassFWH ? {} : {
    A1: [s_A_ex, T_A_ex, `A1: Extraction to reheater (= state 1), ${MPa(p.P1)}`],
    A2: [s_A2,   T_A2,   `A2: Reheater outlet / Valve A inlet, ${MPa(p.P1)}`],
    A3: [s_A3,   T_A3,   `A3: Valve A outlet / FWH6 shell inlet, ${MPa(p.P_VA)}`],
    A4: [s_A4,   T_A4,   `A4: FWH6 shell drain (subcooled), ${MPa(p.P_VA)}`],
    A5: [s_A5,   T_A5,   `A5: FWH6 drain after pump A, ${MPa(p.P_feedpump)}`],
    B1: [s_B_ex, T_B_ex, `B1: FWH5 extraction steam, ${MPa(p.P_B)}`],
    B2: [s_B2,   T_B2,   `B2: FWH5 shell drain (subcooled), ${MPa(p.P_B)}`],
    B3: [s_B3,   T_B3,   `B3: FWH5 drain after pump B, ${MPa(p.P_feedpump)}`],
    C1: [s_C_ex, T_C_ex, `C1: FWH4 extraction steam, ${kPa(p.P_C)}`],
    C2: [s_C2,   T_C2,   `C2: FWH4 shell drain (subcooled), ${kPa(p.P_C)}`],
    C3: [s_C3,   T_C3,   `C3: FWH4 drain after valve C, ${kPa(p.P_D)} (deaerator)`],
    D1: [s_D_ex, T_D_ex, `D1: Deaerator extraction steam, ${kPa(p.P_D)}`],
    E1: [s_E_ex, T_E_ex, `E1: FWH3 extraction steam, ${kPa(p.P_E)}`],
    E2: [s_E2,   T_E2,   `E2: FWH3 shell drain (subcooled), ${kPa(p.P_E)}`],
    E3: [s_E3,   T_E3,   `E3: FWH3 drain after pump E, ${kPa(p.P_condpump)}`],
    F1: [s_F_ex, T_F_ex, `F1: FWH2 extraction steam, ${kPa(p.P_F)}`],
    F2: [s_F2,   T_F2,   `F2: FWH2 shell drain (subcooled), ${kPa(p.P_F)}`],
    F3: [s_F3,   T_F3,   `F3: FWH2 drain after pump F, ${kPa(p.P_condpump)}`],
    G1: [s_G_ex, T_G_ex, `G1: FWH1 extraction steam, ${kPa(p.P_G)}`],
    G2: [s_G2,   T_G2,   `G2: FWH1 shell drain (subcooled), ${kPa(p.P_G)}`],
    G3: [s_G3,   T_G3,   `G3: FWH1 drain after valve G, condenser P`],
  };

  // Drain process paths: pump compressions (seg) and isenthalpic valve drops (two points).
  // No steam actually flows to any drain when bypassed, so there's nothing to draw.
  const drainPaths = bypassFWH ? [] : [
    iso(P1, h1, h_a2, 6),                    // reheater hot side: A1 -> A2 (cooling at ~P1)
    [[s_A2, T_A2], [s_A3, T_A3]],            // valve A: A2 -> A3 (isenthalpic to shell P)
    seg(h_a4, P_VA, h_a5, Pfw,   4),        // pump A: A4 -> A5
    seg(h_b2, P_B,  h_b3, Pfw,   4),        // pump B: B2 -> B3
    [[s_C2, T_C2], [s_C3, T_C3]],            // valve C: C2 -> C3 (deaerator)
    seg(h_e2, P_E,  h_e3, Pcond, 4),        // pump E: E2 -> E3 (condensate header)
    seg(h_f2, P_F,  h_f3, Pcond, 4),        // pump F: F2 -> F3
    [[s_G2, T_G2], [s_G3, T_G3]],            // valve G: G2 -> G3 (condenser flash)
  ];

  // Full 15-state table; flow bookkeeping follows extraction order down the turbine train and back up as drains rejoin at M1-M5
  const stateTable = [
    ['1',  p.T1,  P1,    h1,  s1/1000,   m],
    ['2',  T2-C2K, P2,   h2,  s2/1000,   m - a - b],
    ['3',  T3C,   P3,    h3,  s3/1000,   m - a - b],
    ['4',  T4-C2K, P4,   h4,  s4/1000,   m - a - b - c - d],
    ['5',  T5,    P5,    h5,  s5/1000,   flow_cond],
    ['6',  T6C,   P6,    h6,  s6v,       flow_fwh1],
    ['7',  T7v,   Pcond, h7,  s7v,       flow_fwh1],
    ['8',  T8v,   Pcond, h8,  s8v,       flow_fwh2],
    ['9',  T9v,   Pcond, h9,  s9v,       flow_fwh3],
    ['10', T10v,  Pcond, h10, s10v,      flow_fwh3],
    ['11', T11v,  P_DA,  h11, s11v,      m - a - b],
    ['12', T12v,  Pfw,   h12, s12v,      m - a - b],
    ['13', T13v,  Pfw,   h13, s13v,      m - a],
    ['14', T14v,  Pfw,   h14, s14v,      m],
    ['15', T15v,  Pfw,   h15, s15v,      m],
  ].map(([name, T, P, h, s, flow]) => ({
    name, T, P: P / 1e6, h: h / 1000, s, flow,
  }));

  // Extraction/drain state table; each bleed's flow is constant along its branch (a-g), see NOTES.md
  const extractionTable = [
    ['A1', 'A', T_A_ex, P1,   h1,   s_A_ex, a],
    ['A2', 'A', T_A2,   P1,   h_a2, s_A2,   a],
    ['A3', 'A', T_A3,   P_VA, h_a3, s_A3,   a],
    ['A4', 'A', T_A4,   P_VA, h_a4, s_A4,   a],
    ['A5', 'A', T_A5,   Pfw,  h_a5, s_A5,   a],
    ['B1', 'B', T_B_ex, P_B,  h_b1, s_B_ex, b],
    ['B2', 'B', T_B2,   P_B,  h_b2, s_B2,   b],
    ['B3', 'B', T_B3,   Pfw,  h_b3, s_B3,   b],
    ['C1', 'C', T_C_ex, P_C,  h_c1, s_C_ex, c],
    ['C2', 'C', T_C2,   P_C,  h_c2, s_C2,   c],
    ['C3', 'C', T_C3,   P_D,  h_c3, s_C3,   c],
    ['D1', 'D', T_D_ex, P_D,  h_d1, s_D_ex, d],
    ['E1', 'E', T_E_ex, P_E,  h_e1, s_E_ex, e],
    ['E2', 'E', T_E2,   P_E,  h_e2, s_E2,   e],
    ['E3', 'E', T_E3,   Pcond,h_e3, s_E3,   e],
    ['F1', 'F', T_F_ex, P_F,  h_f1, s_F_ex, f],
    ['F2', 'F', T_F2,   P_F,  h_f2, s_F2,   f],
    ['F3', 'F', T_F3,   Pcond,h_f3, s_F3,   f],
    ['G1', 'G', T_G_ex, P_G,  h_g1, s_G_ex, g],
    ['G2', 'G', T_G2,   P_G,  h_g2, s_G2,   g],
    ['G3', 'G', T_G3,   P6,   h_g2, s_G3,   g],
  ].map(([name, group, T, P, h, s, flow]) => ({
    name, group, T, P: P / 1e6, h: h / 1000, s, flow,
  }));

  return {
    m, a, b, c, d, e, f, g,
    h1, h2, h3, h4, h5, h6, h7,
    h8, h9, h10, h11, h12, h13, h14, h15,
    W_net, W_turb, W_pumps, W_fwp, W_cwpump, W_condpump, W_pE, eta_1, eta_2, x5,
    Ex_source, Ex_steam, Irr, Irr_sg, Irr_cycle,
    T6C, T_wb, P6, flow_cond,
    // Level-3 circulating-water / condenser readouts (all emergent):
    mdot_cw, cp_cw, NTU_cond, eps_cond, cond_range, cond_TTD_eff, T_cw_in, T_cw_out, Q_cond,
    statePoints, extractionStatePoints, stateTable, extractionTable,
    steamGenPath, reheatPath, fwPath,
    hpPath, ipPath, lpPath, fwhShellPaths, condenserPath, drainPaths,
    s1: s1/1000, s2: s2/1000, s3: s3/1000,
    s4: s4/1000, s5: s5/1000, s6: s6v,
  };
}
