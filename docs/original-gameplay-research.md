# Original gameplay profile — research only

Researched 10 October 2026. No application code was changed.

The reference is Markus Mächler’s [achtungkurve.com](https://achtungkurve.com/), which identifies itself as **v1.5.1**, and [maechler/kurve at commit 02702ad86319c22e28ab5cc2038ba39a4ba722a9](https://github.com/maechler/kurve/tree/02702ad86319c22e28ab5cc2038ba39a4ba722a9). GitHub’s comparison reports the current main branch identical to that tag. The live public JavaScript bundle was read directly: the base configuration, gap formulas, timer, initialization and spawn rules agree with the tagged source.

Your [deployed game](https://achtung-die-kurve.onrender.com/) was inspected in the browser. Its fresh lobby showed Recommended 1440 × 960, Classic speed, Classic score, Large gaps, gaps enabled, and six disabled players with no superpower. Detailed engine comparisons below come from the current local working tree; a deployed engine revision was not established.

**Proposed startup profile**

Use the original gameplay rules, with your existing map configuration preserved. The following is a specification for the next step, not an implemented profile.

| Property | Original target | Current local comparison |
|---|---|---|
| Map | Keep your map settings. Fresh startup currently uses Recommended 1440 × 960, custom scale 100%. | Intentional exception. Do not import the original viewport-sized arena. |
| Movement | 1.4 coordinate pixels per ordinary frame. Nominal 84 units/s at 60 frames/s. | Normal/Classic already uses 84 units/s. |
| Turning sensitivity | 0.035 radians per ordinary movement step, about 2.005°; nominal 2.1 rad/s or 120.32°/s. Turn before moving. | Nominal base values and order already match. |
| Turn radius | 40.002 coordinate units for the exact discrete circular path, approximately 40. | Already matches ordinary movement. |
| Trail width | 4 coordinate pixels. | Already 4 world units. |
| Player endpoint visibility | Original draws a radius-2 starting dot and ordinary 4-pixel trail; it does not draw a separate large moving head. During a natural gap there is no moving head marker. | Yours draws a live radius-5 head and radius-9 gap/power ring. |
| Natural gap duration | Exactly 8 omitted movement segments, 11.2 units of base travel. Nominal 133⅓ ms. | Default is 24 ticks, 33.6 units and 400 ms: three times the missing travel. Existing Small setting is 8 ticks. |
| Natural gap frequency | Countdown reset is 150 + round(random × 300), inclusive 150–450. Detailed first/subsequent timing below. | Uses floor, 150–449, and schedules from gap start rather than from the end. |
| Self-trail collision grace | Ignore own trail only while its age is less than 5 frames; collision starts at age 5. | Ignores through age 8; collision starts at age 9. |
| Spawn | Random coordinates within 80-pixel borders; integer rounding; random heading across the full circle. | Same border margin, but spacing rejection and heading biased toward center. |
| Countdown | 3000 ms before movement. Simulation frames do not advance during countdown. | 180 advancing ticks before movement. |
| Score target | (number of players − 1) × 10. | Classic score already matches. |
| Default power | No superpower; all six slots initially inactive. | Fresh startup already matches. |
| Usable power charges | Initial 2, maximum 6; directly selected None and Chuck Norris stay at 0. | Initial/cap mostly match; None/Chuck internally start at 2 but are unusable. |

Original sources: [configuration](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveConfig.js#L35-L73), [movement/gaps](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveCurve.js#L85-L141), [drawing](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveField.js#L126-L152), [self-trail grace and steering](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveCurve.js#L198-L242), [spawn](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveField.js#L256-L262).

The settings already available can express the configuration part: preserve map selection and scale, normal speed, target score 0 (Classic formula), gaps enabled, Small gaps (8), and custom gap fallback 8. No named gameplay profile system currently exists. Sensitivity, width, collision geometry, spawn direction, gap scheduling and detailed power rules are engine behavior; changing defaults alone would leave those differences.

**Exact gap behavior**

Let H = 150 + Math.round(random × 300).

- On initial construction, countdown H through 0 draws H + 1 solid segments. The first missing segment is movement frame H + 2: frame 152–452.
- Countdown −1 through −8 produces exactly eight missing segments. The eighth resets the countdown to a newly sampled value N, then decrements it.
- Consequently later solid stretches last N frames, and successive gap starts are N + 8 frames apart: 158–458.
- The rounded distribution gives the endpoints 150 and 450 half the probability of an interior value. It is not the current uniform floor-based distribution.
- Curves survive round transitions. Their hole countdown is not reset or rerandomized when the next round starts.
- A regular gap omits new trail segments and creates a collectible power-up path. The player still collides with walls and existing trails.
- Under Run faster, the original performs two movement/drawing calls per game frame. Its gap countdown advances twice as fast; a gap still omits eight 1.4-unit segments, rather than eight doubled-distance movements.

Current scheduling chooses 150–449 ticks between gap starts, resets for each round, and does not speed up the countdown under boost. Even after choosing Small gaps, these rules need changes for parity. [Original countdown](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveCurve.js#L105-L122), [random reset](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveCurve.js#L240-L242), [round initialization](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveGame.js#L189-L238), [boost](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveSuperpowerconfig.js#L53-L97).

Eight segments describe omitted travel, not a guaranteed visibly clear or traversable 11.2-pixel opening. Stroke ends, approach angle and collision sampling also affect passage.

**Timing and coordinate scale**

The configuration says 60 fps, but the original timer is Math.round(1000 / 60) = **17 ms**, and each timer event queues requestAnimationFrame. Its fixed frame constants are authoritative; real elapsed time depends on browser scheduling. With an ideal 17-ms timer, base travel is 82.35294 px/s, turning is 2.05882 rad/s, and an eight-frame gap lasts 136 ms. At an exact 60-Hz simulation the familiar equivalents are 84, 2.1 and 133⅓ ms. These are derived values, not physical browser measurements. [Original timer](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveGame.js#L46-L65), [interval start](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveGame.js#L201-L209).

Your server uses a 60-Hz elapsed-time accumulator and broadcasts ordinary frames at 20 Hz. Exact source-frame behavior and the original timer’s wall-clock pace are separate implementation concerns. A claim of identical real-time play requires validating the scheduler and prediction together; the original’s browser-dependent delays cannot be guaranteed across all hardware.

Original coordinates are viewport pixels: arena width is 70% of the browser width, height is the full browser height. Speed, turning, trail width and power ranges have no hidden map multiplier. Your renderer scales world coordinates to the displayed canvas. Thus matching world constants can still yield different screen-pixel speed/thickness on differently sized canvases. Preserve map dimensions as requested, and compare behavior at a documented display scale. [Original resize](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveField.js#L94-L110).

**Collision and spawning fidelity**

The original stores rounded, one-pixel trail centerlines. It samples the swept movement path, then checks each sample’s 3 × 3 surrounding pixels. Its interpolation excludes the exact end point. Rendered thickness is independent of this geometry; a 4-pixel visible line is not a circular 2-pixel collision radius. Walls collide when a tested surrounding pixel is at or beyond coordinate 0 or the field width/height. Yours rasterizes radius-2 sweeps into a 2-unit grid and uses a 2-unit wall inset. [Original collision](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveCurve.js#L143-L212), [surroundings and bounds](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveField.js#L225-L280), [interpolation](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveUtility.js#L69-L92).

Original curves move, collide and draw sequentially in player order. It has no separate simultaneous head-versus-head sweep. Your implementation computes candidates, explicitly checks head sweeps, and kills simultaneous victims together. This changes some close encounters and score ties. Literal source parity includes the original ordering quirks; it should not be described as merely adjusting player size.

Original starting positions have no minimum player separation, and headings are uniformly random. Yours retries positions for more than 75 units separation, then points players toward the center with ±0.5 radians jitter. These are deliberate local differences, but not original behavior. [Original per-frame order](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveGame.js#L58-L65), [heading](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveCurve.js#L220-L229).

**Complete power reference**

Durations below are configured frame budgets and nominal seconds at 60 fps. Exact application depends on hook order and closing calls.

| Original name / local ID | Original gameplay rule | Current differences to account for |
|---|---|---|
| Run faster / boost | 240-frame budget (4 s); a second complete move/check/draw per game frame doubles travel, turning and hole-countdown rate. | Doubles velocity/turn rate in one move; hole countdown remains ordinary. Original also performs the extra move on its closing invocation. |
| Run slower / slow | 360-frame budget (6 s); halves saved step length, keeps turning rate, then restores speed. | Broad effect matches; activation takes effect at a different point in the frame. |
| Jump / jump | Forward teleport of 24 × current step length; default distance 33.6. No trail along the teleport path. | Fixed 33.6 at all speed presets; hook timing differs. |
| Invisible / shield | 240 draw-hook budget (4 s); hides trail and bypasses collisions including walls once active. Natural gap paths can still be recorded. | Immediate input-side activation differs from original collision-before-draw activation. |
| Vertical bar / bar | Perpendicular bar of 100 total units (±50), width 4, centered on currentPosition. | Dimensions match; original current/next-position distinction can shift placement by one step. |
| Cross walls / wrap | Passive; charge per crossing; translates by the full arena dimension; collision/pickup checks suppressed during the crossing phase. | Wraps inside a 2-unit inset and immediately checks destination trails. |
| Dark knight / dark | 180-frame budget (3 s); opaque field blackout while play continues. | Holding the key can repeat it in the original; local requires release. |
| Hydra / hydra | Doubles all living curves of the player; fixed ±π/20 branches (18° separation); pair-specific immunity for 10 collision checks. | Adaptive spread, broader owner immunity, dynamic grace, max16 heads/player and256 globally. Original has no explicit head cap. |
| Reverse / reverse | Swaps with the remembered opposite endpoint; initially spawn with heading +π; immediately performs another move; own-curve immunity for10 collision checks. | Immunity covers all curves of the owner; immediate movement/activation differs. |
| Square head / square | 360-frame budget (6 s); snaps to cardinal heading; a fresh steering direction yields90° turns, holding does not repeat; right wins if both keys held. | Local turns at input time, original schedules angle change through the next movement; both keys cancel locally. |
| Chuck Norris / chuck | Uses the theme’s neutral/deathmatch color as a visibility handicap. Ordinary collisions; no invulnerability or usable charges. | Local uses white; exact original camouflage depends on field theme. |
| No superpower / none | No effect and no usable charges. | Fresh selection matches; internal local charge count differs. |
| Shoot holes / holes | Clears60 units forward from nextPosition; visible eraser width8. Collision clearing applies a5 × 5 pixel neighborhood around each centerline sample. | Visible size matches; local grid-based collision erasure differs. |
| Random / random | Rerolls per round uniformly among the13 other entries, including None/Chuck. | Broad selection matches; charge bonuses differ when None/Chuck is rolled. |

Pinned sources for the table: [fast/slow/jump](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveSuperpowerconfig.js#L53-L188), [invisible/bar/wrap](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveSuperpowerconfig.js#L190-L389), [dark/Hydra/reverse](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveSuperpowerconfig.js#L391-L556), [square/Chuck/None/shoot/random](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveSuperpowerconfig.js#L558-L738), [collision erasure](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveField.js#L155-L187).

Jump, bar, Hydra, reverse and shooting cost one charge per press and require release before reuse. Timed abilities continue after release; a held key can spend another charge after expiry. There is no additional configured cooldown. Most powers act after ordinary movement/check/draw; Invisible uses collision and draw hooks. Counters generally close on the call after reaching zero. For example, boost makes an extra movement on241 hook invocations for a240-frame budget, and Invisible marks the closing draw invisible. Replacing these with rounded second-based timers would miss boundary behavior. [Hook order](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveCurve.js#L85-L122), [activation eligibility](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveCurve.js#L232-L237).

**Charges, scoring, rounds and controls**

Crossing another curve’s natural gap earns one charge, up to6, without consuming that gap. Original detection follows the rounded centerline trace and uses a5-frame timeout per curve; Hydra sibling gaps qualify. Local pickup detection checks the endpoint’s grid cell, excludes every same-owner gap, and shares a timeout across the owner. Original early collision-hook exits during invisibility or wall crossing also skip pickup checks. [Gap pickup](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveCurve.js#L143-L195).

At round end, two-player games replenish1 each. With3+ players, the original sorts by descending total score, skips exactly the first player, adds1 to everyone else, then adds1 extra to exactly the final player. Tied leaders/losers are handled by sorted position. Local rules apply bonuses to all tied scores differently. Random keeps its RANDOM charge identity even after rolling None/Chuck: it can receive round bonuses in those rounds, while gap collection remains blocked. [Original replenishment](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveGame.js#L142-L162), [round bonuses](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveGame.js#L241-L256), [charge exclusions](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveSuperpower.js#L27-L50).

Each surviving player gains1 when another player loses their last curve. The round ends when only one player remains. One player at/above target wins; multiple qualified players enter a deathmatch involving those players. These broad rules already match, with differences caused by simultaneous death handling. Space starts rounds and pauses/resumes play in the original; your host/room flow adds intermediate controls. Original pause freezes movement and counters but preserves key state; yours clears controls. [Original round/scoring rules](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveGame.js#L75-L129), [death handling](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveGame.js#L165-L238), [deathmatch](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveGame.js#L259-L294).

Original keyboard defaults already match your fresh slots, in left/right/power order: Red1/Q/A; Orange←/↓/→; GreenY/X/C; BlueB/N/M; PurpleL/O/P; Pink5/6/7. Gameplay steering differs only when both directions are held: original turns right, local goes straight. Original uses keyCode while local uses physical KeyboardEvent.code and treatsY/Z as one control; keyboard-layout behavior therefore is not completely identical. [Original controls](https://github.com/maechler/kurve/blob/v1.5.1/src/KurveConfig.js#L66-L73).

The original supports2–6 players sharing a keyboard. Your networked rooms, up to50 players and room scaling have no original equivalent. Preserve those existing capabilities; validate original gameplay rules primarily with2–6 players. Exact network responsiveness cannot equal a game with no server round trip.

**Local implementation reach for the next step**

This is a map of affected code, not authorization to edit it now.

| Area | Existing locations |
|---|---|
| Startup/room defaults and slot persistence | [App.tsx](<C:/Users/damia/OneDrive/Desktop/html web/achtung-die-kurve/src/App.tsx>), [game.ts](<C:/Users/damia/OneDrive/Desktop/html web/achtung-die-kurve/server/game.ts>) |
| Settings shape and trusted input validation | [types.ts](<C:/Users/damia/OneDrive/Desktop/html web/achtung-die-kurve/shared/types.ts>), [app.ts](<C:/Users/damia/OneDrive/Desktop/html web/achtung-die-kurve/server/app.ts>) |
| Gaps, collisions, spawns, charges, scoring and powers | [game.ts](<C:/Users/damia/OneDrive/Desktop/html web/achtung-die-kurve/server/game.ts>) |
| Shared movement and steering input | [movement.ts](<C:/Users/damia/OneDrive/Desktop/html web/achtung-die-kurve/shared/movement.ts>), [controls.ts](<C:/Users/damia/OneDrive/Desktop/html web/achtung-die-kurve/src/controls.ts>) |
| Trail/head visibility and world scaling | [GameCanvas.tsx](<C:/Users/damia/OneDrive/Desktop/html web/achtung-die-kurve/src/GameCanvas.tsx>) |
| Motion prediction, border behavior and timing | [prediction.ts](<C:/Users/damia/OneDrive/Desktop/html web/achtung-die-kurve/src/prediction.ts>) |
| Map exception to preserve | [map-size.ts](<C:/Users/damia/OneDrive/Desktop/html web/achtung-die-kurve/shared/map-size.ts>), map constants in [types.ts](<C:/Users/damia/OneDrive/Desktop/html web/achtung-die-kurve/shared/types.ts>) |
| Existing verification to update if behavior changes | server-game, server-network, client-app, client-canvas, client and prediction tests |

No new dependency or broad profile framework is required to research or express the startup defaults. A future Original preset must be backed by the engine rules it claims to select.

**Verification and remaining limits**

Source-backed values are high confidence. Independent in-memory assertions verified original movement magnitude, right-key precedence, eight gap segments, first gap frames152/302/452, later onset separations158/308/458 and own-trail collision at age5. The live original bundle’s core constants/formulas were checked against tagged source; the whole bundle was not rebuilt for a byte-for-byte comparison.

No production room was created, no code/build/test fixture was changed, and no implementation tests were run. Physical browser timing, side-by-side full-match play, overlapping blackout powers and50-player parity were not benchmarked. The next step needs focused tests for the identified differences before claiming original gameplay parity.

