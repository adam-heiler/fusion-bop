# Engineering notes

Background, derivations, sources, and bug-fix history for the physics code.
Code comments are intentionally short; this file has the "why."

## rankineSolver.js

**Critical pressure constant (`PCRIT_PA`)**: 22.064 MPa, IAPWS-95/NIST
(Wagner & Pruß, *J. Phys. Chem. Ref. Data* 31, 387 (2002)). Hoisted to a
constant - previously recomputed every solve via a dummy `PropsSI` call.

**PropsSI memoization (`_qCache`)**: caching on the exact
`(output, name1, val1, name2, val2)` tuple is numerically lossless - every
hit returns the identical value the call would have produced. Profiling one
solve at default sliders showed 508 PropsSI calls, 75 (14.8%) exact repeats
(`profile_solver.py`); cache verified bit-identical (`verify_cache_identical.py`).
Cleared at the top of every solve so it can't grow unbounded.

**minPC / minPG / maxPE** (slider-clamp helpers, let the UI enforce valid
pressure combos without duplicating CoolProp logic client-side):
- `minPC`/`minPG` bisect because the feedwater pump's enthalpy rise doesn't
  invert analytically.
- `minPG` takes the condenser saturation temperature directly rather than
  computing it, because under the Level-3 ε-NTU condenser model, condenser
  pressure is an emergent result of the whole cycle, not a simple ambient
  formula. Caller passes the most recently solved `T6C` (one drag-step
  stale - a good estimate since sliders move incrementally).
- `maxPE`: P_G and P_F can never hit the flashing boundary because their own
  slider maxima (3 bar / 5 bar) never exceed Pcond (5 bar) - only P_E's max
  (8 bar) can. Unlike minPC/minPG this inverts in closed form (Psat is
  monotonic in T): the limit is `Psat(satT(Pcond) + TTD)`.

**wetbulb()**: Stull (2011) single-equation approximation, valid near sea
level. R. Stull, *J. Appl. Meteorol. Climatol.* 50, 2267 (2011).

**State numbering** follows the "v2" renumbering from `rankinecycle_v2.xlsx`:
old state 7 (hotwell) was dropped/merged into new state 6; old states 8-16
shifted down by one to new states 7-15.

