<script lang="ts">
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { initCO2Solver, solveCO2Async } from '../lib/co2WorkerClient.js';
  import Gauge from './Gauge.svelte';

  // Slider defaults follow the ARC study (sustainability-16-07480, Tables 8/9):
  // 455°C turbine inlets, ~280/128/85 bar pressure levels, ~20% recompression
  // split, eta_c 0.90 / eta_HP 0.90 / eta_LP 0.92 / eta_gen 0.985, 645 MWth.
  // Pressures in MPa, temperatures °C, effectiveness and split in %.
  const DEFAULTS = {
    P_high: 28, P_mid: 12.8, P_low: 8.5,
    T1: 455, T3: 455, Q: 645,
    x_aux: 20, eps_HTR: 90, eps_LTR: 93,
    eta_HP: 0.90, eta_LP: 0.92, eta_comp: 0.90, eta_gen: 0.985,
    T0: 25, RH: 50, cw_approach: 3.1, pc_approach: 9, cw_range: 10,
  };

  let P_high  = $state(DEFAULTS.P_high);
  let P_mid   = $state(DEFAULTS.P_mid);
  let P_low   = $state(DEFAULTS.P_low);
  let T1      = $state(DEFAULTS.T1);
  let T3      = $state(DEFAULTS.T3);
  let Q       = $state(DEFAULTS.Q);
  let x_aux   = $state(DEFAULTS.x_aux);
  let eps_HTR = $state(DEFAULTS.eps_HTR);
  let eps_LTR = $state(DEFAULTS.eps_LTR);
  let eta_HP   = $state(DEFAULTS.eta_HP);
  let eta_LP   = $state(DEFAULTS.eta_LP);
  let eta_comp = $state(DEFAULTS.eta_comp);
  let eta_gen  = $state(DEFAULTS.eta_gen);
  let T0          = $state(DEFAULTS.T0);
  let RH          = $state(DEFAULTS.RH);
  let cw_approach = $state(DEFAULTS.cw_approach);
  let pc_approach = $state(DEFAULTS.pc_approach);
  let cw_range    = $state(DEFAULTS.cw_range);

  // With no aux-compressor flow, the cycle degenerates to a simple
  // regenerative Brayton - strike "Recompression" from the title.
  const isRecompression = $derived(x_aux > 0);

  // Pressure ordering: P_high > P_mid > P_low, all MPa. Unlike the Rankine
  // chain there are no TTD-style phase boundaries here, so plain synchronous
  // walking is enough - no solver round trips.
  const GAP = 0.5; // MPa
  const snap = (v: number) => +v.toFixed(2);

  let orderWarning = $state('');
  let warnTimeout: ReturnType<typeof setTimeout> | null = null;
  function flagOrder(msg: string) {
    orderWarning = msg;
    if (warnTimeout) clearTimeout(warnTimeout);
    warnTimeout = setTimeout(() => { orderWarning = ''; }, 7000);
  }

  type Chain = [string, () => number, (v: number) => void, number, number][];
  function getChain(): Chain {
    return [
      ['P_high', () => P_high, v => P_high = snap(v), 15,  32],
      ['P_mid',  () => P_mid,  v => P_mid  = snap(v), 9,   20],
      ['P_low',  () => P_low,  v => P_low  = snap(v), 7.5, 10],
    ];
  }

  function enforceOrder(changed: string) {
    const chain = getChain();
    const idx = chain.findIndex(([name]) => name === changed);
    if (idx === -1) return;
    let clamped = false;
    for (let i = idx - 1; i >= 0; i--) {
      const [, get, set, lo, hi] = chain[i];
      const [, getBelow] = chain[i + 1];
      if (get() <= getBelow() + GAP) {
        set(Math.min(hi, Math.max(lo, getBelow() + GAP)));
        clamped = true;
      }
    }
    for (let i = idx + 1; i < chain.length; i++) {
      const [, get, set, lo, hi] = chain[i];
      const [, getAbove] = chain[i - 1];
      if (get() >= getAbove() - GAP) {
        set(Math.min(hi, Math.max(lo, getAbove() - GAP)));
        clamped = true;
      }
    }
    if (clamped) {
      flagOrder('Adjacent pressure(s) shifted to keep the expansion path ordered (compressor discharge > reheat > turbine exhaust).');
    }
  }

  // Component state (MPa / % sliders) -> solver contract (Pa / fractions).
  function params() {
    return {
      P_high: P_high * 1e6, P_mid: P_mid * 1e6, P_low: P_low * 1e6,
      T1, T3, Q,
      x_aux: x_aux / 100, eps_HTR: eps_HTR / 100, eps_LTR: eps_LTR / 100,
      eta_HP, eta_LP, eta_comp, eta_gen,
      T0, RH, cw_approach, pc_approach, cw_range,
    };
  }

  let openSections: Record<string, boolean> = $state({
    gas: true, recomp: true, efficiencies: true, cooling: true,
  });
  function chevronPoints(open: boolean) {
    return open ? '2,3 5,7 8,3' : '3,2 7,5 3,8';
  }

  let loading = $state(true);
  let dome    = $state<any>(null);
  let result  = $state<any>(null);
  let errMsg  = $state<string | null>(null);

  async function runSolve() {
    try {
      result = await solveCO2Async(params());
      errMsg = null;
      if (result.warnings?.length) flagOrder(result.warnings.join(' '));
    } catch (e: any) {
      errMsg = String(e);
    }
  }

  function onPressureChange(name: string) {
    enforceOrder(name);
    runSolve();
  }

  function resetAll() {
    P_high = DEFAULTS.P_high; P_mid = DEFAULTS.P_mid; P_low = DEFAULTS.P_low;
    T1 = DEFAULTS.T1; T3 = DEFAULTS.T3; Q = DEFAULTS.Q;
    x_aux = DEFAULTS.x_aux; eps_HTR = DEFAULTS.eps_HTR; eps_LTR = DEFAULTS.eps_LTR;
    eta_HP = DEFAULTS.eta_HP; eta_LP = DEFAULTS.eta_LP;
    eta_comp = DEFAULTS.eta_comp; eta_gen = DEFAULTS.eta_gen;
    T0 = DEFAULTS.T0; RH = DEFAULTS.RH; cw_approach = DEFAULTS.cw_approach;
    pc_approach = DEFAULTS.pc_approach; cw_range = DEFAULTS.cw_range;
    orderWarning = '';
    if (warnTimeout) clearTimeout(warnTimeout);
    errMsg = null;
    runSolve();
  }

  onMount(async () => {
    dome = await initCO2Solver();
    loading = false;
    runSolve();
  });

  // Gauges
  const g1Val = $derived(result ? result.eta_1 : 0);
  const g2Val = $derived(result ? Math.min(result.eta_2, 1) : 0);
  const g3Val = $derived(result ? result.bwr : 0);           // back-work ratio
  const g3Warn = $derived(!!result && result.bwr > 0.5);
  const g3Accent    = $derived(g3Warn ? '#ff6459' : '#b39ef7');
  const g3AccentDim = $derived(g3Warn ? '#c0392b' : '#6d4fb0');
  const g4Val = $derived(result ? result.regen_share : 0);   // regeneration share

  // T-s diagram geometry. CO2 dome spans s 0.52-2.14 kJ/kg·K, T -56..31°C;
  // the cycle itself sits at s 1.2-2.8, T 0..600.
  const SVG_W = 500, SVG_H = 370;
  const PL = 46, PR = 10, PT = 12, PB = 36;
  const CW = SVG_W - PL - PR, CH = SVG_H - PT - PB;
  const S_LO = 0.4, S_HI = 3.0, T_LO = -60, T_HI = 620;

  function sx(s: number) { return PL + (s - S_LO) / (S_HI - S_LO) * CW; }
  function ty(T: number) { return PT + CH * (1 - (T - T_LO) / (T_HI - T_LO)); }

  function pathD(arr: [number, number][]) {
    if (!arr || arr.length === 0) return '';
    return 'M ' + arr.map(([s, T]) => `${sx(s).toFixed(1)},${ty(T).toFixed(1)}`).join(' L ');
  }

  const T_TICKS = [0, 100, 200, 300, 400, 500, 600];
  const S_TICKS = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0];

  function fmt(v: number | null | undefined, d = 1) {
    return v != null ? v.toFixed(d) : '-';
  }
  function pct(v: number, min: number, max: number) {
    return Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100));
  }
