// See COPYRIGHT.md for copyright information

/*
 * Startup timing instrumentation.  THROWAWAY - for the startup-slowness
 * investigation (.scratch/startup-slowness, ticket 03) only.  Never merge to
 * master.
 *
 * Everything lands on window.IXVPERF, which the harness in perf-harness/ reads
 * once the load has fully drained.  All times are milliseconds since navigation
 * start, because performance.now()'s time origin *is* nav start - so a mark can
 * be quoted directly against the map's two time windows with no arithmetic.
 *
 * Two levels, chosen with ?ixvperf=:
 *
 *   phase  (default)  Coarse phase and sub-phase spans, plus the total time in
 *                     _findOrCreateWrapperNode.  Nothing inside a per-node walk.
 *   deep              Adds per-fact segment timings and volume counters inside
 *                     the hot wrapper path.  Distorts the very phase it splits,
 *                     so it answers "which statement" (ticket 05) and must not
 *                     be the source of a phase table (ticket 04).
 *   off               No global, no timing calls do any work.
 *
 * The instrumentation must not become the thing it measures, so the rule
 * throughout is: never call into this module from inside a per-node loop.
 * Accumulate into a local integer and emit one perfCount() after the loop.  A
 * span costs two performance.now() calls; on a document with millions of nodes
 * that is only affordable per fact, not per node.
 */

const LEVEL = new URLSearchParams(window.location.search).get('ixvperf') ?? 'phase';

const ON = LEVEL !== 'off';
export const PERF_DEEP = ON && LEVEL === 'deep';

/*
 * Ablation arm, chosen with ?ixvablate= (ticket 05).  ABLATED BUILDS CHANGE
 * BEHAVIOUR AND MUST NEVER BE MERGED.
 *
 * Ticket 05 has to attribute _findOrCreateWrapperNode's descendant scan to a
 * statement, and the map's evidence bar wants an ablation delta larger than the
 * measured spread.  Selecting the arm at *runtime* off a URL parameter rather
 * than building a branch per ablation means every arm is the same bundle bytes,
 * so a delta cannot be a build-to-build difference - and the harness can
 * alternate all four arms inside one session, which is the strongest pairing
 * available.
 *
 *   none       (default)  unablated.  The inner loop is byte-identical to master.
 *   noscan                the descendant scan does not happen at all.
 *   nostyle               querySelectorAll and the walk happen; no style is
 *                         resolved.  Against noscan: the traversal's own cost.
 *   styleonly             the walk and getComputedStyle happen, but the result is
 *                         discarded, so no sub-element is classed or collected.
 *                         Against nostyle: forced style resolution alone, with
 *                         all downstream work held constant.  Against none: what
 *                         the collected sub-elements cost everything after.
 *   batched               an ordering control rather than an ablation: every read
 *                         and write the baseline does still happens and the output
 *                         is the same, but all style is resolved before any class
 *                         is applied.  Against none: what the baseline pays purely
 *                         for interleaving its style writes with its style reads.
 */
export const ABLATE = new URLSearchParams(window.location.search).get('ixvablate') ?? 'none';

const now = () => performance.now();

/* Both post-load passes must finish before the load counts as drained. */
const DRAIN_KEYS = ['viewer.postLoadAsync.end', 'inspector.postLoadAsync.end'];

const state = {
    level: LEVEL,
    /* Which ablation arm produced this run, so a JSON of results is
     * self-describing and an arm can never be mistaken for a baseline. */
    ablate: ABLATE,
    /* name -> ms since nav start.  Last write wins; anything that happens more
     * than once belongs in spans, not here. */
    marks: {},
    /* name -> { ms, n }: accumulated wall time and call count. */
    spans: {},
    /* name -> number: volumes, not times. */
    counts: {},
    /* name -> usedJSHeapSize at the moment of the like-named mark.  Sampled here
     * rather than over CDP because CDP's renderer-side handlers queue behind a
     * blocked main thread, and this load blocks it for tens of seconds at a
     * stretch.  The cost is peak-at-phase-boundary, not a continuous peak: a
     * spike that rises and falls inside one phase is invisible. */
    heap: {},
    /* Free-form per-run detail, e.g. the per-section row cost table. */
    detail: {},
    /* True once drained *and* two frames have passed, so layout and paint of
     * whatever the last pass built are included. */
    done: false,
};

if (ON) {
    window.IXVPERF = state;
}

const open = {};

export function perfMark(name) {
    if (ON) {
        state.marks[name] = now();
        if (performance.memory !== undefined) {
            state.heap[name] = performance.memory.usedJSHeapSize;
        }
    }
}

/* Accumulate an already-measured duration. */
export function perfAdd(name, ms) {
    if (ON) {
        const s = state.spans[name] ??= { ms: 0, n: 0 };
        s.ms += ms;
        s.n++;
    }
}

/* Time a synchronous call.  Returns whatever fn returns. */
export function perfSpan(name, fn) {
    if (!ON) {
        return fn();
    }
    const t = now();
    try {
        return fn();
    }
    finally {
        perfAdd(name, now() - t);
    }
}

/* For a span that crosses a promise or a timer, and so cannot be a callback. */
export function perfOpen(name) {
    if (ON) {
        open[name] = now();
    }
}

export function perfClose(name) {
    if (ON && open[name] !== undefined) {
        perfAdd(name, now() - open[name]);
        delete open[name];
    }
}

/* A volume, not a duration.  Call once per loop, never once per iteration. */
export function perfCount(name, n = 1) {
    if (ON) {
        state.counts[name] = (state.counts[name] ?? 0) + n;
    }
}

export function perfDetail(name, value) {
    if (ON) {
        state.detail[name] = value;
    }
}

export function perfPush(name, value) {
    if (ON) {
        (state.detail[name] ??= []).push(value);
    }
}

/* deep-level variants: no-ops at phase level, so the hot path pays one
 * already-loaded boolean test rather than a function call's worth of work. */
export const perfDeepAdd = (name, ms) => { if (PERF_DEEP) perfAdd(name, ms); };
export const perfDeepCount = (name, n = 1) => { if (PERF_DEEP) perfCount(name, n); };
export const perfDeepNow = () => (PERF_DEEP ? now() : 0);

/*
 * Wrap one of the post-load generators so its completion is observable.  The
 * viewer has no external signal for "fully drained" - postLoadAsync() returns
 * immediately and the work continues across setTimeout slices - so this is the
 * only way the second time window can be measured at all.
 */
export function* perfWatchGenerator(gen, name) {
    yield* gen;
    perfMark(name);
    perfDrainCheck();
}

export function perfDrainCheck() {
    if (!ON || state.done || state.marks.drained !== undefined) {
        return;
    }
    if (!DRAIN_KEYS.every(k => state.marks[k] !== undefined)) {
        return;
    }
    perfMark('drained');
    /* Double rAF: the first callback runs before layout of the frame it is
     * scheduled in, the second after it has been committed.  JS-only marks
     * under-report by ~30% on some filings for exactly this reason. */
    requestAnimationFrame(() => requestAnimationFrame(() => {
        perfMark('drainedFrame');
        state.done = true;
    }));
}

/* Called when the loader is removed - the first of the two time windows. */
export function perfLoaderRemoved() {
    if (!ON) {
        return;
    }
    perfMark('loaderRemoved');
    requestAnimationFrame(() => requestAnimationFrame(() => {
        perfMark('loaderRemovedFrame');
    }));
}