**Reheater + extraction mass-flow balance (a, b streams)**:
- Stream a is tapped *before* the HP turbine - a1 is exactly state 1, not a
  bleed expanded down to P_VA (source: `rankinecycle_v2.xlsx`, streams sheet
  "a: extraction before main stream enters hp turbine"; states sheet "a1
  same state as 1"). Flow path: a1 → reheater hot side → Valve A → FWH6 shell.
- Stream b bleeds off *inside* the HP turbine before the HP exhaust reaches
  the reheater, so states 2 and 3 both carry mass flow `m-a-b`, not `m-a`.
  An earlier version charged `m-a` to the reheater cold side, silently
  discarding `b*(h3-h2)` of energy - the whole-plant First Law failed to
  close by exactly that amount (51.49 MW residual, `audit_reheater_balance.py`).
- Because `b = (m-a)*beta` with beta flow-independent, substituting into the
  coupled Reheater+FWH6+M5 balance keeps the solve closed-form (no
  iteration). Full derivation + per-control-volume First Law check (all
  residuals 0.000000 MW) in `validate_v2.py`.

**FWH2/M1 mixer (f stream)**: correct balance is
`(flow_fwh2-f)*h7p + f*h_f3 = flow_fwh2*h8new`. An older version's
denominator was missing the `-h7p` term.

**Condenser (ε-NTU model)**: steam condenses at constant T, so the
heat-capacity-rate ratio Cr → 0 and effectiveness reduces to
`ε = 1 - exp(-NTU)`, `NTU = UA/(ṁ_cw·cp)` (Wikipedia "NTU method" Cmax=∞
special case; standard ε-NTU texts, e.g. Incropera). `Q_cond` depends on P6
(via h5, h6, extraction g, flow_cond) while `ṁ_cw`/`C_cw`/`ε` are fixed per
solve (m is P6-independent) - so this reduces to a scalar fixed point on
`T_cond`. Strong contraction (residual ratio ≈0.03/iteration, converges in
≤2 iterations across a 540-case sweep, `level3_prototype.py`); whole-plant
First Law closes to 0.000000 MW at convergence (`validate_level3.py`). Loop
is bounded (fixed max passes) so it can't hang.

**State 5 (LP exhaust) temperature**: wet steam is isothermal along the
condenser isobar, so T6C is exact and free *in the wet case*. A low enough
`eta_LP` can leave the exhaust superheated (x5 < 0); state 5 then sits above
the dome and needs its own `(P,H)` lookup. This was a real bug - `T5` was
hardcoded to `T6C` unconditionally, so a superheated exhaust point rendered
"floating," at the wrong T, disconnected from both the dome and the actual
condenser curve (which was always built from real point-by-point lookups
and was never wrong itself). Fixed by branching on `x5`.

**2nd law (exergetic) efficiency**: `Ex_sg = m*[(h1-h15) - T0*(s1-s15)]`
(flow-exergy increase across the boiler). The reheater is heated internally
by extraction stream a (working-fluid-to-working-fluid) so it adds no
*external* exergy - stream a was already heated in the boiler as part of m.
An earlier version added a reheat term to `Ex_sg` only, not to `eta_2`'s
denominator, double-counting ~78.7 MW of internal reheat and causing the two
efficiency readouts to disagree (W_net/Ex_sg ≈71.5% vs true eta_2 ≈81.6%,
`diagnose.py`). Fixed by defining `Ex_sg` once and dividing by it for both.

**T-s diagram, turbine expansion paths**: parameterized by entropy, not
enthalpy, to avoid an artifact where the 250-bar isobar's S-curve near the
pseudo-critical region makes entropy decrease mid-segment under linear-h
interpolation. The HP path does not route through the old "A" waypoint -
since a1 = state 1 exactly, `s_A_ex` now equals `s1`, and routing through it
drew a spurious constant-entropy vertical drop (seven points all pinned at
s = 6.1416 kJ/kg·K, caught in `diagnose.py`). B (a genuine on-turbine bleed)
stays as a waypoint.

**FWH shell desuperheat paths**: if extraction steam is already two-phase at
the shell pressure (FWH6's steam, having passed through the reheater +
Valve A, enters wet - h_a3 = 1731.8 kJ/kg < h_g(117 bar) = 2691.9 kJ/kg,
quality ≈0.21, `validate_v2.py`), there's no superheated region to
desuperheat; condensation starts at the entry entropy inside the dome.
Drawing a desuperheat leg anyway would sweep backwards toward the
sat-vapor line.

**Extraction/drain state naming**: X1 = extraction steam entering the FWH
shell (turbine line). X2 = shell drain (subcooled liquid leaving the
shell). X3 = drain after the associated booster pump/valve. The A-stream
has five panel states a1-a5: a1 = state 1; a2 = reheater outlet (~P1, only
Valve A drops pressure between a2 and the FWH6 shell); a3 = Valve A outlet
(isenthalpic, enters shell already two-phase); a4 = shell drain; a5 = after
pump A.

## RankineCycle.svelte

**Pressure ordering** (`enforceOrder` / `getChain` / `enforceTTDBoundaries`):
required chain is P1 > P_VA > P_B > P2 > P_C > P_D > P4 > P_E > P_F > P_G.
Each is a heater/turbine-bleed point along the expansion path; violating the
order is unphysical (a "later" heater would need to heat feedwater to a
lower temp than an earlier one already achieved).

Three boundaries aren't safely covered by plain ordering, because they
border a phase-change vessel with no TTD margin instead of another
TTD-rated heater (every FWH-to-FWH boundary has the *same* TTD subtracted on
both sides, so it cancels out):
- P_C against the deaerator (P_D) - cross it and FWH4's extraction fraction
  (c) goes negative.
- P_G against the condenser - cross it and FWH1's extraction fraction (g)
  goes negative.
- P_E against the condensate pump - cross it and the feedwater flashes to
  vapor inside the FWH3 tubes (see `maxPE()` above). Unlike P_G/P_F (whose
  slider maxima never exceed Pcond), P_E's slider extends past it.

`getChain()` carries each slider's own `[min, max]` alongside its
getter/setter. Without it, a large enough push could compute a "required"
neighbor value outside what that slider can actually display - the
`<input>` silently clamps its displayed value but the JS `$state` variable
doesn't, which used to feed a negative/broken `--pct` (visibly detached
fill) and an unrealistic value into the physics solve. This was a real bug,
fixed by clamping every chain `set()` call to its own bounds.

TTD changes get their own boundary re-check (`onTTDChange`) because a TTD
edit alone can push a pressure out of bounds even when no pressure slider
moved.

`pct()` clamps its output to `[0,100]` defensively: an out-of-range value
visibly detaches the fill from the thumb (browsers silently clamp the CSS
color-stop).

`g3Frac` (LP exhaust quality gauge): x5 < 0 is CoolProp's superheated
sentinel (no quality is defined for single-phase steam) - treated as a
full/best-case reading (fraction = 1) rather than an error.

## Worker offload (rankineSolver.worker.js / solverWorkerClient.js)

The solve is a few hundred synchronous PropsSI calls into WASM, ~300-400ms
total; on the main thread that blocks all repaint/compositing/CSS animation
regardless of how cheap those animations are individually. Moving the
computation into a Worker was the only fix - no amount of CSS-level tuning
helps a main-thread block. `solverWorkerClient.js` is a Promise-based facade
so callers can `await` exactly as if the solver were still synchronous.

## CarnotCycle.svelte

- 1st law efficiency `eta_th = 1 - Tc/Th`: Moran, Shapiro, Boettner &
  Bailey, *Fundamentals of Engineering Thermodynamics*, 8th ed., Ch. 5.3.
- 2nd law (exergetic) efficiency `eta_II = W_net / Ex_in`: Moran et al.,
  Ch. 7 (Exergy Analysis). For a Carnot engine this is identically 100%
  since the cycle is fully reversible (zero exergy destruction) - the
  reference cycle for 2nd-law comparisons (Cengel & Boles, *Thermodynamics:
  An Engineering Approach*, Ch. 8).
- Exergy of heat input `Ex_in = Q_H * (1 - T0/T_H)`, with T0 = T_C: Moran et
  al., Ch. 7.1. Using T_C as the reference environment is the standard
  assumption when no separate ambient temperature is specified.
