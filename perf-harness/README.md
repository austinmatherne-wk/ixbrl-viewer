# Phase-instrumented startup harness

THROWAWAY. Built for the startup-slowness investigation
(`.scratch/startup-slowness`, ticket 03) and **never to be merged to `master`**.

Four pieces:

- `iXBRLViewerPlugin/viewer/src/js/perf.js` — instrumentation compiled into the
  viewer bundle. Publishes everything on `window.IXVPERF`.
- `perf-harness/measure-phases.js` — the driver: runs fixtures, tiers, arms and
  repetitions, and writes one JSON file.
- `perf-harness/report-phases.js` — reshapes one or more of those JSON files into
  the ticket-04 markdown tables. Reads only; re-measures nothing.
- `perf-harness/frame-lag.js` — the paired-arm comparison of the one window where
  the baseline branch and `master` differ, done as a within-run difference. See
  [Paired two-build runs](#paired-two-build-runs).

## Quick start

```bash
npm run font && npm run dev          # font first: without it the bundle ships
                                     # with no stylesheet and every layout,
                                     # paint and first-frame number is wrong

FIXTURE_ROOT=/path/to/.scratch/startup-slowness \
  node perf-harness/measure-phases.js aviva-2025
```

`FIXTURE_ROOT` defaults to `<repo>/.scratch/startup-slowness`. In a git worktree
that is *not* where the corpus lives, so pass it explicitly.

With no fixture arguments every directory under `FIXTURE_ROOT` holding a
`fixture.json` is measured, in slug order.

## Env

| var | default | meaning |
|---|---|---|
| `RUNS` | `5` | runs per (fixture, tier, arm). 5 is the map's evidence bar. |
| `TIERS` | `1,4` | CPU throttle tiers. A phase that does not scale with the tier is not CPU-bound. |
| `LEVEL` | `phase` | `phase`, `deep` or `off` — see below. |
| `REVIEW` | — | `1` loads with `?review=1`, so the untagged-numbers phase runs. |
| `CONTROL` | — | path to a second checkout with a built `dist/`, measured as a paired arm on `PORT+1`. |
| `CONTROL_INSTRUMENTED` | — | `1` if the control build also has `perf.js`. |
| `PROFILE` | — | `1` writes a `.cpuprofile` for run 0 of each arm. |
| `PORT` | `8910` | first port; loopback only, deliberately. |
| `OUT` | `perf-harness/out/phases-<stamp>.json` | machine-readable output. |
| `HEADFUL` | — | `1` for a visible browser. Debugging only; it changes the timings. |

## Levels

- **`phase`** — coarse phase and sub-phase spans, plus the *total* time in
  `_findOrCreateWrapperNode`. Nothing is called from inside a per-node walk.
  **This is the level a phase table comes from** (ticket 04).
- **`deep`** — adds per-fact segment timings and volume counters inside the
  wrapper hot path: which of the enclosing-cell test, the wrap, or the
  descendant scan spends the time (ticket 05). It measurably slows the very
  phase it splits, so its absolute totals are not baseline numbers.
- **`off`** — no global, and every timing call is a no-op. Useful as a
  same-build control for instrumentation overhead.

## What comes out

`marks` are milliseconds since navigation start (`performance.now()`'s time
origin is nav start, so no arithmetic is needed to quote them). `spans` are
`{ms, n}` accumulated wall time and call count. `counts` are volumes.

### The two windows

Reported separately, always, with the frame each one's layout and paint landed on:

| key | meaning |
|---|---|
| `windows.toLoaderRemoved` | nav start → `$('#ixv .loader').remove()`. Comparable with prior numbers from the older harness. |
| `windows.toLoaderRemovedFrame` | the second rAF after that — what the user actually sees. |
| `windows.toDrained` | nav start → both `viewer.postLoadAsync()` and `inspector.postLoadAsync()` complete. |
| `windows.toDrainedFrame` | the second rAF after that. |
| `windows.drainGap` | `toDrained − toLoaderRemoved`. The map treats this gap as a finding in its own right. |
| `external.loaderRemoved` | the same instant, timed by a `MutationObserver` the harness injects. **This is the only number comparable across arms**, because it does not depend on the build being instrumented. |

### Phase marks

`phase.loading.{start,end}`, `phase.preProcess.{start,end}`,
`phase.untagged.{start,end}` (review mode only), `phase.prepare.{start,end}`,
`phase.inspectorInit.{start,end}` — the five `setProgress` boundaries that
already existed in the source.

### Notable spans and counters

| name | note |
|---|---|
| `viewer.findOrCreateWrapperNode` | the headline suspect: 22.4s of 25.3s of self time in one profile. `n` is the call count. |
| `fcwn.cellTest` / `fcwn.wrapNode` / `fcwn.subNodeScan` | `deep` only: the three segments of it. |
| `fcwn.subNodesScanned` | `deep` only: one `getComputedStyle` per scanned descendant. |
| `wrapNode.displayTests` | `deep` only: one `getComputedStyle` per descendant, again. |
| `viewer.preProcessiXBRL` | one span per *document*, never per node. |
| `continuationMaps.elementsWalked` | the size of `find("body *")`'s full-DOM walk. |
| `taxonomyData.read` / `taxonomyData.parse` | metadata reaches 47MB on this corpus, so these are timed apart. |
| `inspector.factListRows` | row building, broken out of `inspector.buildFactListByGroup`. |
| `detail.factListRowsPerSection` | `[rowsBuilt, ms]` per section in build order — for the ~3x-between-sections lead. |
| `setProgress.wait` | pure waiting: two frames per call, five calls in review mode. |
| `iframePoll.ticks` | 250ms poll ticks spent waiting for the source report. |

### Memory and DOM

- `heap.<mark>` — `usedJSHeapSize` at each mark, and `peakHeapAtMarks` over them.
  Sampled **in-page**, because CDP's renderer-side handlers queue behind a main
  thread this load blocks for tens of seconds at a time. So it is a
  peak-at-phase-boundary: a spike that rises and falls inside one phase is
  invisible.
- `metricsAtLoaderRemoved.*` and `metrics.*` — CDP `Performance.getMetrics`:
  `Nodes`, `LayoutCount`, `RecalcStyleCount`, `LayoutDuration`,
  `RecalcStyleDuration`, `ScriptDuration`, `TaskDuration`. The two `Duration`s are
  the only view here of time spent *not* in JS, and on this corpus they are where
  most of the time is.

  These counters are **cumulative for the page's whole life**, so a read is only
  meaningful next to another read taken at the same point. That is why there are
  two: `metricsAtLoaderRemoved` at the first window on every arm, `metrics` at the
  end. **Compare arms only at `metricsAtLoaderRemoved`** — the control arm has no
  drain signal to wait for, so its `metrics` stops a whole phase earlier than the
  instrumented arm's and a naive comparison shows a difference that is purely the
  stopping point. The difference between the two reads on the instrumented arm is
  the post-load passes' own share.
- `metricsAfterGC.*`, `liveAfterGC.*`, `detachedNodesEstimate` — after a forced
  collection. The estimate is `Nodes` minus a full `TreeWalker` count over the
  viewer document and every report iframe; read its trend, not its absolute value.

## Paired two-build runs

`CONTROL=<repo>` measures a second build of the *same* fixture in the *same*
session, alternating runs arm by arm so that a machine drifting mid-session
drifts both arms equally. Neither checkout's `dist/` is touched and none of the
corpus's ~600MB of source documents is copied: each arm gets a temporary tree of
symlinks with only `ixbrlviewer.dev.js` pointed at its own build, served on its
own port.

Alternating the arms is necessary but not sufficient. `external.loaderRemoved` is
an *absolute* time, so its run-to-run spread is the whole page load's — ±90ms on
a 780ms fixture, which is far wider than the effect a two-build comparison is
usually looking for. Ticket 04 had to compare the interval between loader removal
and the frame after it, which is a **within-run** difference and so cancels the
common movement both arms share: it cut the spread from ±90ms to ±12ms and turned
an unresolvable delta into a resolved one. `frame-lag.js` is that comparison.
Reach for a within-run interval before concluding a paired comparison is
inconclusive.

## The phase table

`report-phases.js` holds the startup timeline as a `PHASES` list, and that list is
a **complete partition** of nav start → drained: on this corpus every phase table
it prints closes to a residual of `0±0`. The five `setProgress` phases in the
source do not tile the window on their own — the browser's own parse of the host
document sits before the first of them, and three gaps sit between them, one of
which (`preProcess.end → prepare.start`) is a `setProgress` double-rAF wait worth
up to 117ms. A boundary may be a list of candidate marks, first present wins,
which is how one row tiles both review and non-review mode.

Phase durations are computed **per run and only then reduced to a median**.
Differencing the medians of two boundary marks looks equivalent and is not: those
marks are absolute times carrying the whole run's variance, and on an 80ms phase
inside a window that itself moves ±75ms it printed a phase *shorter than a span
nested inside it*. A within-run difference cancels that, and it is the only form
that can carry a spread at all.

## Rules this harness exists to enforce

- **Never quote a single run.** Every metric comes out as median, min, max,
  spread and n.
- **Never compare across sessions.** This machine measured 2% slower than it had
  the day before, which is enough to invent a regression. Any comparative claim
  needs a paired same-session control arm.
- **Never source a phase table from `LEVEL=deep`.**
- **Never call into `perf.js` from inside a per-node loop.** Accumulate in a
  local integer and emit one `perfCount()` after the loop. The instrumentation
  must not become the thing it measures.
