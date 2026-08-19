<script lang="ts">
  import Gauge from './Gauge.svelte';
  // carnot cycle interactive explainer, formulas in NOTES.md

  let TH = $state(800); // hot reservoir temperature, K
  let TC = $state(300); // cold reservoir temperature, K
  const QH = 100; // heat input, kJ (fixed reference value)

  // TC must stay strictly below TH for a valid heat engine
  function clampTC(value: number) {
    return value >= TH ? TH - 10 : value;
  }
  function clampTH(value: number) {
    return value <= TC ? TC + 10 : value;
  }

  const eta1 = $derived(1 - TC / TH); // 1st law efficiency, fraction
  const eta2 = $derived(1); // 2nd law efficiency, always 100% for Carnot
  const W = $derived(QH * eta1); // net work output, kJ
  const exIn = $derived(QH * (1 - TC / TH)); // exergy in, kJ (T0 = TC)
  const deltaT = $derived(TH - TC); // temperature difference, K

  // t-s diagram geometry
  const padL = 50, padR = 300, padT = 20, padB = 220;
  const Tmin = 200, Tmax = 1250;
  const s1 = 86, s2 = 210, s3 = 210, s4 = 86; // fixed entropy positions for the four corners

  function yForT(T: number) {
    return padB - ((T - Tmin) / (Tmax - Tmin)) * (padB - padT);
  }

  const yH = $derived(yForT(TH));
  const yC = $derived(yForT(TC));

  const rectPoints = $derived(`${s1},${yH} ${s2},${yH} ${s3},${yC} ${s4},${yC}`);

  function fmt(n: number, decimals = 1) {
    return n.toFixed(decimals);
  }
</script>

<div class="carnot-wrap">
  <div class="controls-col">
    <div class="slider-row">
      <div class="slider-label">
        <label for="th-slider">Hot reservoir T<sub>H</sub></label>
        <span class="slider-value">{TH} K</span>
      </div>
      <input
        id="th-slider"
        class="th-slider"
        type="range"
        min="500"
        max="1200"
        step="10"
        bind:value={TH}
        oninput={() => { TC = clampTC(TC); }}
      />
    </div>

    <div class="slider-row">
      <div class="slider-label">
        <label for="tc-slider">Cold reservoir T<sub>C</sub></label>
        <span class="slider-value">{TC} K</span>
      </div>
      <input
        id="tc-slider"
        class="tc-slider"
        type="range"
        min="250"
        max="700"
        step="10"
        bind:value={TC}
        oninput={() => { TH = clampTH(TH); }}
      />
    </div>

    <div class="gauge-grid">
      <Gauge
        label="1st law efficiency"
        value={eta1}
        valueText={fmt(eta1 * 100, 1)}
        unit="%"
        accent="#f2ac41"
        accentDim="#c07a10"
      />
      <Gauge
        label="2nd law efficiency"
        value={eta2}
        valueText={fmt(eta2 * 100, 0)}
        unit="%"
        accent="#35d6b4"
        accentDim="#14b8a6"
      />
    </div>

    <div class="readout-grid">
      <div class="readout-card chamfer-panel chamfer-sm">
        <p class="readout-label">Heat in, Q<sub>H</sub></p>
        <p class="readout-value">{fmt(QH, 0)} <span class="readout-unit">kJ</span></p>
      </div>
      <div class="readout-card chamfer-panel chamfer-sm">
        <p class="readout-label">Work out, W<sub>net</sub></p>
        <p class="readout-value">{fmt(W, 1)} <span class="readout-unit">kJ</span></p>
      </div>
      <div class="readout-card chamfer-panel chamfer-sm">
        <p class="readout-label">&Delta;T (T<sub>H</sub> &minus; T<sub>C</sub>)</p>
        <p class="readout-value">{fmt(deltaT, 0)} <span class="readout-unit">K</span></p>
      </div>
      <div class="readout-card chamfer-panel chamfer-sm">
        <p class="readout-label">Exergy in, Ex<sub>H</sub></p>
        <p class="readout-value">{fmt(exIn, 1)} <span class="readout-unit">kJ</span></p>
        <p class="exergy-note">Ref. environment: T<sub>0</sub> = T<sub>C</sub></p>
      </div>
    </div>
  </div>

  <div class="diagram-col">
    <p class="panel-title">Temperature&ndash;Entropy Diagram</p>
    <div class="diagram-panel chamfer-panel chamfer-all">
    <svg
      viewBox="0 0 320 230"
      class="ts-svg"
      role="img"
      aria-label="Temperature-entropy diagram of the Carnot cycle, a rectangle whose corners move as reservoir temperatures change"
    >
      <line x1={padL} y1={padB} x2={padR} y2={padB} class="axis" />
      <line x1={padL} y1={padB} x2={padL} y2={padT} class="axis" />
      <text x={padR + 5} y={padB + 4} class="axis-text">s</text>
      <text x={padL - 14} y={padT - 2} class="axis-text">T</text>

      <line x1={padL} y1={yH} x2={padR} y2={yH} class="ref-line" />
      <line x1={padL} y1={yC} x2={padR} y2={yC} class="ref-line" />
      <text x={padL - 8} y={yH + 4} class="ref-text" text-anchor="end">{TH} K</text>
      <text x={padL - 8} y={yC + 4} class="ref-text" text-anchor="end">{TC} K</text>

      <polygon points={rectPoints} class="cycle-fill" />

      <line x1={s1} y1={yH} x2={s2} y2={yH} class="edge-hot" />
      <line x1={s3} y1={yC} x2={s4} y2={yC} class="edge-cold" />
      <line x1={s2} y1={yH} x2={s3} y2={yC} class="edge-adiabat" />
      <line x1={s4} y1={yC} x2={s1} y2={yH} class="edge-adiabat" />

      <circle cx={s1} cy={yH} r="3.5" class="point" />
      <circle cx={s2} cy={yH} r="3.5" class="point" />
      <circle cx={s3} cy={yC} r="3.5" class="point" />
      <circle cx={s4} cy={yC} r="3.5" class="point" />
      <text x={s1 + 8} y={yH + 14} class="point-text">1</text>
      <text x={s2 - 14} y={yH + 14} class="point-text">2</text>
      <text x={s3 - 14} y={yC - 8} class="point-text">3</text>
      <text x={s4 + 8} y={yC - 8} class="point-text">4</text>
    </svg>

    <div class="caption-wrap">
      <p class="caption">
        Top edge (1&rarr;2): isothermal heat addition at T<sub>H</sub>. Right edge (2&rarr;3):
        reversible adiabatic expansion. Bottom edge (3&rarr;4): isothermal heat rejection
        at T<sub>C</sub>. Left edge (4&rarr;1): reversible adiabatic compression.
      </p>
    </div>
    </div>
  </div>
