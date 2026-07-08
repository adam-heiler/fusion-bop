<script lang="ts">
  // Reusable analog instrument gauge: machined bezel, recessed dial, tick
  // ring, sweep arc, tapered needle with counterweight + chrome hub, glass
  // glare, and a paired digital LCD readout underneath. Semicircular sweep,
  // 0% at the left (180deg) to 100% at the right (0deg), over the top -
  // geometry mirrors the layout the two cycle pages already relied on.
  let {
    value,
    label,
    valueText,
    unit = '',
    accent = '#f2ac41',
    accentDim = '#c07a10',
    warn = false,
    dangerBelow = null,
  }: {
    value: number;
    label: string;
    valueText: string;
    unit?: string;
    accent?: string;
    accentDim?: string;
    warn?: boolean;
    /** Draws a red hazard band from 0 up to this fraction (e.g. a low-quality cutoff). */
    dangerBelow?: number | null;
  } = $props();

  // Unique per-instance id suffix so multiple gauges on one page don't
  // collide over <defs> ids (SVG ids are document-global).
  const uid = Math.random().toString(36).slice(2, 9);

  const cx = 80, cy = 92, R = 52, BEZEL = R + 14;

  function angleFor(f: number) { return 180 - f * 180; }
  function pt(deg: number, r: number) {
    const rad = deg * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
  }
  function arcPath(f0: number, f1: number, r: number) {
    const a0 = angleFor(f0), a1 = angleFor(f1);
    const p0 = pt(a0, r), p1 = pt(a1, r);
    return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 0 ${f1 > f0 ? 1 : 0} ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
  }

  const bezelPath = `M ${cx - BEZEL} ${cy} A ${BEZEL} ${BEZEL} 0 0 1 ${cx + BEZEL} ${cy} L ${cx - BEZEL} ${cy} Z`;
  const facePath = `${arcPath(0, 1, R + 7)} L ${(cx - (R + 7)).toFixed(2)} ${cy} Z`;
  const trackPath = arcPath(0, 1, R);

  const clampedValue = $derived(Math.max(0, Math.min(1, value)));
  const fillPath = $derived(arcPath(0, clampedValue, R));
  const dangerPath = $derived(dangerBelow != null ? arcPath(0, dangerBelow, R + 10) : '');

  const TICKS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
  function isMajor(f: number) { return Math.round(f * 100) % 25 === 0; }
  function tickLine(f: number) {
    const major = isMajor(f);
    const a = angleFor(f);
    const p0 = pt(a, R - 2);
    const p1 = pt(a, major ? R + 10 : R + 4);
    return { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, major };
  }
  function tickLabelPos(f: number) { return pt(angleFor(f), R + 21); }

  const needlePoly = $derived.by(() => {
    const a = angleFor(clampedValue) * Math.PI / 180;
    const dx = Math.cos(a), dy = -Math.sin(a);
    const px = -dy, py = dx;
    const tipR = R - 8, tailR = 12, halfW = 2.4;
    const tip  = { x: cx + dx * tipR,  y: cy + dy * tipR };
    const tail = { x: cx - dx * tailR, y: cy - dy * tailR };
    const bl   = { x: cx + px * halfW, y: cy + py * halfW };
    const br   = { x: cx - px * halfW, y: cy - py * halfW };
    return `${tip.x.toFixed(2)},${tip.y.toFixed(2)} ${bl.x.toFixed(2)},${bl.y.toFixed(2)} ${tail.x.toFixed(2)},${tail.y.toFixed(2)} ${br.x.toFixed(2)},${br.y.toFixed(2)}`;
  });
</script>

