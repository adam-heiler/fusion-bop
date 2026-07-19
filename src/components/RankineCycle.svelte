<script lang="ts">
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { initSolver, solveCycleAsync, minPCAsync, minPGAsync, maxPEAsync } from '../lib/solverWorkerClient.js';
  import Gauge from './Gauge.svelte';

  // Slider defaults, also used by the Reset button below. Pressures: MPa for
  // the high-pressure sliders (P1/P_VA/P_B/P2), kPa for the rest. Temperatures
  // in °C - the convention thermo water tables use.
  const DEFAULTS = {
    P1: 25, T1: 540, T3: 500, P2: 6, P4: 500, reheat_dP_pct: 3,
    P_VA: 11.7, P_B: 10, P_C: 750, P_D: 600, P_E: 430, P_F: 220, P_G: 150,
    P_condpump: 650,
    Q: 1000,
    eta_HP: 0.85, eta_IP: 0.85, eta_LP: 0.85, eta_pump: 0.85, eta_gen: 0.985,
    TTD: 2.8, T0: 25, RH: 50, cw_approach: 3.1,
    // r_cw = circulating-water : steam mass ratio; UA = condenser conductance (MW/K)
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
  let P_condpump    = $state(DEFAULTS.P_condpump);
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

  // Pa/K directly - these are solver-only constants, never shown as sliders.
  const FIXED = {
    P_feedpump: 25e6, subcool: 2.8,
  };

  const PCRIT = 22.064; // MPa
  const isSupercritical = $derived(P1 >= PCRIT);

  // Pressure ordering enforcement. Required chain: P1 > P_VA > P_B > P2 > P_C >
  // P_D > P4 > P_E > P_F > P_G. See NOTES.md for why.
  const GAP = 1e4; // Pa (10 kPa), minimum enforced separation between chain neighbors

  let orderWarning = $state('');
  let warnTimeout: ReturnType<typeof setTimeout> | null = null;

  function flagOrder(msg: string) {
    orderWarning = msg;
    if (warnTimeout) clearTimeout(warnTimeout);
    warnTimeout = setTimeout(() => { orderWarning = ''; }, 7000);
  }

  // 'P_VA' -> 'P<sub>VA</sub>', 'P1' -> 'P<sub>1</sub>'
  function subLabel(name: string): string {
    const m = name.match(/^P_?(.+)$/);
    return m ? `P<sub>${m[1]}</sub>` : name;
  }

  // Minimum P_C keeping FWH4's extraction fraction non-negative. P_C is kPa
  // in component state; the solver wants Pa.
  async function minPC(): Promise<number> {
    const pa = await minPCAsync(P_D * 1e3, TTD, eta_pump);
    return pa / 1e3;
  }

  // Minimum P_G keeping FWH1's extraction fraction non-negative. Depends on
  // the condensate pump's discharge pressure (P_condpump), since that's the
  // pressure FWH1's tube side is compressed to.
  async function minPG(): Promise<number> {
    const T6C_est = result ? result.T6C : (25 + cw_approach + 13);
    const pa = await minPGAsync(T6C_est, TTD, eta_pump, P_condpump * 1e3);
    return pa / 1e3;
  }

  // Maximum P_E before FWH3's feedwater outlet (at P_condpump) flashes to vapor.
  async function maxPE(): Promise<number> {
    const pa = await maxPEAsync(TTD, P_condpump * 1e3);
    return pa / 1e3;
  }

  // Chain get/set always operate in Pascals internally, regardless of which
  // unit (MPa or kPa) a given slider displays - the ordering comparisons
  // would otherwise be comparing across two different units. Rounding
  // happens inside each setter, after converting back to the slider's own
  // display unit (rounding the raw Pascal value first would be meaningless -
  // 3 decimal places of a multi-million-Pascal number is far finer than the
  // slider's own precision).
  type Chain = [string, () => number, (v: number) => void, number, number][];
  function getChain(): Chain {
    return [
      ['P1',   () => P1*1e6,   v => P1 = snap(v/1e6),   3e6,   30e6],
      ['P_VA', () => P_VA*1e6, v => P_VA = snap(v/1e6), 6e6,   20e6],
      ['P_B',  () => P_B*1e6,  v => P_B = snap(v/1e6),  5e6,   15e6],
      ['P2',   () => P2*1e6,   v => P2 = snap(v/1e6),   3e6,   10e6],
      ['P_C',  () => P_C*1e3,  v => P_C = snap(v/1e3),  4e5,   15e5],
      ['P_D',  () => P_D*1e3,  v => P_D = snap(v/1e3),  3e5,   12e5],
      ['P4',   () => P4*1e3,   v => P4 = snap(v/1e3),   2e5,   20e5],
      ['P_E',  () => P_E*1e3,  v => P_E = snap(v/1e3),  2e5,   8e5],
      ['P_F',  () => P_F*1e3,  v => P_F = snap(v/1e3),  1e5,   5e5],
      ['P_G',  () => P_G*1e3,  v => P_G = snap(v/1e3),  0.5e5, 3e5],
    ];
  }
  const snap = (v: number) => +v.toFixed(3);

  // Clamps the TTD-aware boundaries (P_C, P_G, P_E); returns a reason per boundary that fired.
  async function enforceTTDBoundaries(): Promise<string[]> {
    const chain = getChain();
    const reasons: string[] = [];

    const pcMin = await minPC();
    if (pcMin > 0 && P_C < pcMin) {
      P_C = snap(pcMin);
      reasons.push(`${subLabel('P_C')} (FWH4) raised to ${P_C} kPa - any lower and the deaerator would already be hotter than FWH4 could deliver, forcing its extraction flow negative.`);
      for (let i = chain.findIndex(([n]) => n === 'P_C') - 1; i >= 0; i--) {
        const [, get, set, lo, hi] = chain[i];
        const [, getBelow] = chain[i + 1];
        if (get() <= getBelow() + GAP) set(snap(Math.min(hi, Math.max(lo, getBelow() + GAP))));
      }
    }
    const pgMin = await minPG();
    if (pgMin > 0 && P_G < pgMin) {
      P_G = snap(pgMin);
      reasons.push(`${subLabel('P_G')} (FWH1) raised to ${P_G} kPa - any lower and the condenser would already be hotter than FWH1 could deliver, forcing its extraction flow negative.`);
      for (let i = chain.findIndex(([n]) => n === 'P_G') - 1; i >= chain.findIndex(([n]) => n === 'P4'); i--) {
        const [, get, set, lo, hi] = chain[i];
        const [, getBelow] = chain[i + 1];
        if (get() <= getBelow() + GAP) set(snap(Math.min(hi, Math.max(lo, getBelow() + GAP))));
      }
    }
    const peMax = await maxPE();
    if (peMax > 0 && P_E > peMax) {
      // Chain bounds/GAP are Pascal-scale; peMax came back in kPa (P_E's own
      // unit) from the wrapper above, so convert peLo/GAP to kPa here too.
      const [, , , peLo] = chain[chain.findIndex(([n]) => n === 'P_E')];
      P_E = snap(Math.max(peLo / 1e3, peMax - GAP / 1e3));
      reasons.push(`${subLabel('P_E')} (FWH3) lowered to ${P_E} kPa - above this, the shell steam is hotter than the condensate line pressure can keep liquid, so the feedwater would flash to vapor inside the FWH3 tubes.`);
      for (let i = chain.findIndex(([n]) => n === 'P_E') + 1; i < chain.length; i++) {
        const [, get, set, lo, hi] = chain[i];
        const [, getAbove] = chain[i - 1];
        if (get() >= getAbove() - GAP) set(snap(Math.min(hi, Math.max(lo, getAbove() - GAP))));
      }
    }

    // Condensate (at P_condpump) mixes directly into the deaerator (at P_D) with
    // no pump modeled in between - it has to already be at or above deaerator
    // pressure, or it couldn't physically flow in. Unlike the P_C/P_G/P_E
    // checks above, this isn't a thermodynamic-property lookup, just a plain
    // pressure comparison, so no async solver call is needed.
    const pcondMin = P_D + GAP / 1e3;
    if (P_condpump < pcondMin) {
      P_condpump = snap(pcondMin);
      reasons.push(`Condensate pump discharge P raised to ${P_condpump} kPa - any lower and the condensate couldn't physically flow into the deaerator, which sits at a higher pressure (P<sub>D</sub>).`);
    }

    return reasons;
  }

  // Walks the chain from the moved slider, pushing neighbors just enough to
  // restore ordering, clamped to each slider's own [min, max].
  async function enforceOrder(changed: string) {
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

    const ttdReasons = await enforceTTDBoundaries();

    if (clamped || ttdReasons.length) {
      const msgs = clamped
        ? [`Adjacent pressure(s) shifted to keep ${subLabel(changed)} thermodynamically valid (each stage must heat the feedwater above what the previous stage already delivered).`]
        : [];
      flagOrder(msgs.concat(ttdReasons).join(' '));
    }
  }

  // Converts component state (MPa/kPa) to the solver's Pa/degC contract -
  // T1/T3/T0 pass straight through since the solver takes °C directly.
  function params() {
    return {
      P1: P1 * 1e6, T1, T3, P2: P2 * 1e6, P4: P4 * 1e3, reheat_dP_pct,
      P_VA: P_VA * 1e6,
      P_B: P_B * 1e6, P_C: P_C * 1e3, P_D: P_D * 1e3,
      P_E: P_E * 1e3, P_F: P_F * 1e3, P_G: P_G * 1e3,
      P_condpump: P_condpump * 1e3, Q,
      eta_HP, eta_IP, eta_LP, eta_pump, eta_gen, TTD,
      T0, RH, cw_approach, r_cw, UA: UA * 1e6,   // UA slider is MW/K -> W/K for the solver
      ...FIXED,
    };
  }

  // Accordion open/closed state, one entry per slider group
  let openSections: Record<string, boolean> = $state({
    steam: true, extraction: true, efficiencies: true, cooling: true, stateVis: true,
  });
  // Chevron points: right-pointing when closed, down-pointing when open.
  function chevronPoints(open: boolean) {
    return open ? '2,3 5,7 8,3' : '3,2 7,5 3,8';
  }

  // Extraction/drain state visibility toggles (X1/X2/X3, see NOTES.md)
  let showExtraction: Record<string, boolean> = $state({
    A1: true, A2: true, A3: true, A4: true, A5: true,
    B1: true, B2: true, B3: true,
    C1: true, C2: true, C3: true,
    D1: true,
    E1: true, E2: true, E3: true,
    F1: true, F2: true, F3: true,
    G1: true, G2: true, G3: true,
  });

  // App state
  let loading = $state(true);
  let dome    = $state<any>(null);
  let result  = $state<any>(null);
  let errMsg  = $state<string | null>(null);

  // Solves off the main thread via the Worker (solverWorkerClient.js).
  async function runSolve() {
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

  // TTD moves the P_C/P_G/P_E boundaries even without a pressure-slider edit.
  async function onTTDChange() {
    const reasons = await enforceTTDBoundaries();
    if (reasons.length) flagOrder(reasons.join(' '));
    runSolve();
  }

  // Condensate pump discharge pressure moves the same P_G (min) and P_E (max)
  // boundaries TTD does, since both minPG and maxPE are functions of it.
  async function onCondPumpChange() {
    const reasons = await enforceTTDBoundaries();
    if (reasons.length) flagOrder(reasons.join(' '));
    runSolve();
  }

  // Restores every slider to DEFAULTS.
  function resetAll() {
    P1 = DEFAULTS.P1; T1 = DEFAULTS.T1; T3 = DEFAULTS.T3; P2 = DEFAULTS.P2; P4 = DEFAULTS.P4;
    reheat_dP_pct = DEFAULTS.reheat_dP_pct;
    P_VA = DEFAULTS.P_VA; P_B = DEFAULTS.P_B; P_C = DEFAULTS.P_C; P_D = DEFAULTS.P_D;
    P_E = DEFAULTS.P_E; P_F = DEFAULTS.P_F; P_G = DEFAULTS.P_G;
    P_condpump = DEFAULTS.P_condpump;
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

  // Gauge values (geometry lives in Gauge.svelte)
  const g1Val = $derived(result ? result.eta_1 : 0);
  const g2Val = $derived(result ? Math.min(result.eta_2, 1) : 0);

  // x5 < 0 is CoolProp's superheated sentinel; treat as a full/best-case reading.
  const g3Frac   = $derived(result ? (result.x5 >= 0 ? result.x5 : 1) : 0);
  const g3Warn   = $derived(!!result && result.x5 >= 0 && result.x5 < 0.85);
  const g3Accent    = $derived(g3Warn ? '#ff6459' : '#6fb2ee');
  const g3AccentDim = $derived(g3Warn ? '#c0392b' : '#2f6fa8');

  const g4Raw    = $derived(result ? result.W_pumps / result.W_turb : 0);

  // High condenser back-pressure (loss of vacuum) - 15 kPa is well above the ~5-10 kPa
  // design range and roughly matches typical plant "high back pressure" alarm setpoints.
  const condWarn = $derived(!!result && result.P6 / 1000 > 15);

  // T-s diagram geometry
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

  // Slider track-fill percentage, clamped to [0,100].
  function pct(v: number, min: number, max: number) {
    return Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100));
  }

</script>

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
    <div class="controls-col">

      {#if orderWarning}
        <div class="order-warning chamfer-panel chamfer-sm"><span>{@html orderWarning}</span></div>
      {/if}

      <div class="slider-details chamfer-panel chamfer-sm" class:slider-open={openSections.steam} style="--slider-color: #e8935f; --slider-tint: rgba(232, 147, 95, 0.2); --slider-glow-1: rgba(232, 147, 95, 0.55); --slider-glow-2: rgba(232, 147, 95, 0.85)">
        <button type="button" class="details-summary" aria-expanded={openSections.steam} onclick={() => openSections.steam = !openSections.steam}>
          Steam conditions
          <svg class="chevron" viewBox="0 0 10 10" width="10" height="10">
            <polyline points={chevronPoints(openSections.steam)} class="chevron-bg" />
            <polyline points={chevronPoints(openSections.steam)} class="chevron-fg" />
          </svg>
        </button>
        {#if openSections.steam}
        <div class="slider-body" transition:slide={{ duration: 200 }}>
          <div class="slider-row">
            <div class="slider-label"><span>Steam generator outlet P₁</span><span class="slider-value">{P1} MPa</span></div>
            <input id="r-p1" type="range" min="3" max="30" step="0.1" bind:value={P1} style="--pct: {pct(P1,3,30)}%" onchange={() => onPressureChange('P1')} />
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
            <div class="slider-label"><span>HP exhaust P₂</span><span class="slider-value">{P2} MPa</span></div>
            <input id="r-p2" type="range" min="3" max="10" step="0.1" bind:value={P2} style="--pct: {pct(P2,3,10)}%" onchange={() => onPressureChange('P2')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>IP exhaust P₄</span><span class="slider-value">{P4} kPa</span></div>
            <input id="r-p4" type="range" min="200" max="2000" step="50" bind:value={P4} style="--pct: {pct(P4,200,2000)}%" onchange={() => onPressureChange('P4')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>Reheat ΔP</span><span class="slider-value">{reheat_dP_pct} %</span></div>
            <input id="r-rdp" type="range" min="0" max="8" step="0.5" bind:value={reheat_dP_pct} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>FWH6 shell P (Valve A)</span><span class="slider-value">{P_VA} MPa</span></div>
            <input id="r-pva" type="range" min="6" max="20" step="0.1" bind:value={P_VA} style="--pct: {pct(P_VA,6,20)}%" onchange={() => onPressureChange('P_VA')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>Steam generator duty Q</span><span class="slider-value">{Q} MW</span></div>
            <input id="r-q" type="range" min="200" max="2000" step="50" bind:value={Q} onchange={runSolve} />
          </div>
        </div>
        {/if}
      </div>

      <div class="slider-details chamfer-panel chamfer-sm" class:slider-open={openSections.extraction} style="--slider-color: #1a9b73; --slider-tint: rgba(26, 155, 115, 0.2); --slider-glow-1: rgba(26, 155, 115, 0.55); --slider-glow-2: rgba(26, 155, 115, 0.85)">
        <button type="button" class="details-summary" aria-expanded={openSections.extraction} onclick={() => openSections.extraction = !openSections.extraction}>
          Extraction pressures and feedwater heating
          <svg class="chevron" viewBox="0 0 10 10" width="10" height="10">
            <polyline points={chevronPoints(openSections.extraction)} class="chevron-bg" />
            <polyline points={chevronPoints(openSections.extraction)} class="chevron-fg" />
          </svg>
        </button>
        {#if openSections.extraction}
        <div class="slider-body" transition:slide={{ duration: 200 }}>
          <div class="slider-row">
            <div class="slider-label"><span>P<sub>B</sub> (FWH5 / HP bleed)</span><span class="slider-value">{P_B} MPa</span></div>
            <input id="r-pb" type="range" min="5" max="15" step="0.1" bind:value={P_B} style="--pct: {pct(P_B,5,15)}%" onchange={() => onPressureChange('P_B')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>P<sub>C</sub> (FWH4 / IP bleed)</span><span class="slider-value">{P_C} kPa</span></div>
            <input id="r-pc" type="range" min="400" max="1500" step="10" bind:value={P_C} style="--pct: {pct(P_C,400,1500)}%" onchange={() => onPressureChange('P_C')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>P<sub>D</sub> (Deaerator / IP bleed)</span><span class="slider-value">{P_D} kPa</span></div>
            <input id="r-pd" type="range" min="300" max="1200" step="10" bind:value={P_D} style="--pct: {pct(P_D,300,1200)}%" onchange={() => onPressureChange('P_D')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>P<sub>E</sub> (FWH3 / LP bleed)</span><span class="slider-value">{P_E} kPa</span></div>
            <input id="r-pe" type="range" min="200" max="800" step="10" bind:value={P_E} style="--pct: {pct(P_E,200,800)}%" onchange={() => onPressureChange('P_E')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>P<sub>F</sub> (FWH2 / LP bleed)</span><span class="slider-value">{P_F} kPa</span></div>
            <input id="r-pf" type="range" min="100" max="500" step="10" bind:value={P_F} style="--pct: {pct(P_F,100,500)}%" onchange={() => onPressureChange('P_F')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>P<sub>G</sub> (FWH1 / LP bleed)</span><span class="slider-value">{P_G} kPa</span></div>
            <input id="r-pg" type="range" min="50" max="300" step="5" bind:value={P_G} style="--pct: {pct(P_G,50,300)}%" onchange={() => onPressureChange('P_G')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>FWH terminal temp diff (TTD)</span><span class="slider-value">{TTD} °C</span></div>
            <input id="r-ttd" type="range" min="0" max="15" step="0.5" bind:value={TTD} onchange={onTTDChange} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>Condensate pump discharge P</span><span class="slider-value">{P_condpump} kPa</span></div>
            <input id="r-pcondpump" type="range" min="200" max="1300" step="10" bind:value={P_condpump} style="--pct: {pct(P_condpump,200,1300)}%" onchange={onCondPumpChange} />
          </div>
        </div>
        {/if}
      </div>

      <div class="slider-details chamfer-panel chamfer-sm" class:slider-open={openSections.efficiencies} style="--slider-color: #a06cd5; --slider-tint: rgba(160, 108, 213, 0.2); --slider-glow-1: rgba(160, 108, 213, 0.55); --slider-glow-2: rgba(160, 108, 213, 0.85)">
        <button type="button" class="details-summary" aria-expanded={openSections.efficiencies} onclick={() => openSections.efficiencies = !openSections.efficiencies}>
          Isentropic efficiencies
          <svg class="chevron" viewBox="0 0 10 10" width="10" height="10">
            <polyline points={chevronPoints(openSections.efficiencies)} class="chevron-bg" />
            <polyline points={chevronPoints(openSections.efficiencies)} class="chevron-fg" />
          </svg>
        </button>
        {#if openSections.efficiencies}
        <div class="slider-body" transition:slide={{ duration: 200 }}>
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
        {/if}
      </div>

      <div class="slider-details chamfer-panel chamfer-sm" class:slider-open={openSections.cooling} style="--slider-color: #5ba3e8; --slider-tint: rgba(91, 163, 232, 0.2); --slider-glow-1: rgba(91, 163, 232, 0.55); --slider-glow-2: rgba(91, 163, 232, 0.85)">
        <button type="button" class="details-summary" aria-expanded={openSections.cooling} onclick={() => openSections.cooling = !openSections.cooling}>
          Cooling / environment
          <svg class="chevron" viewBox="0 0 10 10" width="10" height="10">
            <polyline points={chevronPoints(openSections.cooling)} class="chevron-bg" />
            <polyline points={chevronPoints(openSections.cooling)} class="chevron-fg" />
          </svg>
        </button>
        {#if openSections.cooling}
        <div class="slider-body" transition:slide={{ duration: 200 }}>
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
        {/if}
      </div>

      {#if result}
        <div class="slider-details chamfer-panel chamfer-sm" class:slider-open={openSections.stateVis} style="--slider-color: #d9b829; --slider-tint: rgba(217, 184, 41, 0.2); --slider-glow-1: rgba(217, 184, 41, 0.55); --slider-glow-2: rgba(217, 184, 41, 0.85)">
          <button type="button" class="details-summary" aria-expanded={openSections.stateVis} onclick={() => openSections.stateVis = !openSections.stateVis}>
            State visibility
            <svg class="chevron" viewBox="0 0 10 10" width="10" height="10">
              <polyline points={chevronPoints(openSections.stateVis)} class="chevron-bg" />
              <polyline points={chevronPoints(openSections.stateVis)} class="chevron-fg" />
            </svg>
          </button>
          {#if openSections.stateVis}
          <div class="slider-body" transition:slide={{ duration: 200 }}>
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
                        <span class="sel-dot" class:sel-dot-drain={!key.endsWith('1')} class:sel-dot-off={!showExtraction[key]}></span>
                        <span class="sel-label">{result.extractionStatePoints[key]?.[2] ?? key}</span>
                      </label>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          </div>
          {/if}
        </div>

      {/if}
    </div>

    <div class="diagram-col">
      <p class="diagram-title">Temperature-Entropy (T-s) Diagram</p>

      <div class="scope-panel chamfer-panel chamfer-all">
      <svg viewBox="0 0 {SVG_W} {SVG_H}" class="ts-svg" role="img"
           aria-label="T-s diagram of the supercritical reheat regenerative Rankine cycle">

        {#each T_TICKS as T}
          <line x1={PL} y1={ty(T)} x2={PL+CW} y2={ty(T)} class="grid-line" />
          <text x={PL-5} y={ty(T)+4} class="axis-tick" text-anchor="end">{T}</text>
        {/each}
        {#each S_TICKS as s}
          <line x1={sx(s)} y1={PT} x2={sx(s)} y2={PT+CH} class="grid-line" />
          <text x={sx(s)} y={PT+CH+14} class="axis-tick" text-anchor="middle">{s}</text>
        {/each}

        <line x1={PL} y1={PT} x2={PL} y2={PT+CH} class="axis" />
        <line x1={PL} y1={PT+CH} x2={PL+CW} y2={PT+CH} class="axis" />
        <text x={PL-38} y={PT+CH/2} class="axis-label" text-anchor="middle"
              transform={`rotate(-90,${PL-38},${PT+CH/2})`}>T (°C)</text>
        <text x={PL+CW/2} y={SVG_H-2} class="axis-label" text-anchor="middle">s  (kJ / kg·K)</text>

        {#if dome}
          <path d={pathD(dome.dome)} class="dome" />
        {/if}

        {#if result}
          {@const r = result}

          <path d={pathD(r.fwPath)} class="path-fw" />

          <path d={pathD(r.steamGenPath)} class="path-steam-gen" />

          <path d={pathD(r.hpPath)} class="path-expand" />

          <path d={pathD(r.reheatPath)} class="path-reheat" />

          <path d={pathD(r.ipPath)} class="path-expand" />

          <path d={pathD(r.lpPath)} class="path-expand" />

          <path d={pathD(r.condenserPath)} class="path-cond" />

          {#each r.fwhShellPaths as fp}
            <path d={pathD(fp.desupPath)} class="path-shell" />
            <line x1={sx(fp.sg)} y1={ty(fp.Tsat)} x2={sx(fp.sf)} y2={ty(fp.Tsat)} class="path-shell" />
          {/each}

          {#each r.drainPaths as dp}
            <path d={pathD(dp)} class="path-drain" />
          {/each}

          {#each Object.entries(r.statePoints as Record<string, [number, number, string]>) as [name, [sp, Tp, tip]]}
            <circle cx={sx(sp)} cy={ty(Tp)} r={4} class="state-pt">
              <title>{tip}</title>
            </circle>
          {/each}

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

        <div class="readout-grid">
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Net electrical output</p>
            <p class="readout-value readout-value-amber">{fmt(result.W_net / 1e6, 1)} <span class="readout-unit">MW</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Turbine work</p>
            <p class="readout-value">{fmt(result.W_turb / 1e6, 1)} <span class="readout-unit">MW</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Feedwater pump power</p>
            <p class="readout-value">{fmt(result.W_fwp / 1e6, 2)} <span class="readout-unit">MW</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Condensate pump power</p>
            <p class="readout-value">{fmt(result.W_condpump / 1e6, 2)} <span class="readout-unit">MW</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Circulating pump power</p>
            <p class="readout-value">{fmt(result.W_cwpump / 1e6, 2)} <span class="readout-unit">MW</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Exergy to working fluid</p>
            <p class="readout-value">{fmt(result.Ex_sg / 1e6, 1)} <span class="readout-unit">MW</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Total steam flow</p>
            <p class="readout-value">{fmt(result.m, 1)} <span class="readout-unit">kg/s</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Circulating water flow</p>
            <p class="readout-value">{fmt(result.mdot_cw, 0)} <span class="readout-unit">kg/s</span></p>
          </div>
          <div class="readout-outer" class:readout-alarm={condWarn}>
            <div class="readout-card chamfer-panel chamfer-sm">
              <p class="readout-label">Condenser pressure</p>
              <p class="readout-value" class:readout-value-alarm={condWarn}>{fmt(result.P6 / 1000, 2)} <span class="readout-unit">kPa</span></p>
            </div>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Condenser TTD</p>
            <p class="readout-value">{fmt(result.cond_TTD_eff, 2)} <span class="readout-unit">°C</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Hotwell temperature</p>
            <p class="readout-value">{fmt(result.T6C, 2)} <span class="readout-unit">°C</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Cooling tower basin temp</p>
            <p class="readout-value">{fmt(result.T_cw_in, 2)} <span class="readout-unit">°C</span></p>
          </div>
        </div>

        <div class="state-wrap chamfer-panel">
          <p class="group-label" style="margin-bottom:5px">Cycle state table</p>
          <table class="state-table">
            <thead><tr><th>State</th><th>T (°C)</th><th>P</th><th>h (kJ/kg)</th><th>s (kJ/kg·K)</th><th>ṁ (kg/s)</th></tr></thead>
            <tbody>
              {#each result.stateTable as st}
                <tr>
                  <td class="state-key">{st.name}</td>
                  <td>{fmt(st.T, 1)}</td>
                  <td>{st.P >= 1 ? `${fmt(st.P, 2)} MPa` : `${fmt(st.P * 1000, 0)} kPa`}</td>
                  <td>{fmt(st.h, 1)}</td>
                  <td>{fmt(st.s, 4)}</td>
                  <td>{fmt(st.flow, 2)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <div class="state-wrap chamfer-panel">
          <p class="group-label" style="margin-bottom:5px">Extraction &amp; drain state table</p>
          <p class="selection-hint" style="margin-bottom:8px">
            X1 (amber) = extraction steam entering an FWH shell · X2/X3 (blue) = shell drain / after its
            booster pump or valve. See the state-visibility panel above to toggle these on the diagram.
          </p>
          <table class="state-table">
            <thead><tr><th>State</th><th>T (°C)</th><th>P</th><th>h (kJ/kg)</th><th>s (kJ/kg·K)</th><th>ṁ (kg/s)</th></tr></thead>
            <tbody>
              {#each result.extractionTable as st}
                <tr>
                  <td class="state-key" class:state-key-drain={!st.name.endsWith('1')}>{st.name}</td>
                  <td>{fmt(st.T, 1)}</td>
                  <td>{st.P >= 1 ? `${fmt(st.P, 2)} MPa` : `${fmt(st.P * 1000, 0)} kPa`}</td>
                  <td>{fmt(st.h, 1)}</td>
                  <td>{fmt(st.s, 4)}</td>
                  <td>{fmt(st.flow, 2)}</td>
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

  /* Independent scroll panes: each column pins to the viewport top and scrolls
     internally from there, so paging through sliders never carries the T-s
     diagram/readouts out of view, and vice versa. A colored scrollbar per
     column (amber left, teal right - matching each side's own accent) plus a
     vertical seam down the gap are the visual tell that these are two
     separate scroll regions, not one long page. Both drop back to normal
     single-column page flow below the breakpoint, where two independent
     scroll regions would just fight the page's own scroll. */
  .controls-col, .diagram-col {
    position: sticky;
    top: 16px;
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
  }
  .controls-col {
    padding-right: 14px;
    border-right: 1px solid rgba(0, 0, 0, 0.14);
    scrollbar-color: #c07a10 transparent;
  }
  .diagram-col { scrollbar-color: var(--teal-dim) transparent; }
  .controls-col::-webkit-scrollbar, .diagram-col::-webkit-scrollbar { width: 8px; }
  .controls-col::-webkit-scrollbar-track, .diagram-col::-webkit-scrollbar-track { background: transparent; }
  .controls-col::-webkit-scrollbar-thumb {
    background-color: #c07a10;
    border-radius: 5px;
  }
  .diagram-col::-webkit-scrollbar-thumb {
    background-color: var(--teal-dim);
    border-radius: 5px;
  }
  @media (max-width: 800px) {
    .controls-col, .diagram-col {
      position: static;
      max-height: none;
      overflow: visible;
    }
    .controls-col { padding-right: 0; border-right: none; }
  }

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
  /* Stainless texture (not brushed aluminum) so the grain doesn't compete with the text. */
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
    background: none; border: none; width: 100%;
    display: flex; justify-content: space-between; align-items: center;
  }
  .details-summary::before {
    content: '';
    display: inline-block;
    width: 7px; height: 7px; border-radius: 50%;
    background: #9a9d9a;
    box-shadow: 0 0 0 1.5px rgba(0, 0, 0, 0.15);
    margin-right: 8px;
    transition: background 0.2s ease, box-shadow 0.2s ease;
  }
  .slider-open > .details-summary::before {
    background: var(--slider-color, #8d9686);
    box-shadow:
      0 0 0 1.5px var(--slider-glow-1, rgba(141, 150, 134, 0.55)),
      0 0 6px 2px var(--slider-glow-2, rgba(141, 150, 134, 0.85));
  }
  /* Hover-only affordance glow, gated to real pointer devices: touchscreens have no true
     hover-exit event, so a tap that closes the section would otherwise leave this "stuck" on. */
  @media (hover: hover) and (pointer: fine) {
    .details-summary:hover::before {
      background: var(--slider-color, #8d9686);
      box-shadow:
        0 0 0 1.5px var(--slider-glow-1, rgba(141, 150, 134, 0.55)),
        0 0 6px 2px var(--slider-glow-2, rgba(141, 150, 134, 0.85));
    }
    .details-summary:hover { color: var(--paper); }
  }
  /* Chevron drawn as two stacked SVG strokes (grey behind, coloured on top) rather than a
     rotated border-corner box with filter: drop-shadow() - that combination (filter applied
     to a rotated, non-rectangular alpha shape) renders with a visible gap at the corner on
     some real phone browsers. Plain SVG strokes don't have that failure mode, and swapping
     the two points sets directly (open vs closed) sidesteps needing to animate a rotation. */
  .details-summary .chevron { flex-shrink: 0; margin-left: 8px; }
  .chevron-bg { fill: none; stroke: #6b7278; stroke-width: 3.2; stroke-linecap: round; stroke-linejoin: round; }
  .chevron-fg { fill: none; stroke: var(--slider-color, #8d9686); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .slider-open > .details-summary::after { transform: rotate(45deg); }
  .slider-body { padding: 2px 12px 14px; }

  /* Emergent condenser metrics helper line under the cooling sliders */
  .cond-helper {
    font-family: var(--font-mono);
    font-size: 11px; font-weight: 700; color: var(--blue); line-height: 1.4; margin: 8px 0 0;
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
  .slider-label span:first-child { font-size: 13px; font-weight: 700; color: var(--ink); }
  .slider-value {
    font-size: 13px; font-weight: 700; color: var(--paper);
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
    font-size: 10px; font-weight: 700; letter-spacing: 0.04em; line-height: 1.25;
    color: var(--ink-dim); text-transform: uppercase; margin: 0 0 4px;
  }
  .readout-value {
    font-size: 16px; font-weight: 700; color: var(--paper);
    margin: 0; font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .readout-value-amber { color: var(--amber-dim); }
  .readout-value-alarm { color: var(--red-dim); font-weight: 700; }
  .readout-unit { font-family: var(--font-display); font-size: 11px; font-weight: 700; color: var(--ink-dim); }

  /* .readout-card has clip-path (chamfered corners), which clips box-shadow too - the alarm
     glow goes on this unclipped outer wrapper instead so it can bleed past the panel edges. */
  .readout-outer { border-radius: 8px; }
  .readout-alarm { animation: readout-alarm-glow 1s ease-in-out infinite; }
  @keyframes readout-alarm-glow {
    0%, 100% { box-shadow: 0 0 10px 2px rgba(255, 61, 46, 0.6), 0 0 0 0 rgba(255, 61, 46, 0.5); }
    50%      { box-shadow: 0 0 26px 8px rgba(255, 61, 46, 1), 0 0 0 6px rgba(255, 61, 46, 0.18); }
  }

  /* State table */
  .state-wrap { margin-bottom: 12px; padding: 12px 14px; }
  .state-table {
    width: 100%; border-collapse: collapse; font-size: 13px; color: var(--paper);
  }
  .state-table th {
    font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
    text-transform: uppercase; color: var(--ink-dim);
    text-align: left; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--steel-900);
  }
  .state-table td {
    font-family: var(--font-mono);
    padding: 4px 8px 4px 0; font-variant-numeric: tabular-nums;
    border-bottom: 1px solid var(--steel-800); color: var(--ink);
  }
  .state-key { font-weight: 700; color: var(--amber-dim); }
  .state-key-drain { color: var(--blue); }

  /* Diagram */
  .diagram-title {
    font-size: 12px; font-weight: 700; color: var(--ink-dim);
    text-transform: uppercase; letter-spacing: 0.07em; margin: 0 0 8px;
  }
  .scope-panel { padding: 14px; }
  .ts-svg { width: 100%; height: auto; display: block; overflow: visible; }

  /* SVG classes */
  .axis      { stroke: var(--steel-900); stroke-width: 1; }
  .grid-line { stroke: rgba(0, 0, 0, 0.08); stroke-width: 1; }
  .axis-tick  { font-family: var(--font-mono); font-size: 11px; font-weight: 700; fill: var(--ink-dim); }
  .axis-label { font-family: var(--font-display); font-size: 12px; font-weight: 700; fill: var(--ink-dim); }

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
    font-size: 11.5px; font-weight: 700; color: var(--ink-dim); margin: 0 0 10px; line-height: 1.45;
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
    cursor: pointer; font-size: 12px; font-weight: 700; color: var(--ink); line-height: 1.35;
  }
  .sel-item input[type="checkbox"] {
    margin-top: 2px; accent-color: var(--blue); flex-shrink: 0; cursor: pointer;
  }
  .sel-dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: var(--amber); border: 1px solid #000; flex-shrink: 0; margin-top: 3px;
    /* Solid ring + soft halo - a plain blur glow doesn't read on this light background. */
    box-shadow: 0 0 0 1.5px rgba(242, 172, 65, 0.55), 0 0 7px 3px rgba(242, 172, 65, 0.85);
  }
  .sel-dot-drain {
    background: var(--blue);
    box-shadow: 0 0 0 1.5px rgba(111, 178, 238, 0.55), 0 0 7px 3px rgba(111, 178, 238, 0.85);
  }
  /* Deselected: lit indicator goes dark, like an unpowered LED - no glow, no color. */
  .sel-dot-off {
    background: #9a9d9a;
    box-shadow: 0 0 0 1.5px rgba(0, 0, 0, 0.15);
  }
  .sel-label { flex: 1; }

  /* Legend */
  .diagram-legend { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 9px; }
  .leg {
    font-size: 12px; font-weight: 700; color: var(--ink-dim);
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