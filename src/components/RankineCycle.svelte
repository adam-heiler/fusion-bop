<script lang="ts">
  import { onMount } from 'svelte';
  import { initSolver, solveCycleAsync, minPCAsync, minPGAsync, maxPEAsync } from '../lib/solverWorkerClient.js';
  import Gauge from './Gauge.svelte';

  // -- Slider state -----------------------------------------------------------
  // Single source of truth for every slider's starting value, so the Reset button (below)
  // can restore the exact same cycle rather than drifting from these initializers over time.
  const DEFAULTS = {
    P1: 250, T1: 540, T3: 500, P2: 60, P4: 5, reheat_dP_pct: 3,
    P_VA: 117, P_B: 100, P_C: 7.5, P_D: 6, P_E: 4.3, P_F: 2.2, P_G: 1.5,
    Q: 1000,
    eta_HP: 0.85, eta_IP: 0.85, eta_LP: 0.85, eta_pump: 0.85, eta_gen: 0.985,
    TTD: 2.8, T0: 25, RH: 50, cw_approach: 3.1,
    // Level-3 circulating-water inputs (replace the old fixed cond_TTD slider):
    //   r_cw = circulating-water : steam mass-flow ratio (sets ṁ_cw = r_cw · ṁ_steam)
    //   UA   = condenser conductance (MW/K), the held physical size of the condenser.
    // The condenser terminal difference (TTD) and CW temperature rise (range) are now
    // EMERGENT outputs of the ε-NTU model, not inputs.
    r_cw: 23, UA: 80.9,
  };

  let P1            = $state(DEFAULTS.P1);
  let T1            = $state(DEFAULTS.T1);
  let T3            = $state(DEFAULTS.T3);
  let P2            = $state(DEFAULTS.P2);
  let P4            = $state(DEFAULTS.P4);
  let reheat_dP_pct = $state(DEFAULTS.reheat_dP_pct);
  let P_VA          = $state(DEFAULTS.P_VA);
  let P_B           = $state(DEFAULTS.P_B);
  let P_C           = $state(DEFAULTS.P_C);
  let P_D           = $state(DEFAULTS.P_D);
  let P_E           = $state(DEFAULTS.P_E);
  let P_F           = $state(DEFAULTS.P_F);
  let P_G           = $state(DEFAULTS.P_G);
  let Q             = $state(DEFAULTS.Q);
  let eta_HP   = $state(DEFAULTS.eta_HP);
  let eta_IP   = $state(DEFAULTS.eta_IP);
  let eta_LP   = $state(DEFAULTS.eta_LP);
  let eta_pump = $state(DEFAULTS.eta_pump);
  let eta_gen  = $state(DEFAULTS.eta_gen);
  let TTD         = $state(DEFAULTS.TTD);
  let T0          = $state(DEFAULTS.T0);
  let RH          = $state(DEFAULTS.RH);
  let cw_approach = $state(DEFAULTS.cw_approach);
  let r_cw        = $state(DEFAULTS.r_cw);
  let UA          = $state(DEFAULTS.UA);

  const FIXED = {
    P_condpump: 5, P_feedpump: 250, subcool: 2.8,
  };

  const PCRIT = 220.64;
  const isSupercritical = $derived(P1 >= PCRIT);

  // ── Pressure ordering enforcement ───────────────────────────────────────────
  // Required chain (steam generator -> condenser): P1 > P_VA > P_B > P2 > P_C > P_D > P4 > P_E >
  // P_F > P_G. Each pressure is a heater/turbine-bleed point along the expansion path; if
  // this ordering is violated the cycle is not physically meaningful (e.g. a "later"
  // feedwater heater would need to heat the feedwater to a LOWER temperature than an
  // earlier one already achieved). Sliders keep their full static range for a stable,
  // non-jumpy track, but any edit is clamped against its neighbors immediately after, with
  // a brief warning shown if a clamp actually had to engage.
  //
  // TWO of these boundaries (P_C against the deaerator at P_D, and P_G against the
  // condenser) are NOT safely covered by pressure ordering alone: every FWH-to-FWH boundary
  // has the SAME terminal temperature difference (TTD) subtracted on both sides, so it
  // cancels out and pure pressure ordering is sufficient there. But the deaerator and
  // condenser outlets are saturated liquid with NO TTD subtracted (they're direct-contact/
  // phase-change vessels, not TTD-rated heat exchangers) - so FWH4 (against the deaerator)
  // and FWH1 (against the condenser) each need an EXTRA temperature margin worth of
  // pressure headroom that grows with the TTD slider. Get this wrong and the corresponding
  // extraction fraction (c or g) goes negative, which is unphysical (steam flowing
  // backward into the turbine) even though the solver itself won't crash.
  const GAP = 0.1; // bar, minimum enforced separation for the simple FWH-to-FWH boundaries

  let orderWarning = $state('');
  let warnTimeout: ReturnType<typeof setTimeout> | null = null;

  function flagOrder(msg: string) {
    orderWarning = msg;
    if (warnTimeout) clearTimeout(warnTimeout);
    warnTimeout = setTimeout(() => { orderWarning = ''; }, 7000);
  }

  // Minimum P_C such that FWH4's TTD-determined feedwater outlet temperature stays above
  // what the deaerator + feedwater pump already delivers. Solved numerically inside
  // rankineSolver.js (a few cheap CoolProp calls) rather than in closed form, since the
  // feedwater pump's enthalpy rise doesn't invert analytically.
  async function minPC(): Promise<number> {
    return minPCAsync(P_D, TTD, eta_pump);
  }

  // Minimum P_G such that FWH1's TTD-determined feedwater outlet stays above what the
  // condenser + condensate pump already delivers. Under the Level-3 ε-NTU condenser the
  // condenser saturation temperature is emergent, so we feed the clamp the most recent
  // solved T6C (result.T6C - one drag-step stale, an excellent estimate since sliders move
  // incrementally). On first load, before any solve, fall back to a nominal estimate.
  async function minPG(): Promise<number> {
    const T6C_est = result ? result.T6C : (25 + cw_approach + 13);
    return minPGAsync(T6C_est, TTD, eta_pump);
  }

  // Maximum P_E such that FWH3's TTD-determined feedwater outlet stays below the
  // condensate pump's saturation temperature - see maxPE() in rankineSolver.js for why
  // this boundary exists (P_G/P_F can't hit it, their own sliders top out at/below Pcond;
  // P_E's does not) and what happens when it's crossed (outlet snaps onto the vapor branch).
  async function maxPE(): Promise<number> {
    return maxPEAsync(TTD, FIXED.P_condpump);
  }

  type Chain = [string, () => number, (v: number) => void, number, number][];
  function getChain(): Chain {
    return [
      ['P1',   () => P1,   v => P1 = v,   30, 300],
      ['P_VA', () => P_VA, v => P_VA = v, 60, 200],
      ['P_B',  () => P_B,  v => P_B = v,  50, 150],
      ['P2',   () => P2,   v => P2 = v,   30, 100],
      ['P_C',  () => P_C,  v => P_C = v,  4,  15],
      ['P_D',  () => P_D,  v => P_D = v,  3,  12],
      ['P4',   () => P4,   v => P4 = v,   2,  20],
      ['P_E',  () => P_E,  v => P_E = v,  2,  8],
      ['P_F',  () => P_F,  v => P_F = v,  1,  5],
      ['P_G',  () => P_G,  v => P_G = v,  0.5, 3],
    ];
  }
  const snap = (v: number) => +v.toFixed(3);

  // Special TTD-aware boundaries, on top of plain pressure ordering: FWH4 against the
  // deaerator (P_C), FWH1 against the condenser (P_G), and FWH3 against the condensate pump
  // (P_E, upper-bounded instead of lower). These all depend on TTD, not just on neighboring
  // sliders, so they're pulled out here and re-checked both after any chain-pressure edit
  // AND after a direct TTD edit (a TTD change alone can push a pressure that hasn't moved
  // out of bounds).
  // Returns one human-readable reason per boundary that had to clamp, or [] if none did -
  // callers join these onto the warning toast so the user learns WHY, not just THAT,
  // something moved. The P_E case in particular gets specific "flashing" language: unlike
  // the P_C/P_G cases (which prevent an unphysical negative extraction flow), crossing this
  // one means the feedwater would genuinely start vaporizing inside the FWH3 tubes.
  async function enforceTTDBoundaries(): Promise<string[]> {
    const chain = getChain();
    const reasons: string[] = [];

    const pcMin = await minPC();
    if (pcMin > 0 && P_C < pcMin) {
      P_C = snap(pcMin);
      reasons.push(`P_C (FWH4) raised to ${P_C} bar - any lower and the deaerator would already be hotter than FWH4 could deliver, forcing its extraction flow negative.`);
      for (let i = chain.findIndex(([n]) => n === 'P_C') - 1; i >= 0; i--) {
        const [, get, set, lo, hi] = chain[i];
        const [, getBelow] = chain[i + 1];
        if (get() <= getBelow() + GAP) set(snap(Math.min(hi, Math.max(lo, getBelow() + GAP))));
      }
    }
    const pgMin = await minPG();
    if (pgMin > 0 && P_G < pgMin) {
      P_G = snap(pgMin);
      reasons.push(`P_G (FWH1) raised to ${P_G} bar - any lower and the condenser would already be hotter than FWH1 could deliver, forcing its extraction flow negative.`);
      for (let i = chain.findIndex(([n]) => n === 'P_G') - 1; i >= chain.findIndex(([n]) => n === 'P4'); i--) {
        const [, get, set, lo, hi] = chain[i];
        const [, getBelow] = chain[i + 1];
        if (get() <= getBelow() + GAP) set(snap(Math.min(hi, Math.max(lo, getBelow() + GAP))));
      }
    }
    const peMax = await maxPE();
    if (peMax > 0 && P_E > peMax) {
      const [, , , peLo] = chain[chain.findIndex(([n]) => n === 'P_E')];
      P_E = snap(Math.max(peLo, peMax - GAP));
      reasons.push(`P_E (FWH3) lowered to ${P_E} bar - above this, the shell steam is hotter than the condensate line pressure can keep liquid, so the feedwater would flash to vapor inside the FWH3 tubes.`);
      for (let i = chain.findIndex(([n]) => n === 'P_E') + 1; i < chain.length; i++) {
        const [, get, set, lo, hi] = chain[i];
        const [, getAbove] = chain[i - 1];
        if (get() >= getAbove() - GAP) set(snap(Math.min(hi, Math.max(lo, getAbove() - GAP))));
      }
    }

    return reasons;
  }

  async function enforceOrder(changed: string) {
    // Walk the chain in both directions from the slider that just moved, pushing
    // neighbors out of the way only enough to restore a valid strict ordering.
    // Each entry also carries that slider's own displayed [min,max] - without
    // it, a large enough push (e.g. P1 dropped near its own floor) could
    // compute a "required" value for a neighbor (P_VA) that falls outside
    // what THAT slider can actually show. The <input> silently clamps its
    // displayed value to its own min/max, but the JS state variable doesn't -
    // it kept the un-clampable number, which then fed a negative/broken
    // --pct (fill visibly detached from the thumb) AND, worse, fed that same
    // unrealistic value into the physics solve. Clamping to bounds here
    // means state can never diverge from what's on screen.
    const chain = getChain();
    const idx = chain.findIndex(([name]) => name === changed);
    if (idx === -1) return;

    let clamped = false;

    for (let i = idx - 1; i >= 0; i--) {
      const [, get, set, lo, hi] = chain[i];
      const [, getBelow] = chain[i + 1];
      if (get() <= getBelow() + GAP) {
        set(snap(Math.min(hi, Math.max(lo, getBelow() + GAP))));
        clamped = true;
      }
    }
    for (let i = idx + 1; i < chain.length; i++) {
      const [, get, set, lo, hi] = chain[i];
      const [, getAbove] = chain[i - 1];
      if (get() >= getAbove() - GAP) {
        set(snap(Math.min(hi, Math.max(lo, getAbove() - GAP))));
        clamped = true;
      }
    }

    // Special TTD-aware boundaries: re-check AFTER the plain ordering pass above, since
    // these need a bigger margin than the simple ordering clamp provides.
    const ttdReasons = await enforceTTDBoundaries();

    if (clamped || ttdReasons.length) {
      const msgs = clamped
        ? [`Adjacent pressure(s) shifted to keep ${changed} thermodynamically valid (each stage must heat the feedwater above what the previous stage already delivered).`]
        : [];
      flagOrder(msgs.concat(ttdReasons).join(' '));
    }
  }

  function params() {
    return {
      P1, T1, T3, P2, P4, reheat_dP_pct, P_VA,
      P_B, P_C, P_D, P_E, P_F, P_G, Q,
      eta_HP, eta_IP, eta_LP, eta_pump, eta_gen, TTD,
      T0, RH, cw_approach, r_cw, UA: UA * 1e6,   // UA slider is MW/K -> W/K for the solver
      ...FIXED,
    };
  }

  // ── Extraction / drain state visibility ──────────────────────────────────────
  // X1 = extraction steam (on turbine line) - checked by default.
  // X2 = shell drain subcooled liquid - unchecked by default.
  // X3 = drain after booster pump - unchecked by default.
  let showExtraction: Record<string, boolean> = $state({
    A1: true, A2: true, A3: true, A4: true, A5: true,
    B1: true, B2: true, B3: true,
    C1: true, C2: true, C3: true,
    D1: true,
    E1: true, E2: true, E3: true,
    F1: true, F2: true, F3: true,
    G1: true, G2: true, G3: true,
  });

  // ── App state ─────────────────────────────────────────────────────────────────
  let loading = $state(true);
  let dome    = $state<any>(null);
  let result  = $state<any>(null);
  let errMsg  = $state<string | null>(null);

  async function runSolve() {
    // The solve itself now runs on a Worker (see solverWorkerClient.js), so
    // this await never blocks the main thread - no more macrotask-deferral
    // trick needed to keep the page painting while it runs.
    try {
      result = await solveCycleAsync(params());
      errMsg = null;
    } catch (e: any) {
      errMsg = String(e);
    }
  }

  async function onPressureChange(name: string) {
    await enforceOrder(name);
    runSolve();
  }

  // TTD moves the FWH3/vapor-branch boundary (and the FWH4/FWH1 ones) even when no
  // pressure slider moves, so it needs its own boundary re-check rather than going
  // straight to runSolve() the way a plain non-ordering slider would.
  async function onTTDChange() {
    const reasons = await enforceTTDBoundaries();
    if (reasons.length) flagOrder(reasons.join(' '));
    runSolve();
  }

  // Every slider is independently adjustable and several combinations are easy to walk into
  // that are thermodynamically ugly (very low turbine efficiencies, TTD/pressure combos near
  // the flashing boundary, etc.) - a one-click way back to a known-good cycle beats hunting
  // down and re-dragging every slider that got touched.
  function resetAll() {
    P1 = DEFAULTS.P1; T1 = DEFAULTS.T1; T3 = DEFAULTS.T3; P2 = DEFAULTS.P2; P4 = DEFAULTS.P4;
    reheat_dP_pct = DEFAULTS.reheat_dP_pct;
    P_VA = DEFAULTS.P_VA; P_B = DEFAULTS.P_B; P_C = DEFAULTS.P_C; P_D = DEFAULTS.P_D;
    P_E = DEFAULTS.P_E; P_F = DEFAULTS.P_F; P_G = DEFAULTS.P_G;
    Q = DEFAULTS.Q;
    eta_HP = DEFAULTS.eta_HP; eta_IP = DEFAULTS.eta_IP; eta_LP = DEFAULTS.eta_LP;
    eta_pump = DEFAULTS.eta_pump; eta_gen = DEFAULTS.eta_gen;
    TTD = DEFAULTS.TTD; T0 = DEFAULTS.T0; RH = DEFAULTS.RH;
    cw_approach = DEFAULTS.cw_approach; r_cw = DEFAULTS.r_cw; UA = DEFAULTS.UA;
    orderWarning = '';
    if (warnTimeout) clearTimeout(warnTimeout);
    errMsg = null;
    runSolve();
  }

  onMount(async () => {
    dome = await initSolver();
    loading = false;
    runSolve();
  });

  // ── Gauge value logic (geometry now lives in the shared Gauge.svelte) ───────
  const g1Val = $derived(result ? result.eta_1 : 0);
  const g2Val = $derived(result ? Math.min(result.eta_2, 1) : 0);

  // LP exhaust quality gauge - x5 < 0 is the superheated sentinel (no moisture at all,
  // treated as a full/best-case reading); otherwise fraction is the steam quality itself.
  const g3Frac   = $derived(result ? (result.x5 >= 0 ? result.x5 : 1) : 0);
  const g3Warn   = $derived(!!result && result.x5 >= 0 && result.x5 < 0.85);
  const g3Accent    = $derived(g3Warn ? '#ff6459' : '#6fb2ee');
  const g3AccentDim = $derived(g3Warn ? '#c0392b' : '#2f6fa8');

  // Pump power fraction (W_pumps / W_turb), on the full 0-100% scale like the other
  // gauges - deliberately, since the whole point is to show just how small the parasitic
  // pump load is relative to the turbine's gross output.
  const g4Raw    = $derived(result ? result.W_pumps / result.W_turb : 0);

  // ── T-s diagram geometry ──────────────────────────────────────────────────────
  const SVG_W = 500, SVG_H = 370;
  const PL = 46, PR = 10, PT = 12, PB = 36;
  const CW = SVG_W - PL - PR, CH = SVG_H - PT - PB;
  const S_LO = 0, S_HI = 9.5, T_LO = -5, T_HI = 590;

  function sx(s: number) { return PL + (s - S_LO) / (S_HI - S_LO) * CW; }
  function ty(T: number) { return PT + CH * (1 - (T - T_LO) / (T_HI - T_LO)); }

  function pathD(arr: [number, number][]) {
    if (!arr || arr.length === 0) return '';
    return 'M ' + arr.map(([s, T]) => `${sx(s).toFixed(1)},${ty(T).toFixed(1)}`).join(' L ');
  }

  const T_TICKS = [0, 100, 200, 300, 400, 500];
  const S_TICKS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

  function fmt(v: number | null | undefined, d = 1) {
    return v != null ? v.toFixed(d) : '-';
  }

  // Track-fill percentage, computed reactively so the colored bar stays in sync even
  // when a value changes programmatically (e.g. enforceOrder clamping a neighbor) rather
  // than via direct user dragging, which is when the global --pct-sync script (attached
  // only to native 'input' events) would otherwise miss the update.
  function pct(v: number, min: number, max: number) {
    // Clamped defensively: enforceOrder now keeps state within each
    // slider's own bounds, but this guards against ever rendering a
    // gradient stop outside [0,100] (a negative or >100% --pct visibly
    // detaches the fill from the thumb, which is invalid CSS - browsers
    // just clamp the color-stop, so the "filled" portion silently stops
    // matching where the thumb actually sits).
    return Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100));
  }