<div class="gauge-widget chamfer-panel chamfer-sm" class:gauge-alarm={warn}>
  <p class="gauge-label">{label}</p>
  <svg viewBox="0 0 160 112" class="gauge-svg">
    <defs>
      <linearGradient id="bezel-{uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#fbfbfa" />
        <stop offset="12%" stop-color="#e4e6e5" />
        <stop offset="55%" stop-color="#c3c7c6" />
        <stop offset="100%" stop-color="#a6aba9" />
      </linearGradient>
      <radialGradient id="face-{uid}" cx="50%" cy="30%" r="80%">
        <stop offset="0%" stop-color="#f4f5f2" />
        <stop offset="100%" stop-color="#d9dcd7" />
      </radialGradient>
      <radialGradient id="hub-{uid}" cx="35%" cy="28%" r="75%">
        <stop offset="0%" stop-color="#f5f6f3" />
        <stop offset="45%" stop-color="#aeb4b9" />
        <stop offset="100%" stop-color="#454a50" />
      </radialGradient>
      <linearGradient id="glass-{uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.24" />
        <stop offset="65%" stop-color="#ffffff" stop-opacity="0.02" />
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
      </linearGradient>
      <clipPath id="clip-{uid}">
        <path d={bezelPath} />
      </clipPath>
      <filter id="shadow-{uid}" x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.55" />
      </filter>
    </defs>

    <!-- Machined bezel housing -->
    <path d={bezelPath} fill="url(#bezel-{uid})" filter="url(#shadow-{uid})" />
    <path d={bezelPath} fill="none" stroke="#8b908e" stroke-width="1" opacity="0.6" />

    <!-- Recessed dial face -->
    <path d={facePath} fill="url(#face-{uid})" />

    <!-- Danger zone -->
    {#if dangerPath}
      <path d={dangerPath} fill="none" stroke="var(--red, #ff6459)" stroke-width="3.5" stroke-linecap="round" opacity="0.8" />
    {/if}

    <!-- Tick ring -->
    {#each TICKS as f (f)}
      {@const t = tickLine(f)}
      <line x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke={t.major ? '#3a3f44' : '#8b9490'} stroke-width={t.major ? 1.3 : 0.7} />
      {#if t.major}
        {@const lp = tickLabelPos(f)}
        <text x={lp.x} y={lp.y + 3} class="gauge-num" text-anchor="middle">{Math.round(f * 100)}</text>
      {/if}
    {/each}

    <!-- Sweep track + fill -->
    <path d={trackPath} fill="none" stroke="#b7bcb8" stroke-width="7" stroke-linecap="round" />
    <path d={fillPath} fill="none" stroke={accent} stroke-width="7" stroke-linecap="round" style="filter: drop-shadow(0 0 3px {accent}99)" />

    <!-- Glass glare -->
    <path d={bezelPath} fill="url(#glass-{uid})" clip-path="url(#clip-{uid})" />

    <!-- Needle -->
    <g class="needle-grp">
      <polygon points={needlePoly} fill={accentDim} stroke="#0a0b0d" stroke-width="0.5" />
      <circle cx={cx} cy={cy} r="6.5" fill="url(#hub-{uid})" stroke="#0a0b0d" stroke-width="0.6" />
      <circle cx={cx - 1.3} cy={cy - 1.8} r="1.4" fill="#fff" opacity="0.75" />
    </g>
  </svg>
  <div class="lcd" style="--accent: {accentDim}">
    <span class="lcd-value">{valueText}</span>{#if unit}<span class="lcd-unit">{unit}</span>{/if}
  </div>
</div>

<style>
  .gauge-widget {
    padding: 8px 8px 9px;
  }
  .gauge-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    line-height: 1.25;
    text-transform: uppercase;
    color: var(--ink-dim, #8b948c);
    margin: 0 0 4px;
  }
  .gauge-svg { width: 100%; height: auto; display: block; }
  .gauge-num { font-family: var(--font-mono, monospace); font-size: 8px; fill: #52585e; }

  .lcd {
    width: 100%;
    justify-content: center;
    margin-top: 6px;
    font-size: 17px;
    font-weight: 400;
  }
  .lcd-unit { font-size: 11px; opacity: 0.75; margin-left: 1px; }

  /* Subtle idle jiggle, like a needle settling against friction */
  .needle-grp {
    transform-origin: 80px 92px;
    animation: needle-jiggle 2.6s ease-in-out infinite;
  }
  @keyframes needle-jiggle {
    0%, 100% { transform: rotate(0deg); }
    25%      { transform: rotate(-1.6deg); }
    75%      { transform: rotate(1.6deg); }
  }

  .gauge-alarm {
    animation: gauge-alarm-ring 1.3s ease-out infinite;
  }
  @keyframes gauge-alarm-ring {
    0%   { box-shadow: 0 7px 18px rgba(0, 0, 0, 0.5), 0 0 0 0 rgba(255, 100, 89, 0.55); }
    70%  { box-shadow: 0 7px 18px rgba(0, 0, 0, 0.5), 0 0 0 7px rgba(255, 100, 89, 0); }
    100% { box-shadow: 0 7px 18px rgba(0, 0, 0, 0.5), 0 0 0 0 rgba(255, 100, 89, 0); }
  }
</style>
