<script lang="ts">
  // Carnot cycle interactive explainer
  // 1st law efficiency: eta_th = 1 - Tc/Th
  //   Source: Moran, Shapiro, Boettner & Bailey, "Fundamentals of Engineering
  //   Thermodynamics," 8th ed., Ch. 5.3 (Carnot efficiency from the Kelvin
  //   temperature scale / 2nd law).
  // 2nd law (exergetic) efficiency: eta_II = W_net / Ex_in
  //   Source: Moran et al., Ch. 7 (Exergy Analysis), eta_II = Wdot / Exdot_heat.
  //   For a Carnot engine this is identically 100% because the cycle is fully
  //   reversible (zero exergy destruction) — that's why it's the reference
  //   cycle for 2nd law comparisons (Cengel & Boles, "Thermodynamics: An
  //   Engineering Approach," Ch. 8).
  // Exergy of heat input: Ex_in = Q_H * (1 - T0/T_H), with T0 = T_C
  //   Source: Moran et al., Ch. 7.1, exergy transfer accompanying heat
  //   transfer, Exdot_heat = Qdot * (1 - T0/T). Using T_C as the reference
  //   environment T0 is the standard assumption when no separate ambient
  //   temperature is specified.

  let TH = $state(800); // hot reservoir temperature, K
  let TC = $state(300); // cold reservoir temperature, K
  const QH = 100; // heat input, kJ (fixed reference value)

  // Guard: TC must stay strictly below TH for a valid heat engine.
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

  // --- Gauge geometry ---
  // Semicircular gauge, 0% at the LEFT (180deg), 100% at the RIGHT (0deg),
  // sweeping over the TOP. Verified independently against landmark points
  // (0% -> left, 50% -> top, 100% -> right) before being written in here.
  const gaugeCx = 80, gaugeCy = 85, gaugeR = 60;

  function angleForFraction(frac: number) {
    return 180 - frac * 180;
  }

  function polarPoint(angleDeg: number, radius: number) {
    const rad = (angleDeg * Math.PI) / 180;
    return {
      x: gaugeCx + radius * Math.cos(rad),
      y: gaugeCy - radius * Math.sin(rad)
    };
  }

  function arcPath(fromFrac: number, toFrac: number, radius: number) {
    const a0 = angleForFraction(fromFrac);
    const a1 = angleForFraction(toFrac);
    const p0 = polarPoint(a0, radius);
    const p1 = polarPoint(a1, radius);
    const sweep = toFrac > fromFrac ? 1 : 0;
    return `M ${p0.x} ${p0.y} A ${radius} ${radius} 0 0 ${sweep} ${p1.x} ${p1.y}`;
  }

  const gauge1TrackPath = arcPath(0, 1, gaugeR);
  const gauge1FillPath = $derived(arcPath(0, eta1, gaugeR));
  const gauge1NeedleTip = $derived(polarPoint(angleForFraction(eta1), gaugeR - 12));

  const gauge2TrackPath = arcPath(0, 1, gaugeR);
  const gauge2FillPath = arcPath(0, 1, gaugeR); // always full, eta2 is always 1
  const gauge2NeedleTip = polarPoint(angleForFraction(1), gaugeR - 12); // always far right

  // --- T-s diagram geometry ---
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
      <div class="gauge-card">
        <p class="gauge-label">1st law efficiency</p>
        <svg viewBox="0 0 160 100" class="gauge-svg">
          <path d={gauge1TrackPath} fill="none" stroke="#22251f" stroke-width="10" />
          <path d={gauge1FillPath} fill="none" stroke="#ef9f27" stroke-width="10" />
          <line x1={gaugeCx} y1={gaugeCy} x2={gauge1NeedleTip.x} y2={gauge1NeedleTip.y} stroke="#fac775" stroke-width="2.5" stroke-linecap="round" />
          <circle cx={gaugeCx} cy={gaugeCy} r="5" fill="#fac775" />
          <text x="20" y="98" class="gauge-tick">0%</text>
          <text x="140" y="98" class="gauge-tick gauge-tick-end">100%</text>
        </svg>
        <p class="gauge-value gauge-value-amber">{fmt(eta1 * 100, 1)}%</p>
      </div>

      <div class="gauge-card">
        <p class="gauge-label">2nd law efficiency</p>
        <svg viewBox="0 0 160 100" class="gauge-svg">
          <path d={gauge2TrackPath} fill="none" stroke="#22251f" stroke-width="10" />
          <path d={gauge2FillPath} fill="none" stroke="#5dcaa5" stroke-width="10" />
          <line x1={gaugeCx} y1={gaugeCy} x2={gauge2NeedleTip.x} y2={gauge2NeedleTip.y} stroke="#9fe1cb" stroke-width="2.5" stroke-linecap="round" />
          <circle cx={gaugeCx} cy={gaugeCy} r="5" fill="#9fe1cb" />
          <text x="20" y="98" class="gauge-tick">0%</text>
          <text x="140" y="98" class="gauge-tick gauge-tick-end">100%</text>
        </svg>
        <p class="gauge-value gauge-value-teal">{fmt(eta2 * 100, 0)}%</p>
      </div>
    </div>

    <div class="readout-grid">
      <div class="readout-card">
        <p class="readout-label">Heat in, Q<sub>H</sub></p>
        <p class="readout-value">{fmt(QH, 0)} <span class="readout-unit">kJ</span></p>
      </div>
      <div class="readout-card">
        <p class="readout-label">Work out, W<sub>net</sub></p>
        <p class="readout-value">{fmt(W, 1)} <span class="readout-unit">kJ</span></p>
      </div>
      <div class="readout-card">
        <p class="readout-label">&Delta;T (T<sub>H</sub> &minus; T<sub>C</sub>)</p>
        <p class="readout-value">{fmt(deltaT, 0)} <span class="readout-unit">K</span></p>
      </div>
      <div class="readout-card">
        <p class="readout-label">Exergy in, Ex<sub>H</sub></p>
        <p class="readout-value">{fmt(exIn, 1)} <span class="readout-unit">kJ</span></p>
        <p class="exergy-note">Ref. environment: T<sub>0</sub> = T<sub>C</sub></p>
      </div>
    </div>
  </div>

  <div class="diagram-col">
    <svg
      viewBox="0 0 320 250"
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
    font-family: var(--font-sans, system-ui, sans-serif);
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
    font-weight: 500;
    color: #c9cfc5;
  }

  .slider-value {
    font-size: 14px;
    font-weight: 600;
    color: #f4f6f2;
  }

  input[type="range"] {
    width: 100%;
  }

  .th-slider {
    accent-color: #e8935f;
  }

  .tc-slider {
    accent-color: #5ba3e8;
  }

  .gauge-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-top: 1rem;
  }

  .gauge-card {
    background: #2b2f27;
    border: 1px solid #3d423a;
    border-radius: 6px;
    padding: 14px;
  }

  .gauge-label {
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.04em;
    color: #aab3a3;
    margin: 0 0 10px;
    text-transform: uppercase;
  }

  .gauge-svg {
    width: 100%;
    height: auto;
    display: block;
  }

  .gauge-tick {
    font-size: 10px;
    fill: #7d8676;
  }

  .gauge-tick-end {
    text-anchor: end;
  }

  .gauge-value {
    text-align: center;
    font-size: 22px;
    font-weight: 600;
    margin: 4px 0 0;
    font-variant-numeric: tabular-nums;
  }

  .gauge-value-amber {
    color: #fac775;
  }

  .gauge-value-teal {
    color: #9fe1cb;
  }

  .readout-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
    margin-top: 12px;
  }

  .readout-card {
    background: #2b2f27;
    border: 1px solid #3d423a;
    border-radius: 6px;
    padding: 10px 12px;
  }

  .readout-label {
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.03em;
    color: #aab3a3;
    margin: 0 0 4px;
    text-transform: uppercase;
  }

  .readout-value {
    font-size: 18px;
    font-weight: 600;
    color: #f4f6f2;
    margin: 0;
    font-variant-numeric: tabular-nums;
  }

  .readout-unit {
    font-size: 12px;
    color: #aab3a3;
    font-weight: 400;
  }

  .exergy-note {
    font-size: 11px;
    color: #8d9686;
    margin: 6px 0 0;
  }

  .ts-svg {
    width: 100%;
    height: auto;
    overflow: visible;
    display: block;
  }

  .axis {
    stroke: #8d9686;
    stroke-width: 1;
  }

  .axis-text {
    font-size: 13px;
    fill: #aab3a3;
  }

  .ref-line {
    stroke: #6b7363;
    stroke-width: 1;
    stroke-dasharray: 3, 3;
  }

  .ref-text {
    font-size: 14px;
    font-weight: 600;
    fill: #d6dad0;
  }

  .cycle-fill {
    fill: #378add;
    fill-opacity: 0.15;
    stroke: #5ba3e8;
    stroke-width: 1.5;
  }

  .edge-hot {
    stroke: #e8935f;
    stroke-width: 2.5;
  }

  .edge-cold {
    stroke: #5ba3e8;
    stroke-width: 2.5;
  }

  .edge-adiabat {
    stroke: #aab3a3;
    stroke-width: 1.5;
    stroke-dasharray: 4, 3;
  }

  .point {
    fill: #7dd3fc;
  }

  .point-text {
    font-size: 12px;
    font-weight: 500;
    fill: #f4f6f2;
  }

  .caption-wrap {
    padding-left: 15.62%;
    padding-right: 6.25%;
    margin-top: 6px;
  }

  .caption {
    font-size: 13px;
    color: #aab3a3;
    margin: 0;
    line-height: 1.5;
  }
</style>