</script>

<!-- ── Page title ─────────────────────────────────────────────────────────── -->
<div class="page-header">
  <h1 class="page-title">
    <span class="title-super" class:struck={!isSupercritical}>Supercritical</span> H<sub>2</sub>O Rankine Cycle
  </h1>
  <button type="button" class="reset-btn chamfer-panel chamfer-sm" onclick={resetAll} title="Restore every slider to its default value">
    <span>Reset cycle</span>
  </button>
</div>

<div class="rankine-wrap">
  {#if loading}
    <div class="loading-state chamfer-panel">
      <div class="loading-spinner"></div>
      <p>Initializing CoolProp WASM…</p>
    </div>
  {:else if errMsg}
    <div class="error-banner chamfer-panel chamfer-sm"><span>Solver error: {errMsg}</span></div>
  {:else}
    <!-- ── Left column ─────────────────────────────────────────────────────── -->
    <div class="controls-col">

      {#if orderWarning}
        <div class="order-warning chamfer-panel chamfer-sm"><span>{orderWarning}</span></div>
      {/if}

      <!-- Steam conditions (open by default, steam-generator-orange sliders) -->
      <details class="slider-details chamfer-panel chamfer-sm" style="--slider-color: #e8935f" open>
        <summary class="details-summary">Steam conditions</summary>
        <div class="slider-body">
          <div class="slider-row">
            <div class="slider-label"><span>Steam generator outlet P₁</span><span class="slider-value">{P1} bar</span></div>
            <input id="r-p1" type="range" min="30" max="300" step="1" bind:value={P1} style="--pct: {pct(P1,30,300)}%" onchange={() => onPressureChange('P1')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>Steam generator outlet T₁</span><span class="slider-value">{T1} °C</span></div>
            <input id="r-t1" type="range" min="480" max="600" step="5" bind:value={T1} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>Reheater outlet T₃</span><span class="slider-value">{T3} °C</span></div>
            <input id="r-t3" type="range" min="480" max="600" step="5" bind:value={T3} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>HP exhaust P₂</span><span class="slider-value">{P2} bar</span></div>
            <input id="r-p2" type="range" min="30" max="100" step="1" bind:value={P2} style="--pct: {pct(P2,30,100)}%" onchange={() => onPressureChange('P2')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>IP exhaust P₄</span><span class="slider-value">{P4} bar</span></div>
            <input id="r-p4" type="range" min="2" max="20" step="0.5" bind:value={P4} style="--pct: {pct(P4,2,20)}%" onchange={() => onPressureChange('P4')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>Reheat ΔP</span><span class="slider-value">{reheat_dP_pct} %</span></div>
            <input id="r-rdp" type="range" min="0" max="8" step="0.5" bind:value={reheat_dP_pct} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>FWH6 shell P (Valve A)</span><span class="slider-value">{P_VA} bar</span></div>
            <input id="r-pva" type="range" min="60" max="200" step="1" bind:value={P_VA} style="--pct: {pct(P_VA,60,200)}%" onchange={() => onPressureChange('P_VA')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>Steam generator duty Q</span><span class="slider-value">{Q} MW</span></div>
            <input id="r-q" type="range" min="200" max="2000" step="50" bind:value={Q} onchange={runSolve} />
          </div>
        </div>
      </details>

      <!-- Extraction pressures and feedwater heating (feedwater-teal sliders) -->
      <details class="slider-details chamfer-panel chamfer-sm" style="--slider-color: #1a9b73">
        <summary class="details-summary">Extraction pressures and feedwater heating</summary>
        <div class="slider-body">
          <div class="slider-row">
            <div class="slider-label"><span>P<sub>B</sub> (FWH5 / HP bleed)</span><span class="slider-value">{P_B} bar</span></div>
            <input id="r-pb" type="range" min="50" max="150" step="1" bind:value={P_B} style="--pct: {pct(P_B,50,150)}%" onchange={() => onPressureChange('P_B')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>P<sub>C</sub> (FWH4 / IP bleed)</span><span class="slider-value">{P_C} bar</span></div>
            <input id="r-pc" type="range" min="4" max="15" step="0.1" bind:value={P_C} style="--pct: {pct(P_C,4,15)}%" onchange={() => onPressureChange('P_C')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>P<sub>D</sub> (Deaerator / IP bleed)</span><span class="slider-value">{P_D} bar</span></div>
            <input id="r-pd" type="range" min="3" max="12" step="0.1" bind:value={P_D} style="--pct: {pct(P_D,3,12)}%" onchange={() => onPressureChange('P_D')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>P<sub>E</sub> (FWH3 / LP bleed)</span><span class="slider-value">{P_E} bar</span></div>
            <input id="r-pe" type="range" min="2" max="8" step="0.1" bind:value={P_E} style="--pct: {pct(P_E,2,8)}%" onchange={() => onPressureChange('P_E')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>P<sub>F</sub> (FWH2 / LP bleed)</span><span class="slider-value">{P_F} bar</span></div>
            <input id="r-pf" type="range" min="1" max="5" step="0.1" bind:value={P_F} style="--pct: {pct(P_F,1,5)}%" onchange={() => onPressureChange('P_F')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>P<sub>G</sub> (FWH1 / LP bleed)</span><span class="slider-value">{P_G} bar</span></div>
            <input id="r-pg" type="range" min="0.5" max="3" step="0.05" bind:value={P_G} style="--pct: {pct(P_G,0.5,3)}%" onchange={() => onPressureChange('P_G')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>FWH terminal temp diff (TTD)</span><span class="slider-value">{TTD} °C</span></div>
            <input id="r-ttd" type="range" min="0" max="15" step="0.5" bind:value={TTD} onchange={onTTDChange} />
          </div>
        </div>
      </details>

      <!-- Isentropic efficiencies (turbine-gray sliders) -->
      <details class="slider-details chamfer-panel chamfer-sm" style="--slider-color: #6b7566">
        <summary class="details-summary">Isentropic efficiencies</summary>
        <div class="slider-body">
          <div class="slider-row">
            <div class="slider-label"><span>η HP turbine</span><span class="slider-value">{(eta_HP*100).toFixed(0)} %</span></div>
            <input id="r-etahp" type="range" min="0.5" max="1" step="0.01" bind:value={eta_HP} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>η IP turbine</span><span class="slider-value">{(eta_IP*100).toFixed(0)} %</span></div>
            <input id="r-etaip" type="range" min="0.5" max="1" step="0.01" bind:value={eta_IP} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>η LP turbine</span><span class="slider-value">{(eta_LP*100).toFixed(0)} %</span></div>
            <input id="r-etalp" type="range" min="0.5" max="1" step="0.01" bind:value={eta_LP} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>η pumps (all)</span><span class="slider-value">{(eta_pump*100).toFixed(0)} %</span></div>
            <input id="r-pump" type="range" min="0.5" max="1" step="0.01" bind:value={eta_pump} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>η generator</span><span class="slider-value">{(eta_gen*100).toFixed(1)} %</span></div>
            <input id="r-gen" type="range" min="0.95" max="1" step="0.001" bind:value={eta_gen} onchange={runSolve} />
          </div>
        </div>
      </details>

      <!-- Cooling / environment (condenser-blue sliders) -->
      <details class="slider-details chamfer-panel chamfer-sm" style="--slider-color: #5ba3e8">
        <summary class="details-summary">Cooling / environment</summary>
        <div class="slider-body">
          <div class="slider-row">
            <div class="slider-label"><span>Ambient temp T₀</span><span class="slider-value">{T0} °C</span></div>
            <input id="r-t0" type="range" min="0" max="40" step="1" bind:value={T0} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>Relative humidity</span><span class="slider-value">{RH} %</span></div>
            <input id="r-rh" type="range" min="10" max="99" step="1" bind:value={RH} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>Cooling tower approach</span><span class="slider-value">{cw_approach} °C</span></div>
            <input id="r-cwa" type="range" min="2" max="15" step="0.1" bind:value={cw_approach} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>CW : steam mass ratio</span><span class="slider-value">{r_cw} : 1</span></div>
            <input id="r-rcw" type="range" min="10" max="70" step="1" bind:value={r_cw} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>Condenser conductance UA</span><span class="slider-value">{UA} MW/K</span></div>
            <input id="r-ua" type="range" min="30" max="200" step="1" bind:value={UA} onchange={runSolve} />
          </div>
          {#if result}
            <p class="cond-helper">
              ε-NTU condenser: NTU {fmt(result.NTU_cond, 2)} · ε {fmt(result.eps_cond, 3)} ·
              range {fmt(result.cond_range, 1)} °C · TTD {fmt(result.cond_TTD_eff, 1)} °C
              (both emergent)
            </p>
          {/if}
        </div>
      </details>

      <!-- State visibility (extraction and drain states) -->
      {#if result}
        <details class="slider-details chamfer-panel chamfer-sm">
          <summary class="details-summary">State visibility</summary>
          <div class="slider-body">
            <p class="selection-hint">
              States 1-15 are always shown. Toggle extraction steam (X1, orange) and
              drain states (X2/X3, blue) below.
            </p>
            <div class="extraction-groups">
              {#each ['A','B','C','D','E','F','G'] as letter}
                {@const keys = Object.keys(showExtraction).filter(k => k.startsWith(letter))}
                <div class="ex-group">
                  <span class="ex-letter">{letter}</span>
                  <div class="ex-checks">
                    {#each keys as key}
                      <label class="sel-item">
                        <input type="checkbox" bind:checked={showExtraction[key]} />
                        <span class="sel-dot" class:sel-dot-drain={!key.endsWith('1')}></span>
                        <span class="sel-label">{result.extractionStatePoints[key]?.[2] ?? key}</span>
                      </label>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        </details>

      {/if}
    </div>

    <!-- ── Right column: T-s diagram + selection panel ──────────────────── -->
    <div class="diagram-col">
      <p class="diagram-title">Temperature-Entropy (T-s) Diagram</p>

      <div class="scope-panel chamfer-panel chamfer-all">
      <svg viewBox="0 0 {SVG_W} {SVG_H}" class="ts-svg" role="img"
           aria-label="T-s diagram of the supercritical reheat regenerative Rankine cycle">

        <!-- Grid -->
        {#each T_TICKS as T}
          <line x1={PL} y1={ty(T)} x2={PL+CW} y2={ty(T)} class="grid-line" />
          <text x={PL-5} y={ty(T)+4} class="axis-tick" text-anchor="end">{T}</text>
        {/each}
        {#each S_TICKS as s}
          <line x1={sx(s)} y1={PT} x2={sx(s)} y2={PT+CH} class="grid-line" />
          <text x={sx(s)} y={PT+CH+14} class="axis-tick" text-anchor="middle">{s}</text>
        {/each}

        <!-- Axis lines -->
        <line x1={PL} y1={PT} x2={PL} y2={PT+CH} class="axis" />
        <line x1={PL} y1={PT+CH} x2={PL+CW} y2={PT+CH} class="axis" />
        <text x={PL-38} y={PT+CH/2} class="axis-label" text-anchor="middle"
              transform={`rotate(-90,${PL-38},${PT+CH/2})`}>T (°C)</text>
        <text x={PL+CW/2} y={SVG_H-2} class="axis-label" text-anchor="middle">s  (kJ / kg·K)</text>

        <!-- Saturation dome -->
        {#if dome}
          <path d={pathD(dome.dome)} class="dome" />
        {/if}

        {#if result}
          {@const r = result}

          <!-- Feedwater train: state 6 through state 15 (v2 numbering) -->
          <path d={pathD(r.fwPath)} class="path-fw" />

          <!-- Steam generator: state 15 to state 1 -->
          <path d={pathD(r.steamGenPath)} class="path-steam-gen" />

          <!-- HP turbine: 1 → B → 2 -->
          <path d={pathD(r.hpPath)} class="path-expand" />

          <!-- Reheater: 2 → 3 -->
          <path d={pathD(r.reheatPath)} class="path-reheat" />

          <!-- IP turbine: 3 → C → D → 4 -->
          <path d={pathD(r.ipPath)} class="path-expand" />

          <!-- LP turbine: 4 → E → F → G → 5 -->
          <path d={pathD(r.lpPath)} class="path-expand" />

          <!-- Condenser: 5 → 6 (isobar traced through CoolProp) -->
          <path d={pathD(r.condenserPath)} class="path-cond" />

          <!-- FWH shell-side paths: desuperheat from extraction point to sat-vapor, then
               horizontal condensation across the dome at constant temperature -->
          {#each r.fwhShellPaths as fp}
            <path d={pathD(fp.desupPath)} class="path-shell" />
            <line x1={sx(fp.sg)} y1={ty(fp.Tsat)} x2={sx(fp.sf)} y2={ty(fp.Tsat)} class="path-shell" />
          {/each}

          <!-- Drain paths: pump compressions (A4-A5, B2-B3, F2-F3) and valve drops (C2-C3, E2-E3, G2-G3) -->
          {#each r.drainPaths as dp}
            <path d={pathD(dp)} class="path-drain" />
          {/each}

          <!-- Main cycle state dots 1-15 (always shown) -->
          {#each Object.entries(r.statePoints as Record<string, [number, number, string]>) as [name, [sp, Tp, tip]]}
            <circle cx={sx(sp)} cy={ty(Tp)} r={4} class="state-pt">
              <title>{tip}</title>
            </circle>
          {/each}

          <!-- Extraction / drain state dots (shown via checkbox panel) -->
          {#each Object.entries(r.extractionStatePoints as Record<string, [number, number, string]>) as [name, [sp, Tp, tip]]}
            {#if showExtraction[name]}
              <circle cx={sx(sp)} cy={ty(Tp)} r={3.5}
                      class={name.endsWith('1') ? 'state-pt-ex' : 'state-pt-drain'}>
                <title>{tip}</title>
              </circle>
            {/if}
          {/each}
        {/if}
      </svg>

      <div class="diagram-legend">
        <span class="leg leg-steam-gen">Steam generator</span>
        <span class="leg leg-reheat">Reheater</span>
        <span class="leg leg-expand">Turbines</span>
        <span class="leg leg-cond">Condenser</span>
        <span class="leg leg-fw">Feedwater</span>
        <span class="leg leg-shell">FWH shells</span>
        <span class="leg leg-drain">Drains</span>
        <span class="leg leg-dome">Sat. dome</span>
      </div>
      </div>

      <!-- Efficiency gauges + indicators -->
      {#if result}
        <div class="gauge-grid">
          <Gauge
            label="1st law efficiency"
            value={g1Val}
            valueText={fmt(g1Val * 100, 2)}
            unit="%"
            accent="#f2ac41"
            accentDim="#c07a10"
          />
          <Gauge
            label="2nd law efficiency"
            value={g2Val}
            valueText={fmt(g2Val * 100, 2)}
            unit="%"
            accent="#35d6b4"
            accentDim="#14b8a6"
          />
          <Gauge
            label="LP exhaust quality"
            value={g3Frac}
            valueText={result.x5 >= 0 ? fmt(result.x5 * 100, 1) : 'S/H'}
            unit={result.x5 >= 0 ? '%' : ''}
            accent={g3Accent}
            accentDim={g3AccentDim}
            warn={g3Warn}
            dangerBelow={0.85}
          />
          <Gauge
            label="Pump power fraction"
            value={g4Raw}
            valueText={fmt(g4Raw * 100, 2)}
            unit="%"
            accent="#b39ef7"
            accentDim="#6d4fb0"
          />
        </div>

        <!-- Key readouts -->
        <div class="readout-grid">
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Net electrical output</p>
            <p class="readout-value readout-value-amber">{fmt(result.W_net / 1e6, 1)} <span class="readout-unit">MW</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Total steam flow</p>
            <p class="readout-value">{fmt(result.m, 1)} <span class="readout-unit">kg/s</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Condenser pressure</p>
            <p class="readout-value">{fmt(result.P6 / 1000, 2)} <span class="readout-unit">kPa</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Condenser temp</p>
            <p class="readout-value">{fmt(result.T6C, 2)} <span class="readout-unit">°C</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Wet-bulb temp</p>
            <p class="readout-value">{fmt(result.T_wb, 2)} <span class="readout-unit">°C</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">CW in → out</p>
            <p class="readout-value">{fmt(result.T_cw_in, 1)}→{fmt(result.T_cw_out, 1)} <span class="readout-unit">°C</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Condenser range</p>
            <p class="readout-value">{fmt(result.cond_range, 2)} <span class="readout-unit">°C</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Condenser TTD</p>
            <p class="readout-value">{fmt(result.cond_TTD_eff, 2)} <span class="readout-unit">°C</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Circulating water flow</p>
            <p class="readout-value">{fmt(result.mdot_cw, 0)} <span class="readout-unit">kg/s</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Turbine work</p>
            <p class="readout-value">{fmt(result.W_turb / 1e6, 1)} <span class="readout-unit">MW</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Exergy to working fluid</p>
            <p class="readout-value">{fmt(result.Ex_sg / 1e6, 1)} <span class="readout-unit">MW</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Heat rejected (condenser)</p>
            <p class="readout-value">{fmt(result.Q_cond / 1e6, 1)} <span class="readout-unit">MW</span></p>
          </div>
        </div>

        <!-- Extraction fractions -->
        <div class="extraction-wrap chamfer-panel">
          <p class="group-label" style="margin-bottom:5px">Extraction fractions</p>
          <table class="extraction-table">
            <thead><tr><th>Bleed</th><th>kg/s</th><th>% of ṁ</th></tr></thead>
            <tbody>
              {#each ['a','b','c','d','e','f','g'] as key}
                <tr>
                  <td class="bleed-key">{key}</td>
                  <td>{fmt(result[key], 2)}</td>
                  <td>{fmt(100 * result[key] / result.m, 2)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .rankine-wrap {
    display: grid;
    grid-template-columns: minmax(0, 400px) minmax(0, 1fr);
    gap: 32px;
    align-items: start;
    width: 100%;
    font-family: var(--font-display);
  }
  @media (max-width: 800px) { .rankine-wrap { grid-template-columns: 1fr; } }

  /* Loading / error */
  .loading-state {
    grid-column: 1 / -1;
    display: flex; flex-direction: column; align-items: center;
    gap: 16px; padding: 60px 0; color: var(--ink-dim); font-size: 15px;
  }
  .loading-spinner {
    width: 32px; height: 32px;
    border: 3px solid var(--steel-800); border-top-color: var(--teal-dim);
    border-radius: 50%; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* Both use the smooth stainless-steel photo instead of the brushed
     aluminum grain: these are small, text-carrying chips, and the brushed
     photo's grain/contrast was competing with the message instead of
     sitting quietly behind it. */
  .error-banner {
    grid-column: 1 / -1; padding: 12px 16px; color: var(--red-dim); font-size: 14px;
  }
  .error-banner::before { background-image: linear-gradient(165deg, var(--steel-650), var(--steel-800) 72%), var(--stainless); }
  /* Fixed as a toast (not inline in controls-col) so it's visible regardless of
     where the page is scrolled when an auto-clamp fires. */
  .order-warning {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    max-width: min(90vw, 560px);
    max-height: min(50vh, 260px);
    overflow-y: auto;
    padding: 14px 18px; color: var(--amber-dim); font-size: 15px; font-weight: 700;
    line-height: 1.4;
    z-index: 100;
    animation: order-warning-in 0.3s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .order-warning::before { background-image: linear-gradient(165deg, var(--steel-650), var(--steel-800) 72%), var(--stainless); }
  @keyframes order-warning-in {
    from { opacity: 0; transform: translateX(-50%) translateY(14px); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0); }
  }

  /* Gauges */
  .gauge-grid {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 14px;
  }
  @media (max-width: 700px) {
    .gauge-grid { grid-template-columns: repeat(2, 1fr); }
  }

  /* Accordion slider groups - each a standalone chamfered instrument plate */
  .slider-details {
    margin-bottom: 12px;
  }
  .details-summary {
    font-family: var(--font-display);
    font-size: 12px; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--ink);
    padding: 9px 12px; margin: 0;
    cursor: pointer; user-select: none; transition: color 0.15s;
    list-style: none; display: flex; justify-content: space-between; align-items: center;
  }
  .details-summary::before {
    content: '';
    display: inline-block;
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--slider-color, #8d9686);
    box-shadow: 0 0 5px 1px var(--slider-color, transparent);
    margin-right: 8px;
  }
  .details-summary:hover { color: var(--paper); }
  .details-summary::-webkit-details-marker { display: none; }
  .details-summary::after {
    content: ''; width: 0; height: 0; flex-shrink: 0;
    border-style: solid;
    border-width: 5px 0 5px 7px;
    border-color: transparent transparent transparent var(--slider-color, #8d9686);
    transition: transform 0.15s ease;
  }
  .slider-details[open] > .details-summary::after { transform: rotate(90deg); }
  .slider-body { padding: 2px 12px 14px; }

  /* Emergent condenser metrics helper line under the cooling sliders */
  .cond-helper {
    font-family: var(--font-mono);
    font-size: 11px; color: var(--blue); line-height: 1.4; margin: 8px 0 0;
    padding: 7px 9px; background: rgba(111, 178, 238, 0.07); border: 1px solid rgba(111, 178, 238, 0.25); border-radius: 3px;
  }

  /* Shared label style (used by group-label elsewhere) */
  .group-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.07em;
    text-transform: uppercase; color: var(--ink-dim); margin: 0 0 8px;
  }
  .slider-row { margin-bottom: 11px; }
  .slider-label {
    display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 3px;
  }
  .slider-label span:first-child { font-size: 13px; color: var(--ink); }
  .slider-value {
    font-size: 13px; font-weight: 400; color: var(--paper);
    font-variant-numeric: tabular-nums; min-width: 56px; text-align: right;
  }

  /* Readout cards */
  .readout-grid {
    display: grid; grid-template-columns: repeat(4, 1fr);
    gap: 8px; margin-top: 14px; margin-bottom: 16px;
  }
  @media (max-width: 480px) {
    .readout-grid { grid-template-columns: repeat(2, 1fr); }
  }
  .readout-card {
    padding: 8px 10px;
  }
  .readout-label {
    font-size: 10px; font-weight: 600; letter-spacing: 0.04em; line-height: 1.25;
    color: var(--ink-dim); text-transform: uppercase; margin: 0 0 4px;
  }
  .readout-value {
    font-size: 16px; font-weight: 400; color: var(--paper);
    margin: 0; font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .readout-value-amber { color: var(--amber-dim); }
  .readout-unit { font-family: var(--font-display); font-size: 11px; font-weight: 500; color: var(--ink-dim); }

  /* Extraction table */
  .extraction-wrap { margin-bottom: 12px; padding: 12px 14px; }
  .extraction-table {
    width: 100%; border-collapse: collapse; font-size: 13px; color: var(--paper);
  }
  .extraction-table th {
    font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
    text-transform: uppercase; color: var(--ink-dim);
    text-align: left; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--steel-900);
  }
  .extraction-table td {
    font-family: var(--font-mono);
    padding: 4px 8px 4px 0; font-variant-numeric: tabular-nums;
    border-bottom: 1px solid var(--steel-800); color: var(--ink);
  }
  .bleed-key { font-weight: 700; color: var(--amber-dim); }

  /* Diagram */
  .diagram-col { position: sticky; top: 16px; }
  .diagram-title {
    font-size: 12px; font-weight: 700; color: var(--ink-dim);
    text-transform: uppercase; letter-spacing: 0.07em; margin: 0 0 8px;
  }
  .scope-panel { padding: 14px; }
  .ts-svg { width: 100%; height: auto; display: block; overflow: visible; }

  /* SVG classes */
  .axis      { stroke: var(--steel-900); stroke-width: 1; }
  .grid-line { stroke: rgba(0, 0, 0, 0.08); stroke-width: 1; }
  .axis-tick  { font-family: var(--font-mono); font-size: 11px; fill: var(--ink-dim); }
  .axis-label { font-family: var(--font-display); font-size: 12px; fill: var(--ink-dim); }

  .dome      { fill: none; stroke: var(--teal-dim); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; filter: drop-shadow(0 0 2px rgba(20, 184, 166, 0.3)); }

  .path-steam-gen { fill: none; stroke: #e8935f; stroke-width: 2.5; }
  .path-reheat  { fill: none; stroke: var(--amber); stroke-width: 2.5; }
  .path-expand  { fill: none; stroke: var(--ink); stroke-width: 2; }
  .path-cond    { fill: none; stroke: var(--blue); stroke-width: 2; }
  .path-fw      { fill: none; stroke: var(--teal-dim); stroke-width: 2; stroke-dasharray: 5 3; }
  .path-shell   { fill: none; stroke: #7ba8cc; stroke-width: 2; }
  .path-drain   { fill: none; stroke: var(--amber-dim); stroke-width: 1.5; stroke-dasharray: 4 2; }

  .state-pt       { fill: var(--paper); stroke: #000; stroke-width: 0.5; cursor: default; }
  .state-pt-ex    { fill: var(--amber); stroke: #000; stroke-width: 0.5; cursor: default; }
  .state-pt-drain { fill: var(--blue); stroke: #000; stroke-width: 0.5; cursor: default; }

  /* State visibility accordion content */
  .selection-hint {
    font-size: 11.5px; color: var(--ink-dim); margin: 0 0 10px; line-height: 1.45;
  }
  .extraction-groups { display: flex; flex-direction: column; gap: 8px; }
  .ex-group { display: flex; align-items: flex-start; gap: 8px; }
  .ex-letter {
    font-family: var(--font-mono);
    font-size: 12px; font-weight: 700; color: var(--ink);
    min-width: 14px; padding-top: 1px; flex-shrink: 0;
  }
  .ex-checks { display: flex; flex-direction: column; gap: 4px; flex: 1; }
  .sel-item {
    display: flex; align-items: flex-start; gap: 6px;
    cursor: pointer; font-size: 12px; color: var(--ink); line-height: 1.35;
  }
  .sel-item input[type="checkbox"] {
    margin-top: 2px; accent-color: var(--blue); flex-shrink: 0; cursor: pointer;
  }
  .sel-dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: var(--amber); border: 1px solid #000; flex-shrink: 0; margin-top: 3px;
  }
  .sel-dot-drain { background: var(--blue); }
  .sel-label { flex: 1; }

  /* Legend */
  .diagram-legend { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 9px; }
  .leg {
    font-size: 12px; color: var(--ink-dim);
    display: flex; align-items: center; gap: 5px;
  }
  .leg::before { content: ''; display: inline-block; width: 18px; height: 2px; }
  .leg-steam-gen::before { background: #e8935f; }
  .leg-reheat::before { background: var(--amber); }
  .leg-expand::before { background: var(--ink); }
  .leg-cond::before   { background: var(--blue); }
  .leg-fw::before     { background: var(--teal-dim); }
  .leg-shell::before  { background: #7ba8cc; }
  .leg-drain::before  { background: var(--amber-dim); }
  .leg-dome::before   { background: var(--teal-dim); }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }

  /* Page title with reactive supercritical strikethrough */
  .page-title {
    font-family: var(--font-display);
    font-size: 24px; font-weight: 700; color: var(--paper);
    letter-spacing: 0.02em;
    margin: 0 0 16px; line-height: 1.3;
  }

  /* One-click way back to a known-good cycle after e.g. dragging efficiencies to
     unrealistic extremes - same chamfered-metal chrome as every other panel, but sized
     and colored (teal on hover, matching the nav's current-page/click glow) like a button. */
  .reset-btn {
    margin-bottom: 16px;
    padding: 8px 16px;
    font-family: var(--font-display);
    font-size: 0.85rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    color: var(--ink);
    cursor: pointer;
    border: none;
    transition: color 0.15s ease, transform 0.15s ease, filter 0.15s ease;
  }
  .reset-btn:hover {
    color: var(--teal-dim);
    filter: brightness(1.08);
  }
  .reset-btn:active {
    transform: translateY(1px);
    filter: brightness(0.94);
    text-shadow: 0 0 8px var(--teal);
  }
  .title-super {
    transition: text-decoration 0.2s, opacity 0.2s, color 0.2s;
  }
  .title-super.struck {
    text-decoration: line-through; opacity: 0.4; color: var(--ink-dim);
  }
</style>