</div>

<style>
  .carnot-wrap {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 40px;
    align-items: start;
    width: 100%;
  }

  @media (max-width: 640px) {
    .carnot-wrap {
      grid-template-columns: 1fr;
    }
  }

  .controls-col,
  .diagram-col {
    font-family: var(--font-display);
    /* overrides the grid item default min-width auto, otherwise a wide child
       can force the 1fr track past its container at narrow viewports. */
    min-width: 0;
  }

  .panel-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-dim);
    margin: 0 0 8px;
  }

  .slider-row {
    margin-bottom: 1.25rem;
  }

  .slider-label {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 6px;
  }

  .slider-label label {
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: var(--ink);
  }

  .slider-value {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 700;
  }

  .th-slider { --slider-color: #e8935f; --slider-tint: rgba(232, 147, 95, 0.2); }
  .tc-slider { --slider-color: #5ba3e8; --slider-tint: rgba(91, 163, 232, 0.2); }

  .gauge-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin-top: 1.25rem;
  }

  .readout-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
    margin-top: 16px;
  }

  .readout-card {
    padding: 10px 12px;
  }

  .readout-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: var(--ink-dim);
    margin: 0 0 5px;
    text-transform: uppercase;
  }

  .readout-value {
    font-size: 18px;
    font-weight: 700;
    color: var(--paper);
    margin: 0;
    font-variant-numeric: tabular-nums;
  }

  .readout-unit {
    font-family: var(--font-display);
    font-size: 11px;
    color: var(--ink-dim);
    font-weight: 700;
  }

  .exergy-note {
    font-size: 11px;
    font-weight: 700;
    color: var(--ink-dim);
    margin: 6px 0 0;
  }

  .diagram-panel {
    padding: 16px;
  }

  .ts-svg {
    width: 100%;
    height: auto;
    overflow: visible;
    display: block;
  }

  .axis {
    stroke: var(--steel-900);
    stroke-width: 1;
  }

  .axis-text {
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
    fill: var(--ink-dim);
  }

  .ref-line {
    stroke: var(--steel-800);
    stroke-width: 1;
    stroke-dasharray: 3, 3;
  }

  .ref-text {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 700;
    fill: var(--ink);
  }

  .cycle-fill {
    fill: #378add;
    fill-opacity: 0.18;
    stroke: var(--blue);
    stroke-width: 1.5;
  }

  .edge-hot {
    stroke: var(--amber);
    stroke-width: 2.75;
    filter: drop-shadow(0 0 3px rgba(242, 172, 65, 0.5));
  }

  .edge-cold {
    stroke: var(--blue);
    stroke-width: 2.75;
    filter: drop-shadow(0 0 3px rgba(111, 178, 238, 0.5));
  }

  .edge-adiabat {
    stroke: var(--steel-800);
    stroke-width: 1.5;
    stroke-dasharray: 4, 3;
  }

  .point {
    fill: var(--paper);
    stroke: #000;
    stroke-width: 0.5;
  }

  .point-text {
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
    fill: var(--paper);
  }

  .caption-wrap {
    padding-left: 15.62%;
    padding-right: 6.25%;
    margin-top: 10px;
  }

  .caption {
    font-size: 13px;
    font-weight: 700;
    color: var(--ink-dim);
    margin: 0;
    line-height: 1.5;
  }
</style>