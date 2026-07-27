<script lang="ts">
  import { onMount } from 'svelte';

  // Diffusion / entropy sandbox. A hot block (dense dots, bottom-middle) sits in
  // a cold container (sparse dots elsewhere); every step each dot random-walks
  // one cell or stays. Left = exact dot positions (a microstate); right = the
  // nine section densities in dots-per-square (the macrostate); bottom = the
  // Boltzmann entropy S = k ln W of that macrostate, step by step.

  // --- Grid geometry ---
  // Fine simulation grid (90x90): a dot must walk ~30 cells to cross a section
  // boundary, so the macrostate takes many steps to even out. The drawn grid is
  // the same 90x90 the dots actually move on.
  const SECTIONS = 3;
  const CELLS = 30;
  const FINE = SECTIONS * CELLS; // 90
  const LCELL = 8;               // svg units per cell (left grid)
  const LVB = FINE * LCELL;      // 720
  const DOT_R = 3.4;

  // --- Dot budget ---
  const DENSE = 280;
  const SPARSE = 15;
  const TOTAL = DENSE + SPARSE * 8; // 400 energy quanta
  const UNIFORM = TOTAL / 9;
  const DPS_MID = Math.round(DENSE / 2); // key midpoint (linear: half of DENSE)
  const DPS_MAX = DENSE;                  // key top (the initial hot-block density)

  // ln(k!) table so W = TOTAL! / prod(n_i!) is a subtraction.
  const LNFACT = (() => {
    const a = new Float64Array(TOTAL + 1);
    for (let k = 2; k <= TOTAL; k++) a[k] = a[k - 1] + Math.log(k);
    return a;
  })();

  // Entropy floor (peaked start) and ceiling (uniform-as-possible), in units of k.
  const S_MIN = LNFACT[TOTAL] - (LNFACT[DENSE] + 8 * LNFACT[SPARSE]);
  const S_MAX = (() => {
    const q = Math.floor(TOTAL / 9), r = TOTAL % 9;
    return LNFACT[TOTAL] - (r * LNFACT[q + 1] + (9 - r) * LNFACT[q]);
  })();

  // --- State ---
  let dots = $state<Array<{ x: number; y: number }>>([]);
  let playing = $state(false);
  let speed = $state(40);   // steps per second
  let steps = $state(0);

  // Entropy history lives in a plain array (cheap to append); a reactive length
  // counter drives the graph so we never rebuild a growing reactive array.
  const histArr: number[] = [];
  let histLen = $state(0);

  function initDots() {
    const arr: Array<{ x: number; y: number }> = [];
    const seed = (sc: number, sr: number, count: number) => {
      for (let i = 0; i < count; i++)
        arr.push({
          x: sc * CELLS + ((Math.random() * CELLS) | 0),
          y: sr * CELLS + ((Math.random() * CELLS) | 0),
        });
    };
    seed(1, 2, DENSE);
    for (let sr = 0; sr < 3; sr++)
      for (let sc = 0; sc < 3; sc++)
        if (!(sc === 1 && sr === 2)) seed(sc, sr, SPARSE);
    return arr;
  }

  function densitiesOf(p: Array<{ x: number; y: number }>) {
    const d = new Array(9).fill(0);
    for (const q of p) d[((q.y / CELLS) | 0) * 3 + ((q.x / CELLS) | 0)]++;
    return d;
  }
  function entropyOf(p: Array<{ x: number; y: number }>) {
    if (!p.length) return S_MIN;
    let s = LNFACT[TOTAL];
    for (const n of densitiesOf(p)) s -= LNFACT[n];
    return s;
  }

  const densities = $derived(densitiesOf(dots));
  const entropy = $derived(dots.length ? entropyOf(dots) : S_MIN);
  const expW = $derived(Math.round(entropy / Math.LN10));

  function step() {
    const next = new Array(dots.length);
    for (let i = 0; i < dots.length; i++) {
      let { x, y } = dots[i];
      const r = (Math.random() * 5) | 0;
      if (r === 1 && y > 0) y--;
      else if (r === 2 && y < FINE - 1) y++;
      else if (r === 3 && x > 0) x--;
      else if (r === 4 && x < FINE - 1) x++;
      next[i] = { x, y };
    }
    dots = next;
    steps++;
    histArr.push(entropyOf(next));
    histLen = histArr.length;
  }

  function reset() {
    playing = false;
    steps = 0;
    dots = initDots();
    histArr.length = 0;
    histArr.push(entropyOf(dots));
    histLen = 1;
  }

  onMount(() => {
    dots = initDots();
    histArr.length = 0;
    histArr.push(entropyOf(dots));
    histLen = 1;
  });

  // requestAnimationFrame loop, running multiple steps per frame so the speed
  // isn't capped by the browser's minimum timer interval.
  let rafId = 0;
  let accum = 0;
  let lastT = 0;
  function frame(t: number) {
    if (!playing) { rafId = 0; return; }
    if (!lastT) lastT = t;
    let dt = (t - lastT) / 1000;
    lastT = t;
    if (dt > 0.1) dt = 0.1;
    accum += dt * speed;
    let n = Math.floor(accum);
    if (n > 0) {
      accum -= n;
      if (n > 120) n = 120;
      for (let k = 0; k < n; k++) step();
    }
    rafId = requestAnimationFrame(frame);
  }
  $effect(() => {
    if (playing) { lastT = 0; accum = 0; rafId = requestAnimationFrame(frame); }
    return () => { if (rafId) cancelAnimationFrame(rafId); rafId = 0; };
  });

  // --- Density color: diverging scale centered on the equilibrium DPS ---
  // Linear scale in DPS (frac = n / DENSE), so a section's color sits at its
  // true position from 0 to DENSE. The white band lands where the average DPS
  // (~UNIFORM / DENSE of the way along, near the low end) actually is - not
  // forced to the middle - and the hot end deepens to a dark red at DENSE.
  const STOPS: Array<[number, [number, number, number]]> = [
    [0.0, [38, 96, 158]],     // deep cold
    [0.05, [111, 178, 238]],  // blue
    [0.10, [223, 226, 229]],  // near-white (band start, ~28 DPS)
    [0.22, [223, 226, 229]],  // near-white (band end, ~62 DPS; average ~44 sits inside)
    [0.35, [242, 172, 65]],   // amber
    [0.55, [224, 68, 52]],    // red
    [1.0, [140, 22, 18]],     // deep dark red at DENSE
  ];
  function cellRGB(n: number): [number, number, number] {
    const frac = Math.max(0, Math.min(1, n / DENSE));
    for (let i = 1; i < STOPS.length; i++) {
      if (frac <= STOPS[i][0]) {
        const [t0, c0] = STOPS[i - 1], [t1, c1] = STOPS[i];
        const f = (frac - t0) / (t1 - t0);
        return [
          Math.round(c0[0] + (c1[0] - c0[0]) * f),
          Math.round(c0[1] + (c1[1] - c0[1]) * f),
          Math.round(c0[2] + (c1[2] - c0[2]) * f),
        ];
      }
    }
    return STOPS[STOPS.length - 1][1];
  }
  const textColor = (rgb: [number, number, number]) =>
    0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] < 150 ? '#f4f6f5' : '#1c2023';

  // --- Entropy graph geometry ---
  const GW = 720, GH = 210, GL = 58, GR = 16, GT = 14, GB = 32;
  const PLOTW = GW - GL - GR, PLOTH = GH - GT - GB;
  const yLo = S_MIN - (S_MAX - S_MIN) * 0.06;
  const yHi = S_MAX + (S_MAX - S_MIN) * 0.06;
  const xFor = (i: number, m: number) => GL + (i / m) * PLOTW;
  const yFor = (v: number) => GT + (1 - (v - yLo) / (yHi - yLo)) * PLOTH;

  // Curve rebased on history length (never squishes), decimated to ~1200 verts.
  const curve = $derived.by(() => {
    const n = histLen;
    if (n < 2) return '';
    const m = Math.max(n - 1, 60);
    const stride = Math.max(1, Math.ceil(n / 1200));
    let pts = '';
    for (let i = 0; i < n; i += stride) pts += `${xFor(i, m).toFixed(1)},${yFor(histArr[i]).toFixed(1)} `;
    const li = n - 1;
    if (li % stride !== 0) pts += `${xFor(li, m).toFixed(1)},${yFor(histArr[li]).toFixed(1)}`;
    return pts.trim();
  });
  const head = $derived.by(() => {
    if (!histLen) return null;
    const m = Math.max(histLen - 1, 60);
    return { x: xFor(histLen - 1, m), y: yFor(histArr[histLen - 1]) };
  });

  function fmt(n: number, d = 0) { return n.toFixed(d); }
