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
 *   rowdefer              ticket 24's proposed fix, and the arm to measure before
 *                         claiming its payoff.  Neither an ablation nor a
 *                         reordering: the test still runs for every row and every
 *                         tag is still emitted, but not until the row's container
 *                         is first shown - a collapsed outline section being
 *                         expanded, or the search pane becoming the active pane.
 *                         Nothing is shown during startup, so within both windows
 *                         it should land where rownohide does; against rownohide
 *                         it prices the difference between relocating the test and
 *                         deleting it.  It carries ticket 08's rider too: the
 *                         ':hidden' test filters .ixbrl-contains-absolute rather
 *                         than .ixbrl-no-highlight (see HTML_HIDDEN_FILTER), which
 *                         is inert at startup on this arm because no row tests
 *                         anything there, and leaves `none` byte-identical to
 *                         master.
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
 * Ticket 07's arms.  drainnopass above is NOT the arm that models ticket 07's
 * change: it removes both passes, so its delta is the whole viewer drain pass.
 * Deleting pass 1 alone leaves pass 2 as the first reader of the document's
 * layout, inheriting the flush pass 1 used to pay for, so the payoff has to be
 * measured with pass 2 still running:
 *
 *   drainnopass1          pass 1 does not run; pass 2 is byte-identical to the
 *                         baseline's.  This is the candidate change.  Against
 *                         none: what deleting pass 1 actually buys.  Against
 *                         drainnopass: what pass 2 still costs once it is first.
 *   drainnopass1fonts     drainnopass1, plus ticket 06's first candidate
 *                         precondition: wait for the report document's
 *                         fonts.ready before pass 2 reads anything.  Against
 *                         drainnopass1: whether unloaded fonts are what pass 1
 *                         was really buying time for.  drain.viewer.fontsWait
 *                         and .fontsWaitYields price the wait itself.
 *   drainbatchednopass1   the only arm that combines two tickets': ticket 03's
 *                         batched pass 2 with pass 1 deleted.  ABLATE holds one
 *                         arm at a time, and the question ticket 07 has to answer
 *                         is what deleting pass 1 is worth in the world where
 *                         ticket 03 ships - where pass 2 no longer dirties style
 *                         between its own reads.  Against drainbatched: the
 *                         payoff of ticket 07's change on ticket 03's tip.
 *
 * drain.viewer.noHighlight is a GUARD for every other drain arm and a FINDING for
 * these two: ticket 06 established that pass 1 buys elapsed time rather than a
 * second immediate read, so removing it may legitimately leave elements
 * measuring zero that previously measured non-zero.  These arms are entitled to
 * move that counter and the ticket must report by how much.  pass1Layout goes to
 * zero on both by construction, and is emitted as an explicit zero rather than
 * left missing.  drain.viewer.containsAbsolute remains a true guard on all arms.
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

/*
 * Ticket 04's arms, on runGenerator itself - the scheduling between the two drain
 * generators' slices rather than inside either of them.  None of these is an
 * ablation: every slice still runs, in the same order, doing the same work.  What
 * changes is how the resume is posted and how many slices one post buys.
 *
 * Two independent factors, so the four arms are a 2x2 and each factor can be
 * priced on its own:
 *
 *   yieldmsg        the resume is posted through a MessageChannel instead of
 *                   setTimeout(0).  Still a task, so the event loop still gets its
 *                   turn between slices, but a message task carries no nesting
 *                   level and so no 4ms clamp.  Against none: the clamp alone,
 *                   with the slice count held fixed.
 *   yieldbudget     the resume is still a setTimeout(0), but one resume drains
 *                   generator slices until YIELD_BUDGET_MS is spent instead of
 *                   exactly one.  Against none: what fewer, fatter slices are
 *                   worth with the clamp left in place.  Does nothing on a fixture
 *                   whose slices already exceed the budget.
 *   yieldboth       both.  This is the shape ticket 04 proposes to ship, so it is
 *                   the arm whose delta may be quoted as the payoff.
 *   yieldsched      yieldboth with scheduler.yield() in place of the
 *                   MessageChannel.  The purpose-built primitive, and unlike a
 *                   message task its continuation is prioritised ahead of ordinary
 *                   tasks.  Chrome 129+ only, so it is measured to find out
 *                   whether shipping a feature-detected fast path is worth the
 *                   branch - not because it could be the only implementation.
 *
 * The guard counters, which no arm here has any business moving, because none of
 * them touches a generator's body: drain.viewer.yields and drain.search.yields
 * (the `yield` statements actually executed), drain.viewer.containsAbsolute,
 * drain.viewer.pass1Layout, drain.viewer.noHighlight, drain.search.factCount and
 * drain.search.docsBuilt.  A budget arm changes how many *resumes* those yields
 * are spread over, never how many there are.
 *
 * sched.hops.<label> is the mechanism counter rather than a guard: it is the
 * number of posted resumes, so it is unchanged by yieldmsg (same slices, cheaper
 * post) and falls by roughly the budget divided by the per-slice work on the
 * budget arms.  A delta on a budget arm that is not matched by a fall here has
 * not happened for the reason this ticket claims.
 */
