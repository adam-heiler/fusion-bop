<script lang="ts">
  import { onMount } from 'svelte';
  import { init, solveCycle, getDome } from '../lib/rankineSolver.js';

  // ── Slider state ─────────────────────────────────────────────────────────────
  let T1            = $state(540);
  let T3            = $state(500);
  let P2            = $state(60);
  let P4            = $state(5);
  let reheat_dP_pct = $state(3);
  let P_VA          = $state(117);
  let eta_HP   = $state(0.85);
  let eta_IP   = $state(0.85);
  let eta_LP   = $state(0.85);
  let eta_pump = $state(0.85);
  let eta_gen  = $state(0.985);
  let TTD         = $state(2.8);
  let T0          = $state(25);
  let RH          = $state(50);
  let cw_approach = $state(3.1);
  let cond_TTD    = $state(2.8);

  const FIXED = {
    P1: 250, P_B: 100, P_C: 7.5, P_D: 6,
    P_E: 4.3, P_F: 2.2, P_G: 1.5,
    P_condpump: 5, P_feedpump: 250, Q: 1000, subcool: 2.8,
  };

  function params() {
    return {
      T1, T3, P2, P4, reheat_dP_pct, P_VA,
      eta_HP, eta_IP, eta_LP, eta_pump, eta_gen, TTD,
      T0, RH, cw_approach, cond_TTD,
      ...FIXED,
    };
  }

  // ── App state ─────────────────────────────────────────────────────────────────
  let loading = $state(true);
  let dome    = $state<any>(null);
  let result  = $state<any>(null);
  let errMsg  = $state<string | null>(null);

  function runSolve() {
    try {
      result = solveCycle(params());
      errMsg = null;
    } catch (e: any) {
      errMsg = String(e);
    }
  }

  onMount(async () => {
    await init();
    dome = getDome();
    loading = false;
    runSolve();
  });

  // ── Gauge geometry (mirrors CarnotCycle.svelte exactly) ───────────────────────
  const gCx = 80, gCy = 85, gR = 60;

  function angleForFraction(frac: number) { return 180 - frac * 180; }

  function polarPoint(deg: number, r: number) {
    const rad = deg * Math.PI / 180;
    return { x: gCx + r * Math.cos(rad), y: gCy - r * Math.sin(rad) };
  }

  function arcPath(f0: number, f1: number, r: number) {
    const a0 = angleForFraction(f0), a1 = angleForFraction(f1);
    const p0 = polarPoint(a0, r), p1 = polarPoint(a1, r);
    return `M ${p0.x} ${p0.y} A ${r} ${r} 0 0 ${f1 > f0 ? 1 : 0} ${p1.x} ${p1.y}`;
  }

  const gaugeTrack = arcPath(0, 1, gR);

  // Pre-compute gauge fill arcs and needle tips reactively
  const g1Fill   = $derived(result ? arcPath(0, result.eta_1, gR) : '');
  const g1Needle = $derived(result ? polarPoint(angleForFraction(result.eta_1), gR - 12) : { x: gCx, y: gCy });
  const g2Fill   = $derived(result ? arcPath(0, Math.min(result.eta_2, 1), gR) : '');
  const g2Needle = $derived(result ? polarPoint(angleForFraction(Math.min(result.eta_2, 1)), gR - 12) : { x: gCx, y: gCy });

  // ── T-s diagram geometry ──────────────────────────────────────────────────────
  const SVG_W = 500, SVG_H = 370;
  const PL = 46, PR = 10, PT = 12, PB = 36;
  const CW = SVG_W - PL - PR, CH = SVG_H - PT - PB;
  const S_LO = 0, S_HI = 9.5, T_LO = -5, T_HI = 590;

  function sx(s: number) { return PL + (s - S_LO) / (S_HI - S_LO) * CW; }
  function ty(T: number) { return PT + CH * (1 - (T - T_LO) / (T_HI - T_LO)); }

  function polyline(arr: [number, number][]) {
    return arr.map(([s, T]) => `${sx(s).toFixed(1)},${ty(T).toFixed(1)}`).join(' ');
  }

  function pathD(arr: [number, number][]) {
    if (!arr || arr.length === 0) return '';
    return 'M ' + arr.map(([s, T]) => `${sx(s).toFixed(1)},${ty(T).toFixed(1)}`).join(' L ');
  }

  const T_TICKS = [0, 100, 200, 300, 400, 500];
  const S_TICKS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

  function fmt(v: number | null | undefined, d = 1) {
    return v != null ? v.toFixed(d) : '—';
  }

  // Label nudge: [dx, dy] relative to the state circle
  const NUDGE: Record<number, [number, number]> = {
    1: [6, -8], 2: [6, 12], 3: [6, -8], 4: [6, 8],
    5: [6, -9], 6: [-14, -8], 12: [6, -8], 16: [6, -8],
  };
