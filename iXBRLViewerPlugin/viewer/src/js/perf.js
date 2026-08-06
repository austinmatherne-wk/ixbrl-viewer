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
 *   batchedordered        ticket 02's proposed fix: batched, plus the per-node
 *                         book-keeping that keeps allNodes in the baseline's exact
 *                         order.  batched leaves the same members in a different
 *                         order where _wrapNode returns several nodes; this arm
 *                         does not, so it is the one arm above that could be
 *                         merged.  Measure this, not batched, before claiming a
 *                         payoff for the shipped change.
 *
 * Ticket 06's arms, on the fact-list row path rather than the document walk.
 * factListRow() calls f.isHTMLHidden() once per row, and that reads layout
 * (jQuery ':hidden') and computed style (css('color')) on wrapper nodes inside the
 * *report* iframe, interleaved with the row appends that dirty the inspector
 * document - the same shape of thrash as `none` above, in a second place:
 *
 *   rownohide             the isHTMLHidden() test does not happen at all, so no
 *                         row resolves style or layout.  Against none: the whole
 *                         cost of the test, tag output aside.
 *   rowprehide            an ordering control, not an ablation: every test still
 *                         runs and every tag is still emitted, but a section's
 *                         tests are all resolved before any of its rows is built.
 *                         Against none: what interleaving costs.  Against
 *                         rownohide: what the reads cost once uninterleaved.
 *
 * Ticket 11's arms, on viewer.postProcess() - the forced-layout pass inside the
 * post-load drain, and the third place t05's absolute sub-nodes are paid for:
 *
 *   drainnopass           neither of postProcess()'s two passes runs.  The
 *                         querySelectorAll still happens, so the guard counter
 *                         drain.viewer.containsAbsolute is unchanged.  Against
 *                         none: the whole cost of the viewer's drain pass, which
 *                         is ticket 07's term-2 residual measured directly rather
 *                         than inferred by subtracting a search-index estimate.
 *   drainbatched          an ordering control, not an ablation: pass 2 does every
 *                         read and every write it always did and the same nodes
 *                         end up classed, but the writes are hoisted past all the
 *                         reads.  Against none: what interleaving costs here.
 *                         Sound because every rule keyed on .ixbrl-no-highlight
 *                         sets only background-color, outline or cursor, and each
 *                         sits under an ancestor class (.ixbrl-highlight,
 *                         .ixbrl-related, .ixbrl-selected, :hover) that no node
 *                         carries during the drain - so hoisting the writes cannot
 *                         change a single read's answer.
 *
 * Ticket 12's arms, on _wrapUntaggedNumbers - review mode's tree walk.  The three
 * things inside the walk are the traversal, the regex matcher, and the DOM
 * rewrite, and the rewrite happens for *every* text node whether it matched or
 * not (the loop always builds an output div and always replaceWith()s), so the
 * matched and unmatched rewrites have to be separated too:
 *
 *   untaggedwalkonly      the text-node branch does nothing at all: no match, no
 *                         rewrite.  Against none: everything but the traversal.
 *   untaggednomatch       numberMatchSearch is not called, so no match is found,
 *                         but the unconditional rewrite still happens and the
 *                         text node is still replaced by an identical one.
 *                         Against untaggedwalkonly: the rewrite every text node
 *                         pays regardless.  Against none: the matcher plus the
 *                         span-building its matches drive.
 *   untaggednorewrite     the matcher runs in full - every match, every
 *                         do_not_want and ignoreFullMatch test - but nothing is
 *                         appended and nothing is replaced.  Against
 *                         untaggedwalkonly: the matcher alone.
 *
 * The guard counters, which no untagged arm has any business moving:
 * untagged.textNodes, untagged.elementNodes and untagged.textChars are identical
 * across all four arms, because the walk itself is untouched and replaceWith
 * preserves text content.  untagged.matches is identical on none and
 * untaggednorewrite and zero on the other two, by construction.
 *
 * Confound to report, never to hide: three of these arms leave fewer nodes in the
 * document than the baseline, so viewer.untagged.showChildren - a forced relayout
 * of what the walk just built - gets cheaper on an arm for a reason that is not
 * the ablated statement.  It is a separate span; quote it per arm.
 */
export const ABLATE = new URLSearchParams(window.location.search).get('ixvablate') ?? 'none';

/*
 * ?ixvexpose=1 publishes the viewer's _ixNodeMap on window.IXVPERF so a checker
 * can read each fact's wrapperNodes in order.  Ticket 02 needs it: an ordering
 * change can leave every class in the document exactly where it was and still
 * reorder the jQuery set handed to every consumer of a fact's wrapper nodes, and
 * no DOM signature can see that.  No timing run passes this - holding a live
 * reference to the map would skew the detached-node estimate - so an arm's
 * measured numbers never carry it.
 */
export const EXPOSE = new URLSearchParams(window.location.search).get('ixvexpose') === '1';

/*
 * Named explicitly rather than tested with a bare `else` in the hot loop: ticket
 * 06 found that _findOrCreateWrapperNodeInner's chain ended in an unnamed `else`,
 * so arms belonging to an entirely different code path silently ablated ticket
 * 05's descendant scan as well - a 19-second delta that would have cleared the
 * evidence bar handsomely.  An arm this path does not own resolves to 'none'
 * here, so the loop below stays byte-identical to master for it.
 */
const UNTAGGED_ARMS = ['untaggedwalkonly', 'untaggednomatch', 'untaggednorewrite'];
export const ABLATE_UNTAGGED = UNTAGGED_ARMS.includes(ABLATE) ? ABLATE : 'none';

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

/*
 * A mark that must describe the *first* time its statement is reached rather than
 * the last.  perfMark is last-write-wins, which is right for an end boundary and
 * wrong for a start boundary sitting inside a per-document loop: the phase then
 * covers only the final document while the spans nested inside it accumulate
 * across all of them.  Ticket 12.
 */
export function perfMarkOnce(name) {
    if (ON && state.marks[name] === undefined) {
        perfMark(name);
    }
}

/*
 * The clock, for a span that cannot be a callback because a `yield` sits inside
 * it.  Ticket 11's two drain generators are the case: runGenerator resumes them
 * on setTimeout(0), so a span wrapped round the whole loop would time the other
 * generator's slices and the browser's layout and paint as well as its own work.
 * Accumulate across the slices instead - stop the clock at each yield, restart it
 * on resume, emit one perfAdd() at the end.  Returns 0 when off, so arithmetic on
 * it stays harmless.
 */
export const perfNow = () => (ON ? now() : 0);

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