const SCHED_ARMS = ['yieldmsg', 'yieldbudget', 'yieldboth', 'yieldsched'];
export const ABLATE_SCHED = SCHED_ARMS.includes(ABLATE) ? ABLATE : 'none';

/*
 * Ticket 05's arms, on how the viewer decides the source documents are ready.
 * ixbrlviewer.js polls every iframe on a setInterval(..., 250), and setInterval
 * fires *first* at +250ms - so a document set that is already ready when the poll
 * starts still waits a whole tick for a test whose answer never changes.  In
 * inline mode document 0 is reparented synchronously before the poll begins, so
 * this is not a hypothetical.
 *
 * None of these is an ablation: every arm evaluates the *same* readiness
 * predicate the baseline does, both halves of it (readyState complete-or-
 * interactive AND a body with children).  What changes is when it is evaluated.
 * That is deliberate - the predicate is the part with correctness risk, so
 * holding it fixed keeps the delta attributable to quantisation alone.
 *
 *   pollnow      the predicate is evaluated once, synchronously, before the
 *                interval is armed; the interval is then the baseline's 250ms and
 *                is not armed at all if that first test passes.  Against none:
 *                the first tick's latency, which is the whole wait on any fixture
 *                whose documents are ready before the poll starts.
 *   pollfast     pollnow, plus a 10ms interval instead of 250ms.  Against pollnow:
 *                the residual quantisation on the fixtures that genuinely wait -
 *                and it is the *ceiling* on what any detection mechanism can
 *                recover, since no event can beat a 10ms poll by more than 10ms.
 *                It is also a real candidate: nothing about it can miss an event.
 *   loadevent    pollnow, plus an iframe `load` listener per iframe, with the
 *                baseline 250ms interval retained as a backstop.  This is the
 *                genuinely event-driven arm, and the backstop is what makes it
 *                measurable rather than a gamble: iframeReady.poll counts the
 *                times the event was not enough and polling had to finish the
 *                job, so reliability is read off a counter instead of argued.
 *                Note the direction of the risk is not obvious - `load` fires at
 *                readyState `complete`, which is strictly *later* than the
 *                `interactive` the baseline predicate already accepts, so this arm
 *                can legitimately come out slower than pollfast.
 *
 * iframeReady.<how> is the mechanism counter: exactly one of immediate / poll /
 * event is 1 on every run, and which one it is says which mechanism did the work.
 * iframePoll.ticks is the other half of it - it must fall to 0 on any arm that
 * resolved 'immediate', and a delta on an arm whose ticks did not move has not
 * happened for the reason this ticket claims.
 *
 * The guards are every volume counter downstream, because resolving the wait
 * sooner must not hand the viewer a document that is still parsing:
 * continuationMaps.elementsWalked, reports.factsItemsScanned, factList.rowsBuilt,
 * drain.search.factCount and metricsAtLoaderRemoved.Nodes.  The predicate is
 * unchanged, so these must be identical across all four arms; if one moves, an
 * arm caught a document in a state the baseline never would.
 */