</script>

<div class="rankine-wrap">
  {#if loading}
    <div class="loading-state">
      <div class="loading-spinner"></div>
      <p>Initializing CoolProp WASM…</p>
    </div>
  {:else if errMsg}
    <div class="error-banner">Solver error: {errMsg}</div>
  {:else}
    <!-- ── Left column ─────────────────────────────────────────────────────── -->
    <div class="controls-col">

      <!-- Gauges -->
      {#if result}
        <div class="gauge-grid">
          <div class="gauge-card">
            <p class="gauge-label">1st law efficiency</p>
            <svg viewBox="0 0 160 100" class="gauge-svg">
              <path d={gaugeTrack} fill="none" stroke="#22251f" stroke-width="10" />
              <path d={g1Fill} fill="none" stroke="#ef9f27" stroke-width="10" />
              <line x1={gCx} y1={gCy} x2={g1Needle.x} y2={g1Needle.y} stroke="#fac775" stroke-width="2.5" stroke-linecap="round" />
              <circle cx={gCx} cy={gCy} r="5" fill="#fac775" />
              <text x="20" y="98" class="gauge-tick">0%</text>
              <text x="140" y="98" class="gauge-tick" text-anchor="end">100%</text>
            </svg>
            <p class="gauge-value gauge-value-amber">{fmt(result.eta_1 * 100, 2)}%</p>
          </div>
          <div class="gauge-card">
            <p class="gauge-label">2nd law efficiency</p>
            <svg viewBox="0 0 160 100" class="gauge-svg">
              <path d={gaugeTrack} fill="none" stroke="#22251f" stroke-width="10" />
              <path d={g2Fill} fill="none" stroke="#5dcaa5" stroke-width="10" />
              <line x1={gCx} y1={gCy} x2={g2Needle.x} y2={g2Needle.y} stroke="#9fe1cb" stroke-width="2.5" stroke-linecap="round" />
              <circle cx={gCx} cy={gCy} r="5" fill="#9fe1cb" />
              <text x="20" y="98" class="gauge-tick">0%</text>
              <text x="140" y="98" class="gauge-tick" text-anchor="end">100%</text>
            </svg>
            <p class="gauge-value gauge-value-teal">{fmt(Math.min(result.eta_2, 1) * 100, 2)}%</p>
          </div>
        </div>
      {/if}

      <!-- Sliders -->
      <div class="slider-group">
        <p class="group-label">Steam conditions</p>
        <div class="slider-row">
          <div class="slider-label"><label>Boiler outlet T₁</label><span class="slider-value">{T1} °C</span></div>
          <input type="range" min="480" max="600" step="5" bind:value={T1} onchange={runSolve} />
        </div>
        <div class="slider-row">
          <div class="slider-label"><label>Reheater outlet T₃</label><span class="slider-value">{T3} °C</span></div>
          <input type="range" min="480" max="600" step="5" bind:value={T3} onchange={runSolve} />
        </div>
        <div class="slider-row">
          <div class="slider-label"><label>HP exhaust P₂</label><span class="slider-value">{P2} bar</span></div>
          <input type="range" min="30" max="100" step="1" bind:value={P2} onchange={runSolve} />
        </div>
        <div class="slider-row">
          <div class="slider-label"><label>IP exhaust P₄</label><span class="slider-value">{P4} bar</span></div>
          <input type="range" min="2" max="20" step="0.5" bind:value={P4} onchange={runSolve} />
        </div>
        <div class="slider-row">
          <div class="slider-label"><label>Reheat ΔP</label><span class="slider-value">{reheat_dP_pct} %</span></div>
          <input type="range" min="0" max="8" step="0.5" bind:value={reheat_dP_pct} onchange={runSolve} />
        </div>
        <div class="slider-row">
          <div class="slider-label"><label>FWH6 shell P (Valve A)</label><span class="slider-value">{P_VA} bar</span></div>
          <input type="range" min="60" max="200" step="1" bind:value={P_VA} onchange={runSolve} />
        </div>
      </div>

      <div class="slider-group">
        <p class="group-label">Isentropic efficiencies</p>
        <div class="slider-row">
          <div class="slider-label"><label>η HP turbine</label><span class="slider-value">{(eta_HP*100).toFixed(0)} %</span></div>
          <input type="range" min="0.5" max="1" step="0.01" bind:value={eta_HP} onchange={runSolve} />
        </div>
        <div class="slider-row">
          <div class="slider-label"><label>η IP turbine</label><span class="slider-value">{(eta_IP*100).toFixed(0)} %</span></div>
          <input type="range" min="0.5" max="1" step="0.01" bind:value={eta_IP} onchange={runSolve} />
        </div>
        <div class="slider-row">
          <div class="slider-label"><label>η LP turbine</label><span class="slider-value">{(eta_LP*100).toFixed(0)} %</span></div>
          <input type="range" min="0.5" max="1" step="0.01" bind:value={eta_LP} onchange={runSolve} />
        </div>
        <div class="slider-row">
          <div class="slider-label"><label>η pumps (all)</label><span class="slider-value">{(eta_pump*100).toFixed(0)} %</span></div>
          <input type="range" min="0.5" max="1" step="0.01" bind:value={eta_pump} onchange={runSolve} />
        </div>
        <div class="slider-row">
          <div class="slider-label"><label>η generator</label><span class="slider-value">{(eta_gen*100).toFixed(1)} %</span></div>
          <input type="range" min="0.95" max="1" step="0.001" bind:value={eta_gen} onchange={runSolve} />
        </div>
      </div>

      <div class="slider-group">
        <p class="group-label">Feedwater heating</p>
        <div class="slider-row">
          <div class="slider-label"><label>FWH terminal temp diff (TTD)</label><span class="slider-value">{TTD} °C</span></div>
          <input type="range" min="0" max="15" step="0.5" bind:value={TTD} onchange={runSolve} />
        </div>
      </div>

      <div class="slider-group">
        <p class="group-label">Cooling / environment</p>
        <div class="slider-row">
          <div class="slider-label"><label>Ambient temp T₀</label><span class="slider-value">{T0} °C</span></div>
          <input type="range" min="0" max="40" step="1" bind:value={T0} onchange={runSolve} />
        </div>
        <div class="slider-row">
          <div class="slider-label"><label>Relative humidity</label><span class="slider-value">{RH} %</span></div>
          <input type="range" min="10" max="99" step="1" bind:value={RH} onchange={runSolve} />
        </div>
        <div class="slider-row">
          <div class="slider-label"><label>Cooling tower approach</label><span class="slider-value">{cw_approach} °C</span></div>
          <input type="range" min="2" max="15" step="0.1" bind:value={cw_approach} onchange={runSolve} />
        </div>
        <div class="slider-row">
          <div class="slider-label"><label>Condenser TTD</label><span class="slider-value">{cond_TTD} °C</span></div>
          <input type="range" min="0" max="10" step="0.1" bind:value={cond_TTD} onchange={runSolve} />
        </div>
      </div>

      <!-- Key readouts -->
      {#if result}
        <div class="readout-grid">
          <div class="readout-card">
            <p class="readout-label">Net electrical output</p>
            <p class="readout-value readout-value-amber">{fmt(result.W_net / 1e6, 1)} <span class="readout-unit">MW</span></p>
          </div>
          <div class="readout-card">
            <p class="readout-label">Total steam flow</p>
            <p class="readout-value">{fmt(result.m, 1)} <span class="readout-unit">kg/s</span></p>
          </div>
          <div class="readout-card">
            <p class="readout-label">Condenser pressure</p>
            <p class="readout-value">{fmt(result.P6 / 1000, 2)} <span class="readout-unit">kPa</span></p>
          </div>
          <div class="readout-card">
            <p class="readout-label">Condenser temp</p>
            <p class="readout-value">{fmt(result.T6C, 2)} <span class="readout-unit">°C</span></p>
          </div>
          <div class="readout-card">
            <p class="readout-label">Wet-bulb temp</p>
            <p class="readout-value">{fmt(result.T_wb, 2)} <span class="readout-unit">°C</span></p>
          </div>
          <div class="readout-card">
            <p class="readout-label">Turbine work</p>
            <p class="readout-value">{fmt(result.W_turb / 1e6, 1)} <span class="readout-unit">MW</span></p>
          </div>
        </div>

        <!-- Extraction fractions -->
        <div class="extraction-wrap">
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

    <!-- ── Right column: T-s diagram ──────────────────────────────────────── -->
    <div class="diagram-col">
      <p class="diagram-title">Temperature–Entropy (T–s) Diagram</p>

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

        <!-- Saturation dome — drawn first so cycle paths render on top -->
        {#if dome}
          <path d={pathD(dome.liq)} class="dome" />
          <path d={pathD(dome.vap)} class="dome" />
          <circle cx={sx(dome.liq[dome.liq.length-1][0])} cy={ty(dome.liq[dome.liq.length-1][1])} r="4" class="dome-crit" />
        {/if}

        {#if result}
          {@const r = result}

          <!-- Feedwater heating: 6→…→12→…→16 (draw first, under boiler path) -->
          <path d={pathD(r.fwPath)} class="path-fw" />

          <!-- Boiler: supercritical heating 16→1 -->
          <path d={pathD(r.boilerPath)} class="path-boiler" />

          <!-- HP turbine: 1→2 -->
          <line x1={sx(r.s1)} y1={ty(r.statePoints[1][1])}
                x2={sx(r.s2)} y2={ty(r.statePoints[2][1])}
                class="path-expand" />

          <!-- Reheater: 2→3 -->
          <path d={pathD(r.reheatPath)} class="path-reheat" />

          <!-- IP turbine: 3→4 -->
          <line x1={sx(r.s3)} y1={ty(r.statePoints[3][1])}
                x2={sx(r.s4)} y2={ty(r.statePoints[4][1])}
                class="path-expand" />

          <!-- LP turbine: 4→5 -->
          <line x1={sx(r.s4)} y1={ty(r.statePoints[4][1])}
                x2={sx(r.s5)} y2={ty(r.statePoints[5][1])}
                class="path-expand" />

          <!-- Condenser: 5→6 -->
          <line x1={sx(r.s5)} y1={ty(r.statePoints[5][1])}
                x2={sx(r.s6)} y2={ty(r.statePoints[6][1])}
                class="path-cond" />

          <!-- State circles and labels -->
          {#each [1, 2, 3, 4, 5, 6, 12, 16] as n}
            {@const [sp, Tp] = r.statePoints[n]}
            {@const [dx, dy] = NUDGE[n] ?? [6, 4]}
            <circle cx={sx(sp)} cy={ty(Tp)} r="4" class="state-pt" />
            <text x={sx(sp) + dx} y={ty(Tp) + dy} class="state-label">{n}</text>
          {/each}
        {/if}
      </svg>

      <div class="diagram-legend">
        <span class="leg leg-boiler">Boiler</span>
        <span class="leg leg-reheat">Reheater</span>
        <span class="leg leg-expand">Turbines</span>
        <span class="leg leg-cond">Condenser</span>
        <span class="leg leg-fw">Feedwater</span>
        <span class="leg leg-dome">Sat. dome</span>
      </div>

      <!-- Fixed parameters -->
      <div class="fixed-params">
        <p class="group-label" style="margin-bottom:4px">Fixed parameters</p>
        <div class="fixed-grid">
          <span>P₁ = 250 bar</span><span>P<sub>B</sub> = 100 bar</span>
          <span>P<sub>C</sub> = 7.5 bar</span><span>P<sub>D</sub> = 6 bar</span>
          <span>P<sub>E</sub> = 4.3 bar</span><span>P<sub>F</sub> = 2.2 bar</span>
          <span>P<sub>G</sub> = 1.5 bar</span><span>Q = 1000 MW</span>
        </div>
      </div>
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
  }
  @media (max-width: 800px) { .rankine-wrap { grid-template-columns: 1fr; } }

  /* Loading / error */
  .loading-state {
    grid-column: 1 / -1;
    display: flex; flex-direction: column; align-items: center;
    gap: 16px; padding: 60px 0; color: #aab3a3; font-size: 15px;
  }
  .loading-spinner {
    width: 32px; height: 32px;
    border: 3px solid #3d423a; border-top-color: #ef9f27;
    border-radius: 50%; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error-banner {
    grid-column: 1 / -1; background: #3a2020; border: 1px solid #7a3030;
    border-radius: 6px; padding: 12px 16px; color: #f4a0a0; font-size: 14px;
  }

  /* Gauges */
  .gauge-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 20px;
  }
  .gauge-card {
    background: #2b2f27; border: 1px solid #3d423a; border-radius: 6px; padding: 12px;
  }
  .gauge-label {
    font-size: 11px; font-weight: 600; letter-spacing: 0.05em;
    text-transform: uppercase; color: #aab3a3; margin: 0 0 8px;
  }
  .gauge-svg { width: 100%; height: auto; display: block; }
  .gauge-tick { font-size: 10px; fill: #7d8676; }
  .gauge-value {
    text-align: center; font-size: 20px; font-weight: 600;
    margin: 4px 0 0; font-variant-numeric: tabular-nums;
  }
  .gauge-value-amber { color: #fac775; }
  .gauge-value-teal  { color: #9fe1cb; }

  /* Sliders */
  .slider-group { margin-bottom: 16px; }
  .group-label {
    font-size: 11px; font-weight: 600; letter-spacing: 0.07em;
    text-transform: uppercase; color: #7d8676; margin: 0 0 8px;
  }
  .slider-row { margin-bottom: 9px; }
  .slider-label {
    display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 2px;
  }
  .slider-label label { font-size: 13px; color: #c9cfc5; }
  .slider-value {
    font-size: 13px; font-weight: 600; color: #f4f6f2;
    font-variant-numeric: tabular-nums; min-width: 56px; text-align: right;
  }
  input[type="range"] { width: 100%; accent-color: #ef9f27; }

  /* Readout cards */
  .readout-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px;
  }
  .readout-card {
    background: #2b2f27; border: 1px solid #3d423a; border-radius: 6px; padding: 10px 12px;
  }
  .readout-label {
    font-size: 11px; font-weight: 500; letter-spacing: 0.04em;
    color: #aab3a3; text-transform: uppercase; margin: 0 0 3px;
  }
  .readout-value {
    font-size: 18px; font-weight: 600; color: #f4f6f2;
    margin: 0; font-variant-numeric: tabular-nums;
  }
  .readout-value-amber { color: #fac775; }
  .readout-unit { font-size: 11px; font-weight: 400; color: #aab3a3; }

  /* Extraction table */
  .extraction-wrap { margin-bottom: 12px; }
  .extraction-table {
    width: 100%; border-collapse: collapse; font-size: 13px; color: #c9cfc5;
  }
  .extraction-table th {
    font-size: 11px; font-weight: 600; letter-spacing: 0.05em;
    text-transform: uppercase; color: #7d8676;
    text-align: left; padding: 4px 8px 4px 0; border-bottom: 1px solid #3d423a;
  }
  .extraction-table td {
    padding: 4px 8px 4px 0; font-variant-numeric: tabular-nums;
    border-bottom: 1px solid #2b2f27;
  }
  .bleed-key { font-weight: 600; color: #ef9f27; }

  /* Fixed params */
  .fixed-params { margin-top: 12px; }
  .fixed-grid {
    display: grid; grid-template-columns: repeat(4, 1fr);
    gap: 4px 10px; font-size: 12px; color: #7d8676;
  }

  /* Diagram */
  .diagram-col { position: sticky; top: 16px; }
  .diagram-title {
    font-size: 12px; font-weight: 600; color: #aab3a3;
    text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 6px;
  }
  .ts-svg { width: 100%; height: auto; display: block; overflow: visible; }

  /* SVG classes */
  .axis      { stroke: #8d9686; stroke-width: 1; }
  .grid-line { stroke: #2f342b; stroke-width: 1; }
  .axis-tick  { font-size: 11px; fill: #7d8676; }
  .axis-label { font-size: 12px; fill: #aab3a3; }

  .dome      { fill: none; stroke: #b5d9ac; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
  .dome-crit { fill: #b5d9ac; }

  .path-boiler  { fill: none; stroke: #e8935f; stroke-width: 2.5; }
  .path-reheat  { fill: none; stroke: #fac775; stroke-width: 2.5; }
  .path-expand  { fill: none; stroke: #d6dad0; stroke-width: 2; }
  .path-cond    { fill: none; stroke: #5ba3e8; stroke-width: 2; }
  .path-fw      { fill: none; stroke: #5dcaa5; stroke-width: 1.5; stroke-dasharray: 4 3; }

  .state-pt    { fill: #f4f6f2; }
  .state-label { font-size: 11px; font-weight: 600; fill: #f4f6f2; }

  /* Legend */
  .diagram-legend { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 7px; }
  .leg {
    font-size: 12px; color: #aab3a3;
    display: flex; align-items: center; gap: 5px;
  }
  .leg::before { content: ''; display: inline-block; width: 18px; height: 2px; }
  .leg-boiler::before { background: #e8935f; }
  .leg-reheat::before { background: #fac775; }
  .leg-expand::before { background: #d6dad0; }
  .leg-cond::before   { background: #5ba3e8; }
  .leg-fw::before     { background: #5dcaa5; }
  .leg-dome::before   { background: #8fa888; }
</style>