</script>

<div class="entropy-wrap">
  <div class="ctrl-row">
    <button type="button" class="ctrl-btn chamfer-panel chamfer-sm" onclick={() => (playing = !playing)}>
      {#if playing}
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="2" y="1.5" width="3" height="9" /><rect x="7" y="1.5" width="3" height="9" /></svg>
        <span>Pause</span>
      {:else}
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><polygon points="2.5,1.5 10.5,6 2.5,10.5" /></svg>
        <span>Play</span>
      {/if}
    </button>
    <button type="button" class="ctrl-btn chamfer-panel chamfer-sm" onclick={reset}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M10 6a4 4 0 1 1-1.2-2.85" fill="none" stroke="currentColor" stroke-width="1.5" /><polygon points="10.6,1 10.8,4 7.8,3.4" /></svg>
      <span>Reset</span>
    </button>
    <div class="speed-ctrl">
      <div class="speed-label"><label for="entropy-speed">Speed</label><span class="speed-value">{speed}/s</span></div>
      <input id="entropy-speed" type="range" min="5" max="300" step="5" bind:value={speed} />
    </div>
  </div>

  <div class="viz-grid">
    <div class="viz-col">
      <p class="panel-title">Microstate (dot positions)</p>
      <div class="viz-panel chamfer-panel chamfer-all">
        <svg viewBox="0 0 {LVB} {LVB}" class="grid-svg" role="img" aria-label="Fine grid of energy dots diffusing through nine sections">
          <rect x="0" y="0" width={LVB} height={LVB} fill="#f4f5f6" />
          {#each Array(FINE - 1) as _, i}
            <line class="fine" x1={(i + 1) * LCELL} y1="0" x2={(i + 1) * LCELL} y2={LVB} />
            <line class="fine" x1="0" y1={(i + 1) * LCELL} x2={LVB} y2={(i + 1) * LCELL} />
          {/each}
          {#each [1, 2] as s}
            <line class="section" x1={s * CELLS * LCELL} y1="0" x2={s * CELLS * LCELL} y2={LVB} />
            <line class="section" x1="0" y1={s * CELLS * LCELL} x2={LVB} y2={s * CELLS * LCELL} />
          {/each}
          <rect class="frame" x="1" y="1" width={LVB - 2} height={LVB - 2} />
          {#each dots as d}
            <circle class="dot" cx={(d.x + 0.5) * LCELL} cy={(d.y + 0.5) * LCELL} r={DOT_R} />
          {/each}
        </svg>
      </div>
    </div>

    <div class="viz-col">
      <p class="panel-title">Macrostate (density, DPS)</p>
      <div class="viz-panel chamfer-panel chamfer-all">
        <div class="dps-grid" role="img" aria-label="Dot density per section in dots-per-square, colored by density">
          {#each densities as n}
            {@const rgb = cellRGB(n)}
            <div class="dps-cell" style={`--c: rgb(${rgb[0]},${rgb[1]},${rgb[2]}); color: ${textColor(rgb)}`}>
              <span class="dps-num">{n}</span>
              <span class="dps-unit">DPS</span>
            </div>
          {/each}
        </div>
      </div>
      <div class="legend">
        <div class="legend-bar"></div>
        <div class="legend-labels"><span>{0}</span><span>{DPS_MID}</span><span>{DPS_MAX}</span></div>
      </div>
    </div>
  </div>

  <div class="graph-block">
    <p class="panel-title">Boltzmann entropy, S = k ln W</p>
    <div class="viz-panel chamfer-panel chamfer-all">
      <svg viewBox="0 0 {GW} {GH}" class="graph-svg" role="img" aria-label="Entropy of the system over time, rising toward its maximum">
        {#each [0.25, 0.5, 0.75] as g}
          <line class="g-grid" x1={GL} y1={GT + PLOTH * g} x2={GW - GR} y2={GT + PLOTH * g} />
        {/each}
        <line class="g-axis" x1={GL} y1={GT} x2={GL} y2={GT + PLOTH} />
        <line class="g-axis" x1={GL} y1={GT + PLOTH} x2={GW - GR} y2={GT + PLOTH} />

        <line class="g-ceiling" x1={GL} y1={yFor(S_MAX)} x2={GW - GR} y2={yFor(S_MAX)} />
        <text class="g-ceiling-label" x={GW - GR} y={yFor(S_MAX) - 5} text-anchor="end">S_max (equilibrium)</text>

        {#if curve}
          <polyline class="g-curve" points={curve} />
        {/if}
        {#if head}
          <circle class="g-head" cx={head.x} cy={head.y} r="3.5" />
        {/if}

        <text class="g-axis-label" x={GL - 8} y={yFor(S_MAX) + 4} text-anchor="end">{fmt(S_MAX)}</text>
        <text class="g-axis-label" x={GL - 8} y={yFor(S_MIN) + 4} text-anchor="end">{fmt(S_MIN)}</text>
        <text class="g-axis-title" x={GL} y={GH - 8} text-anchor="start">steps (time)</text>
        <text class="g-axis-title" x={-(GT + PLOTH / 2)} y="14" text-anchor="middle" transform="rotate(-90 0 0)">S / k = ln W</text>
      </svg>
    </div>
  </div>

  <div class="readout-grid">
    <div class="readout-card chamfer-panel chamfer-sm">
      <p class="readout-label">Step</p>
      <p class="readout-value">{steps}</p>
    </div>
    <div class="readout-card chamfer-panel chamfer-sm">
      <p class="readout-label">Entropy S = k&middot;lnW</p>
      <p class="readout-value">{fmt(entropy, 1)} <span class="readout-unit">k</span></p>
    </div>
    <div class="readout-card chamfer-panel chamfer-sm">
      <p class="readout-label">Microstates W</p>
      <p class="readout-value">&asymp; 10<sup class="exp">{expW}</sup></p>
    </div>
  </div>
</div>

<style>
  .entropy-wrap { font-family: var(--font-display); width: 100%; }

  .ctrl-row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 20px;
  }
  .ctrl-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 8px 15px;
    font-family: var(--font-display);
    font-size: 0.85rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    color: var(--ink);
    cursor: pointer;
    border: none;
    transition: color 0.15s ease, transform 0.15s ease, filter 0.15s ease;
  }
  .ctrl-btn svg { fill: currentColor; flex-shrink: 0; }
  .ctrl-btn:hover { color: var(--teal-dim); filter: brightness(1.08); }
  .ctrl-btn:active { transform: translateY(1px); filter: brightness(0.94); }

  .speed-ctrl { flex: 1; min-width: 180px; max-width: 320px; }
  .speed-label { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
  .speed-label label { font-size: 12px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-dim); }
  .speed-value { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--ink); }

  .viz-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 28px;
    align-items: start;
  }
  @media (max-width: 620px) { .viz-grid { grid-template-columns: 1fr; } }

  .viz-col { min-width: 0; }
  .panel-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-dim);
    margin: 0 0 8px;
  }
  .viz-panel { padding: 12px; }
  .grid-svg { width: 100%; height: auto; display: block; }

  .fine { stroke: rgba(70, 80, 90, 0.12); stroke-width: 0.6; }
  .section { stroke: var(--ink); stroke-width: 2.4; }
  .frame { fill: none; stroke: var(--ink); stroke-width: 2.4; }
  .dot { fill: #e0742a; fill-opacity: 0.85; }

  /* DPS tiles: flat density-color fills, square corners, thin dark seam. */
  .dps-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    grid-auto-rows: 1fr;
    gap: 4px;
    aspect-ratio: 1 / 1;
  }
  .dps-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background-color: var(--c);
    border: 1px solid rgba(10, 11, 13, 0.3);
  }
  .dps-num { font-family: var(--font-mono); font-size: clamp(20px, 4.4vw, 32px); font-weight: 700; line-height: 1; }
  .dps-unit { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.08em; opacity: 0.72; margin-top: 3px; }

  .legend { margin: 10px 2px 0; }
  .legend-bar {
    height: 10px;
    background: linear-gradient(90deg,
      rgb(38, 96, 158) 0%, rgb(111, 178, 238) 5%, rgb(223, 226, 229) 10%, rgb(223, 226, 229) 22%, rgb(242, 172, 65) 35%, rgb(224, 68, 52) 55%, rgb(140, 22, 18) 100%);
    border: 1px solid rgba(10, 11, 13, 0.2);
  }
  .legend-labels {
    display: flex;
    justify-content: space-between;
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--ink-dim);
    margin-top: 4px;
  }

  .graph-block { margin-top: 26px; }
  .graph-svg { width: 100%; height: auto; display: block; }
  .g-grid { stroke: rgba(70, 80, 90, 0.13); stroke-width: 1; }
  .g-axis { stroke: var(--steel-900); stroke-width: 1.2; }
  .g-ceiling { stroke: var(--teal-dim); stroke-width: 1.4; stroke-dasharray: 5 4; opacity: 0.75; }
  .g-ceiling-label { font-family: var(--font-mono); font-size: 11px; font-weight: 700; fill: var(--teal-dim); }
  .g-curve { fill: none; stroke: var(--amber-dim); stroke-width: 2.4; stroke-linejoin: round; stroke-linecap: round; }
  .g-head { fill: var(--amber); stroke: var(--amber-dim); stroke-width: 1; }
  .g-axis-label { font-family: var(--font-mono); font-size: 11px; font-weight: 700; fill: var(--ink-dim); }
  .g-axis-title { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.03em; fill: var(--ink-dim); }

  .readout-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    margin-top: 22px;
  }
  @media (max-width: 480px) { .readout-grid { grid-template-columns: 1fr; } }
  .readout-card { padding: 10px 12px; }
  .readout-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: var(--ink-dim);
    margin: 0 0 5px;
    text-transform: uppercase;
  }
  .readout-value {
    font-family: var(--font-mono);
    font-size: 18px;
    font-weight: 700;
    color: var(--paper);
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  .readout-value .exp { font-size: 12px; }
  .readout-unit { font-family: var(--font-display); font-size: 11px; color: var(--ink-dim); font-weight: 700; }
</style>