const LOAD_ARMS = ['pollnow', 'pollfast', 'loadevent'];
export const ABLATE_LOAD = LOAD_ARMS.includes(ABLATE) ? ABLATE : 'none';

/* The fast arm's interval.  Small enough that its own quantisation is inside the
 * spread of every fixture's load, large enough not to be a busy-wait against the
 * parser it is waiting for. */
export const POLL_FAST_MS = 10;

/*
 * Ticket 26's arms, on setProgress's double requestAnimationFrame - the progress
 * mechanism itself rather than any work it announces.  setProgress resolves only
 * after two frames, so each of the four calls on a non-review load stops the
 * startup chain until the browser has laid out and painted whatever the previous
 * phase dirtied.  Entry #7 and entry #11 of the report have NO ablation arm: their
 * headline numbers are a phase remainder and a phase span, both costs *attributed*
 * to the mechanism with nothing measured about removing it.  These two arms are
 * that missing measurement.
 *
 *   progsync        setProgress writes the text and resolves synchronously - no
 *                   requestAnimationFrame at any of the five call sites.  THIS ARM
 *                   SHIPS NOTHING.  It violates ticket 10's rule ("a label either
 *                   forces its frame and names the phase actually running, or it
 *                   does not exist") at every site simultaneously, so it models no
 *                   candidate change.  Its only job is to bound the prize: against
 *                   none it is the CEILING, the most this ticket could ever
 *                   recover.  Quote it as a ceiling and never as a payoff - the
 *                   map has two prior instances (tickets 07, 09) of an arm being
 *                   mistaken for the fix it models.
 *   prognoprepare   the candidate change, and the only shippable one: the
 *                   `Preparing document` call at viewer.js:130 becomes
 *                   Promise.resolve(), so that one label is not written and its
 *                   frame is not awaited.  The other four sites keep their frames
 *                   byte-identical to the baseline.  Against none: what deleting
 *                   exactly one label buys.  Against progsync: how much of the
 *                   ceiling the other four hold.
 *
 * Expect prognoprepare to recover materially less than the phase it removes.  Not
 * asking for a frame skips a PAINT, never a LAYOUT, and the layout is forced
 * moments later regardless by $(body).children(':visible') (viewer.js:83),
 * getComputedStyle(...).display in _wrapNode, postProcess's getBoundingClientRect
 * passes and htmlHidden() during row building.  With this hop gone the *next*
 * forced frame (inspector.js:208) pays for the union of what both phases dirtied.
 *
 * setProgress.wait is the mechanism counter rather than a guard here, and it is
 * the one span these arms are entitled to move: its `n` is the hop count, so it
 * must read 4 on none, 4-but-near-zero-ms on progsync and 3 on prognoprepare.  A
 * delta on an arm whose `n` did not fall as predicted has not happened for the
 * reason this ticket claims.
 *
 * EVERY volume counter is a guard, without exception: neither arm changes what
 * work is done, only when rendering is allowed to happen in between.  Any movement
 * in counts.* means the arm is doing something other than what it claims.  Both
 * frame-lag columns are carried too - these are scheduling changes by the map's
 * definition, and ticket 04's scheduler.yield() had the best drainGap delta of
 * five arms while pushing the first frame 268ms past the end of the drain.
 */
const PROGRESS_ARMS = ['progsync', 'prognoprepare'];
export const ABLATE_PROGRESS = PROGRESS_ARMS.includes(ABLATE) ? ABLATE : 'none';

/*
 * Ticket 08's rider, carried by rowdefer only.  Resolved once at module load so
 * that the `none` arm's htmlHidden() is the same statement master runs, rather
 * than master's statement with a branch in front of it.
 */
export const HTML_HIDDEN_FILTER = ABLATE === 'rowdefer'
    ? ':not(.ixbrl-contains-absolute)'
    : ':not(.ixbrl-no-highlight)';

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