</script>

<div class="page-header">
  <h1 class="page-title">
    <span class="title-super" class:struck={!isRecompression}>Recompression</span> sCO<sub>2</sub> Brayton Cycle
  </h1>
  <button type="button" class="reset-btn chamfer-panel chamfer-sm" onclick={resetAll} title="Restore every slider to its default value">
    <span>Reset cycle</span>
  </button>
</div>

<div class="brayton-wrap">
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

      <div class="slider-details chamfer-panel chamfer-sm" class:slider-open={openSections.gas} style="--slider-color: #e8935f; --slider-tint: rgba(232, 147, 95, 0.2); --slider-glow-1: rgba(232, 147, 95, 0.55); --slider-glow-2: rgba(232, 147, 95, 0.85)">
        <button type="button" class="details-summary" aria-expanded={openSections.gas} onclick={() => openSections.gas = !openSections.gas}>
          Gas conditions
          <svg class="chevron" viewBox="0 0 10 10" width="10" height="10">
            <polyline points={chevronPoints(openSections.gas)} class="chevron-bg" />
            <polyline points={chevronPoints(openSections.gas)} class="chevron-fg" />
          </svg>
        </button>
        {#if openSections.gas}
        <div class="slider-body" transition:slide={{ duration: 200 }}>
          <div class="slider-row">
            <div class="slider-label"><span>Compressor discharge P</span><span class="slider-value">{P_high} MPa</span></div>
            <input id="c-phigh" type="range" min="15" max="32" step="0.1" bind:value={P_high} style="--pct: {pct(P_high,15,32)}%" onchange={() => onPressureChange('P_high')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>HP exhaust / reheat P</span><span class="slider-value">{P_mid} MPa</span></div>
            <input id="c-pmid" type="range" min="9" max="20" step="0.1" bind:value={P_mid} style="--pct: {pct(P_mid,9,20)}%" onchange={() => onPressureChange('P_mid')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>LP exhaust P (loop low side)</span><span class="slider-value">{P_low} MPa</span></div>
            <input id="c-plow" type="range" min="7.5" max="10" step="0.05" bind:value={P_low} style="--pct: {pct(P_low,7.5,10)}%" onchange={() => onPressureChange('P_low')} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>HP turbine inlet T₁</span><span class="slider-value">{T1} °C</span></div>
            <input id="c-t1" type="range" min="350" max="600" step="5" bind:value={T1} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>LP turbine inlet T₃ (reheat)</span><span class="slider-value">{T3} °C</span></div>
            <input id="c-t3" type="range" min="350" max="600" step="5" bind:value={T3} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>Secondary HTX duty Q</span><span class="slider-value">{Q} MW</span></div>
            <input id="c-q" type="range" min="200" max="2000" step="5" bind:value={Q} onchange={runSolve} />
          </div>
        </div>
        {/if}
      </div>

      <div class="slider-details chamfer-panel chamfer-sm" class:slider-open={openSections.recomp} style="--slider-color: #1a9b73; --slider-tint: rgba(26, 155, 115, 0.2); --slider-glow-1: rgba(26, 155, 115, 0.55); --slider-glow-2: rgba(26, 155, 115, 0.85)">
        <button type="button" class="details-summary" aria-expanded={openSections.recomp} onclick={() => openSections.recomp = !openSections.recomp}>
          Recompression and regeneration
          <svg class="chevron" viewBox="0 0 10 10" width="10" height="10">
            <polyline points={chevronPoints(openSections.recomp)} class="chevron-bg" />
            <polyline points={chevronPoints(openSections.recomp)} class="chevron-fg" />
          </svg>
        </button>
        {#if openSections.recomp}
        <div class="slider-body" transition:slide={{ duration: 200 }}>
          <div class="slider-row">
            <div class="slider-label"><span>Aux compressor split (a / total)</span><span class="slider-value">{x_aux} %</span></div>
            <input id="c-xaux" type="range" min="0" max="45" step="1" bind:value={x_aux} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>High-T regenerator effectiveness</span><span class="slider-value">{eps_HTR} %</span></div>
            <input id="c-ehtr" type="range" min="70" max="99" step="0.5" bind:value={eps_HTR} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>Low-T regenerator effectiveness</span><span class="slider-value">{eps_LTR} %</span></div>
            <input id="c-eltr" type="range" min="70" max="99" step="0.5" bind:value={eps_LTR} onchange={runSolve} />
          </div>
          <p class="cond-helper">
            The aux compressor takes hot low-pressure CO<sub>2</sub> straight from the split -
            skipping the precooler - so the low-T regenerator's cold side carries less flow,
            balancing the sharp cp mismatch near the critical point.
          </p>
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
            <input id="c-etahp" type="range" min="0.5" max="1" step="0.01" bind:value={eta_HP} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>η LP turbine</span><span class="slider-value">{(eta_LP*100).toFixed(0)} %</span></div>
            <input id="c-etalp" type="range" min="0.5" max="1" step="0.01" bind:value={eta_LP} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>η compressors (both)</span><span class="slider-value">{(eta_comp*100).toFixed(0)} %</span></div>
            <input id="c-etac" type="range" min="0.5" max="1" step="0.01" bind:value={eta_comp} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>η generator</span><span class="slider-value">{(eta_gen*100).toFixed(1)} %</span></div>
            <input id="c-gen" type="range" min="0.95" max="1" step="0.001" bind:value={eta_gen} onchange={runSolve} />
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
            <input id="c-t0" type="range" min="0" max="40" step="1" bind:value={T0} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>Relative humidity</span><span class="slider-value">{RH} %</span></div>
            <input id="c-rh" type="range" min="10" max="99" step="1" bind:value={RH} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>Cooling tower approach</span><span class="slider-value">{cw_approach} °C</span></div>
            <input id="c-cwa" type="range" min="2" max="15" step="0.1" bind:value={cw_approach} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>Precooler approach</span><span class="slider-value">{pc_approach} °C</span></div>
            <input id="c-pca" type="range" min="3" max="20" step="0.1" bind:value={pc_approach} onchange={runSolve} />
          </div>
          <div class="slider-row">
            <div class="slider-label"><span>CW temperature rise</span><span class="slider-value">{cw_range} °C</span></div>
            <input id="c-cwr" type="range" min="5" max="20" step="0.5" bind:value={cw_range} onchange={runSolve} />
          </div>
          {#if result}
            <p class="cond-helper">
              Main compressor intake: {fmt(result.T_M2, 1)} °C at {P_low} MPa ·
              ρ {fmt(result.rho_M2, 0)} kg/m³
              (CO<sub>2</sub> critical point: 31.0 °C, 7.38 MPa)
            </p>
          {/if}
        </div>
        {/if}
      </div>
    </div>

    <div class="diagram-col">
      <p class="diagram-title">Temperature-Entropy (T-s) Diagram</p>

      <div class="scope-panel chamfer-panel chamfer-all">
      <svg viewBox="0 0 {SVG_W} {SVG_H}" class="ts-svg" role="img"
           aria-label="T-s diagram of the recompression supercritical CO2 Brayton cycle">

        {#each T_TICKS as T}
          <line x1={PL} y1={ty(T)} x2={PL+CW} y2={ty(T)} class="grid-line" />
          <text x={PL-5} y={ty(T)+4} class="axis-tick" text-anchor="end">{T}</text>
        {/each}
        {#each S_TICKS as s}
          <line x1={sx(s)} y1={PT} x2={sx(s)} y2={PT+CH} class="grid-line" />
          <text x={sx(s)} y={PT+CH+14} class="axis-tick" text-anchor="middle">{s.toFixed(1)}</text>
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

          <path d={pathD(r.shx1Path)} class="path-shx" />
          <path d={pathD(r.hpPath)} class="path-expand" />
          <path d={pathD(r.reheatPath)} class="path-reheat" />
          <path d={pathD(r.lpPath)} class="path-expand" />
          <path d={pathD(r.htrHotPath)} class="path-regen-hot" />
          <path d={pathD(r.ltrHotPath)} class="path-regen-hot" />
          <path d={pathD(r.precoolPath)} class="path-precool" />
          <path d={pathD(r.mainCompPath)} class="path-comp" />
          <path d={pathD(r.ltrColdPath)} class="path-regen-cold" />
          <path d={pathD(r.auxCompPath)} class="path-comp-aux" />
          <path d={pathD(r.htrColdPath)} class="path-regen-cold" />
          {#each r.mixPaths as mp}
            <path d={pathD(mp)} class="path-mix" />
          {/each}

          {#each Object.entries(r.statePoints as Record<string, [number, number, string]>) as [name, [sp, Tp, tip]]}
            <circle cx={sx(sp)} cy={ty(Tp)} r={4} class="state-pt">
              <title>{tip}</title>
            </circle>
          {/each}

          {#each Object.entries(r.branchStatePoints as Record<string, [number, number, string]>) as [name, [sp, Tp, tip]]}
            <circle cx={sx(sp)} cy={ty(Tp)} r={3.5}
                    class={name.startsWith('A') ? 'state-pt-aux' : 'state-pt-main'}>
              <title>{tip}</title>
            </circle>
          {/each}
        {/if}
      </svg>

      <div class="diagram-legend">
        <span class="leg leg-shx">Secondary HTX</span>
        <span class="leg leg-reheat">Reheat pass</span>
        <span class="leg leg-expand">Turbines</span>
        <span class="leg leg-regen-hot">Regen (hot side)</span>
        <span class="leg leg-regen-cold">Regen (cold side)</span>
        <span class="leg leg-precool">Precooler</span>
        <span class="leg leg-comp">Main compressor</span>
        <span class="leg leg-comp-aux">Aux compressor</span>
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
            label="Back-work ratio"
            value={g3Val}
            valueText={fmt(g3Val * 100, 1)}
            unit="%"
            accent={g3Accent}
            accentDim={g3AccentDim}
            warn={g3Warn}
          />
          <Gauge
            label="Regeneration share"
            value={g4Val}
            valueText={fmt(g4Val * 100, 1)}
            unit="%"
            accent="#6fb2ee"
            accentDim="#2f6fa8"
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
            <p class="readout-label">Main compressor power</p>
            <p class="readout-value">{fmt(result.W_C1 / 1e6, 1)} <span class="readout-unit">MW</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Aux compressor power</p>
            <p class="readout-value">{fmt(result.W_C2 / 1e6, 1)} <span class="readout-unit">MW</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Total CO₂ flow</p>
            <p class="readout-value">{fmt(result.mtot, 0)} <span class="readout-unit">kg/s</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Precooler duty</p>
            <p class="readout-value">{fmt(result.Q_pc / 1e6, 1)} <span class="readout-unit">MW</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">High-T regen duty</p>
            <p class="readout-value">{fmt(result.Q_HTR / 1e6, 1)} <span class="readout-unit">MW</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Low-T regen duty</p>
            <p class="readout-value">{fmt(result.Q_LTR / 1e6, 1)} <span class="readout-unit">MW</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Comp intake temp</p>
            <p class="readout-value">{fmt(result.T_M2, 1)} <span class="readout-unit">°C</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Comp intake density</p>
            <p class="readout-value">{fmt(result.rho_M2, 0)} <span class="readout-unit">kg/m³</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Circulating water flow</p>
            <p class="readout-value">{fmt(result.mdot_cw, 0)} <span class="readout-unit">kg/s</span></p>
          </div>
          <div class="readout-card chamfer-panel chamfer-sm">
            <p class="readout-label">Cooling tower basin temp</p>
            <p class="readout-value">{fmt(result.T_cw_in, 2)} <span class="readout-unit">°C</span></p>
          </div>
        </div>

        <div class="state-wrap chamfer-panel">
          <p class="group-label" style="margin-bottom:5px">Cycle state table</p>
          <table class="state-table">
            <thead><tr><th>State</th><th>T (°C)</th><th>P (MPa)</th><th>h (kJ/kg)</th><th>s (kJ/kg·K)</th><th>Stream</th></tr></thead>
            <tbody>
              {#each result.stateTable as st}
                <tr>
                  <td class="state-key">{st.name}</td>
                  <td>{fmt(st.T, 1)}</td>
                  <td>{fmt(st.P, 2)}</td>
                  <td>{fmt(st.h, 1)}</td>
                  <td>{fmt(st.s, 4)}</td>
                  <td class="stream-cell">{st.flow}</td>
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
  .brayton-wrap {
    display: grid;
    grid-template-columns: minmax(0, 400px) minmax(0, 1fr);
    gap: 32px;
    align-items: start;
    width: 100%;
    font-family: var(--font-display);
  }
  @media (max-width: 800px) { .brayton-wrap { grid-template-columns: 1fr; } }

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
  .error-banner {
    grid-column: 1 / -1; padding: 12px 16px; color: var(--red-dim); font-size: 14px;
  }
  .error-banner::before { background-image: linear-gradient(165deg, var(--steel-650), var(--steel-800) 72%), var(--stainless); }
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

  /* Accordion slider groups */
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
  @media (hover: hover) and (pointer: fine) {
    .details-summary:hover::before {
      background: var(--slider-color, #8d9686);
      box-shadow:
        0 0 0 1.5px var(--slider-glow-1, rgba(141, 150, 134, 0.55)),
        0 0 6px 2px var(--slider-glow-2, rgba(141, 150, 134, 0.85));
    }
    .details-summary:hover { color: var(--paper); }
  }
  .details-summary .chevron { flex-shrink: 0; margin-left: 8px; }
  .chevron-bg { fill: none; stroke: #6b7278; stroke-width: 3.2; stroke-linecap: round; stroke-linejoin: round; }
  .chevron-fg { fill: none; stroke: var(--slider-color, #8d9686); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .slider-body { padding: 2px 12px 14px; }

  .cond-helper {
    font-family: var(--font-mono);
    font-size: 11px; font-weight: 700; color: var(--blue); line-height: 1.4; margin: 8px 0 0;
    padding: 7px 9px; background: rgba(111, 178, 238, 0.07); border: 1px solid rgba(111, 178, 238, 0.25); border-radius: 3px;
  }

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
  .readout-unit { font-family: var(--font-display); font-size: 11px; font-weight: 700; color: var(--ink-dim); }

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
  .stream-cell { color: var(--ink-dim); }

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

  .path-shx        { fill: none; stroke: #e8935f; stroke-width: 2.5; }
  .path-reheat     { fill: none; stroke: var(--amber); stroke-width: 2.5; }
  .path-expand     { fill: none; stroke: var(--ink); stroke-width: 2; }
  .path-regen-hot  { fill: none; stroke: #c98a3d; stroke-width: 2; stroke-dasharray: 5 3; }
  .path-regen-cold { fill: none; stroke: #7ba8cc; stroke-width: 2; stroke-dasharray: 5 3; }
  .path-precool    { fill: none; stroke: var(--blue); stroke-width: 2; }
  .path-comp       { fill: none; stroke: var(--teal-dim); stroke-width: 2; }
  .path-comp-aux   { fill: none; stroke: #1a9b73; stroke-width: 2; }
  .path-mix        { fill: none; stroke: var(--amber-dim); stroke-width: 1.5; stroke-dasharray: 4 2; }

  .state-pt      { fill: var(--paper); stroke: #000; stroke-width: 0.5; cursor: default; }
  .state-pt-main { fill: var(--teal-dim); stroke: #000; stroke-width: 0.5; cursor: default; }
  .state-pt-aux  { fill: var(--amber); stroke: #000; stroke-width: 0.5; cursor: default; }

  /* Legend */
  .diagram-legend { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 9px; }
  .leg {
    font-size: 12px; font-weight: 700; color: var(--ink-dim);
    display: flex; align-items: center; gap: 5px;
  }
  .leg::before { content: ''; display: inline-block; width: 18px; height: 2px; }
  .leg-shx::before        { background: #e8935f; }
  .leg-reheat::before     { background: var(--amber); }
  .leg-expand::before     { background: var(--ink); }
  .leg-regen-hot::before  { background: #c98a3d; }
  .leg-regen-cold::before { background: #7ba8cc; }
  .leg-precool::before    { background: var(--blue); }
  .leg-comp::before       { background: var(--teal-dim); }
  .leg-comp-aux::before   { background: #1a9b73; }
  .leg-dome::before       { background: var(--teal-dim); }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }

  .page-title {
    font-family: var(--font-display);
    font-size: 24px; font-weight: 700; color: var(--paper);
    letter-spacing: 0.02em;
    margin: 0 0 16px; line-height: 1.3;
  }

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
