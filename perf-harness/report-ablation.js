// Ticket 05's ablation tables.  THROWAWAY - startup-slowness investigation only.
//
//   node perf-harness/report-ablation.js <sweep.json> [...]
//
// Reads only; re-measures nothing.
//
// Every arm in an ABLATE_ARMS sweep is the same bundle on the same server, and the
// harness alternates them run by run, so run i of one arm and run i of another are
// as close to simultaneous as this rig gets.  That makes the delta a *paired*
// difference: it is computed per run index and only then reduced to a median, so
// the delta carries a spread of its own.  Differencing two medians instead would
// throw that away, and the map's evidence bar is precisely "a delta larger than
// the measured spread" - which is unanswerable without a spread on the delta.
const fs = require('fs');

/* Cross-arm comparable by construction: measured by the harness's injected
 * MutationObserver, not by the build's own marks.  metricsAtLoaderRemoved is read
 * at the same window on every arm, which is the only way these cumulative CDP
 * counters can be compared at all. */
const METRICS = [
    ['external.loaderRemoved', 'loaderRemoved', 'ms'],
    ['windows.toDrained', 'drained', 'ms'],
    ['spans.viewer.findOrCreateWrapperNode.ms', 'fcwn', 'ms'],
    ['metricsAtLoaderRemoved.RecalcStyleDuration', 'recalcMs', 'ms'],
    ['metricsAtLoaderRemoved.RecalcStyleCount', 'recalcs', 'n'],
    ['metricsAtLoaderRemoved.ScriptDuration', 'scriptMs', 'ms'],
    ['metricsAtLoaderRemoved.LayoutDuration', 'layoutMs', 'ms'],
    ['counts.fcwn.subNodesScanned', 'scanned', 'n'],
    ['counts.fcwn.absoluteSubNodes', 'absolute', 'n'],
    /* Ticket 06's arms act on the fact-list row path, so its own spans are here
     * too.  LayoutCount and Nodes come with them: the row path's suspected cost is
     * a forced layout read per row, and identical Nodes across arms is how an
     * ordering control is shown to have left the output alone. */
    ['spans.inspector.factListRows.ms', 'rowMs', 'ms'],
    ['spans.inspector.buildFactListByGroup.ms', 'factListMs', 'ms'],
    ['metricsAtLoaderRemoved.LayoutCount', 'layouts', 'n'],
    ['metricsAtLoaderRemoved.Nodes', 'nodes', 'n'],
    ['rows', 'rows', 'n'],
    ['sections', 'sections', 'n'],
    /* Ticket 11's arms act inside the post-load drain, which is past
     * loaderRemoved - so unlike every metric above, the CDP counters that matter
     * here are the end-of-run `metrics` reads, and they are only comparable
     * because all three arms are instrumented and all three stop at `drained`.
     * containsAbsolute is the guard: it is counted before the arm dispatch, so an
     * arm that moves it has ablated something it has no business touching. */
    ['windows.drainGap', 'drainGap', 'ms'],
    ['spans.drain.viewer.pass1.ms', 'vPass1', 'ms'],
    ['spans.drain.viewer.pass2.ms', 'vPass2', 'ms'],
    ['spans.drain.search.docs.ms', 'sDocs', 'ms'],
    ['spans.drain.search.lunrAdd.ms', 'sLunrAdd', 'ms'],
    ['spans.drain.search.lunrBuild.ms', 'sLunrBuild', 'ms'],
    ['counts.drain.viewer.containsAbsolute', 'containsAbs', 'n'],
    ['counts.drain.viewer.pass1Layout', 'pass1Layout', 'n'],
    ['counts.drain.viewer.noHighlight', 'noHighlight', 'n'],
    ['metrics.RecalcStyleDuration', 'endRecalcMs', 'ms'],
    ['metrics.RecalcStyleCount', 'endRecalcs', 'n'],
    ['metrics.LayoutDuration', 'endLayoutMs', 'ms'],
    ['metrics.LayoutCount', 'endLayouts', 'n'],
    /* Ticket 12's arms act on review mode's untagged-numbers walk, which sits well
     * before loaderRemoved, so its CDP counters are the metricsAtLoaderRemoved
     * reads above.  The phase itself is a mark difference rather than a span,
     * because the walk is only one of the three things inside it - hideChildren
     * and showChildren are the other two, and showChildren is a forced relayout of
     * whatever the walk just built, so an arm that builds fewer nodes makes it
     * cheaper for a reason that is not the ablated statement.  Quote it per arm.
     * The three guards are textNodes / elementNodes / textChars: the walk is
     * untouched by every arm here, so a moved guard means the delta is not what it
     * says it is. */
    ['phase.untagged', 'untagged', 'ms'],
    ['spans.viewer.wrapUntaggedNumbers.ms', 'wrapWalk', 'ms'],
    ['spans.viewer.untagged.showChildren.ms', 'showChildren', 'ms'],
    ['spans.viewer.untagged.hideChildren.ms', 'hideChildren', 'ms'],
    ['spans.untagged.contents.ms', 'segContents', 'ms'],
    ['spans.untagged.elementTest.ms', 'segElemTest', 'ms'],
    ['spans.untagged.match.ms', 'segMatch', 'ms'],
    ['spans.untagged.matchRewrite.ms', 'segMatchRewrite', 'ms'],
    ['spans.untagged.rewrite.ms', 'segRewrite', 'ms'],
    ['counts.untagged.textNodes', 'textNodes', 'n'],
    ['counts.untagged.elementNodes', 'elementNodes', 'n'],
    ['counts.untagged.textChars', 'textChars', 'n'],
    ['counts.untagged.elementsRecursed', 'elemRecursed', 'n'],
    ['counts.untagged.matches', 'matches', 'n'],
    ['counts.untagged.wrapped', 'wrapped', 'n'],
    ['counts.untagged.keptAsText', 'keptAsText', 'n'],
    /* Ticket 04's arms act on runGenerator itself.  sched.hops is the mechanism -
     * posted resumes, so a budget arm must show it fall - and the two yields
     * counters are the guard, because nothing here touches a generator's body.
     *
     * frameLag is the responsiveness column, and it is why this ticket cannot be
     * judged on drainGap alone.  The yield exists to let the browser paint during
     * a multi-second drain; an arm that posts its resumes ahead of the rendering
     * steps buys its delta by not painting, and drainGap cannot see that.  Both
     * are within-run intervals, so they cancel the whole-load variance that makes
     * the absolute frame marks unusable (README, Paired two-build runs). */
    ['frameLag.loaderRemoved', 'frameLagLoader', 'ms'],
    ['frameLag.drained', 'frameLagDrained', 'ms'],
    ['counts.sched.hops.viewer', 'hopsViewer', 'n'],
    ['counts.sched.hops.search', 'hopsSearch', 'n'],
    ['counts.drain.viewer.yields', 'yieldsViewer', 'n'],
    ['counts.drain.search.yields', 'yieldsSearch', 'n'],
    /* Ticket 05's arms act on the readiness wait, which sits before every phase
     * above.  pollWait is the part an arm can move - iframePoll.start is where the
     * baseline arms its interval, so the interval before that mark is setProgress's
     * double rAF and belongs to ticket 10, not here.  `loading` is the whole phase,
     * carried alongside so a delta on pollWait can be checked against it.
     *
     * ticks and the three readyBy counters are the mechanism: a delta whose ticks
     * did not fall has not happened for the reason this ticket claims, and
     * readyByPoll on the event arm is that arm's reliability, counted rather than
     * argued.  The four volume guards are the correctness half: every arm runs the
     * *same* readiness predicate, so resolving sooner must not hand the viewer a
     * document in a state the baseline would never have accepted.  Nodes above is
     * the fifth. */
    ['phase.loading', 'loading', 'ms'],
    ['iframePoll.wait', 'pollWait', 'ms'],
    ['counts.iframePoll.ticks', 'ticks', 'n'],
    ['counts.iframeReady.immediate', 'readyByNow', 'n'],
    ['counts.iframeReady.event', 'readyByEvent', 'n'],
    ['counts.iframeReady.poll', 'readyByPoll', 'n'],
    ['counts.iframeLoad.events', 'loadEvents', 'n'],
    ['counts.continuationMaps.elementsWalked', 'elemsWalked', 'n'],
    ['counts.reports.factsItemsScanned', 'factsScanned', 'n'],
    ['counts.factList.rowsBuilt', 'rowsBuilt', 'n'],
    ['counts.drain.search.factCount', 'searchFacts', 'n'],
    /* Ticket 26's arms act on setProgress's double rAF, which is not a phase at
     * all but the gaps *between* phases - so the rows that can see it are the two
     * inter-phase hops (toPrepare, toInspector) plus the phases either side of the
     * one label the candidate change deletes.
     *
     * inspectorInit and prepare are carried for the failure mode this ticket was
     * created to catch: a hop removed does not cancel the renderer's work, it
     * postpones it, so the next forced frame pays for the union of what both
     * phases dirtied.  If toPrepare falls and inspectorPre rises by the same
     * amount, nothing has been recovered and the correct verdict is a decline.
     * The two windows above decide that; these rows say where it went.
     *
     * progressWait is the mechanism, and its `n` is the hop count - the one span
     * these arms are entitled to move.  A delta on an arm whose `n` did not fall
     * as its definition predicts has not happened for the reason claimed. */
    ['phase.toPrepare', 'toPrepare', 'ms'],
    ['phase.prepare', 'prepare', 'ms'],
    ['phase.toInspector', 'toInspector', 'ms'],
    ['phase.inspectorPre', 'inspectorPre', 'ms'],
    ['phase.inspectorInit', 'inspectorInit', 'ms'],
    ['spans.setProgress.wait.ms', 'progressWait', 'ms'],
    ['spans.setProgress.wait.n', 'progressHops', 'n'],
];

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r1 = (x) => (x === undefined ? undefined : Math.round(x * 10) / 10);
const dig = (o, k) => k.split('.').reduce((a, p) => (a === undefined ? a : a[p]), o);

/* The leaf a metric key names, read off one run rather than off the aggregate, so
 * it can be paired with the same run index on another arm. */
function leaf(run, key) {
    const flat = {
        'rows': run.rows, 'sections': run.sections,
        'windows.toDrained': run.windows?.toDrained,
        'external.loaderRemoved': run.external?.loaderRemoved,
        /* A mark difference, not a span, and the mark names themselves contain
         * dots - so it cannot go through dig(). */
        'phase.untagged': (run.marks?.['phase.untagged.end'] === undefined
            ? undefined
            : run.marks['phase.untagged.end'] - run.marks['phase.untagged.start']),
        'phase.loading': (run.marks?.['phase.loading.end'] === undefined
            ? undefined
            : run.marks['phase.loading.end'] - run.marks['phase.loading.start']),
        /* Within-run, and the only interval ticket 05's arms can move: from the
         * point the baseline arms its interval to the point readiness is seen. */
        'iframePoll.wait': (run.marks?.['phase.loading.end'] === undefined
            ? undefined
            : run.marks['phase.loading.end'] - run.marks['iframePoll.start']),
        /* Within-run, for the reason the drainGap is: both frame marks carry the
         * whole load's variance, and the interval between them does not. */
        'frameLag.loaderRemoved': (run.windows?.toLoaderRemovedFrame === undefined
            ? undefined
            : run.windows.toLoaderRemovedFrame - run.windows.toLoaderRemoved),
        'frameLag.drained': (run.windows?.toDrainedFrame === undefined
            ? undefined
            : run.windows.toDrainedFrame - run.windows.toDrained),
        /* Ticket 26's rows.  Mark differences like the two above, and the mark
         * names contain dots, so they cannot go through dig() either.  toPrepare's
         * start falls back through two candidates for the same reason phases.js's
         * does: in review mode the untagged phase sits inside the hop. */
        'phase.toPrepare': (run.marks?.['phase.prepare.start'] === undefined
            ? undefined
            : run.marks['phase.prepare.start']
                - (run.marks['phase.untagged.end'] ?? run.marks['phase.preProcess.end'])),
        'phase.prepare': (run.marks?.['phase.prepare.end'] === undefined
            ? undefined
            : run.marks['phase.prepare.end'] - run.marks['phase.prepare.start']),
        'phase.toInspector': (run.marks?.['inspector.initialize.start'] === undefined
            ? undefined
            : run.marks['inspector.initialize.start'] - run.marks['phase.prepare.end']),
        'phase.inspectorPre': (run.marks?.['phase.inspectorInit.start'] === undefined
            ? undefined
            : run.marks['phase.inspectorInit.start'] - run.marks['inspector.initialize.start']),
        'phase.inspectorInit': (run.marks?.['phase.inspectorInit.end'] === undefined
            ? undefined
            : run.marks['phase.inspectorInit.end'] - run.marks['phase.inspectorInit.start']),
    };
    if (key in flat) {
        return flat[key];
    }
    if (key.startsWith('spans.')) {
        const rest = key.slice(6);
        /* A span carries both accumulated time and a call count, and ticket 26
         * needs the count: setProgress.wait's `n` is the hop count, which is what
         * says an arm removed the hop it claims to have removed. */
        if (rest.endsWith('.n')) {
            return run.spans?.[rest.slice(0, -2)]?.n;
        }
        return run.spans?.[rest.replace(/\.ms$/, '')]?.ms;
    }
    if (key.startsWith('counts.')) {
        return run.counts?.[key.slice(7)];
    }
    return dig(run, key);
}

function main() {
    const files = process.argv.slice(2);
    if (!files.length) {
        console.error('usage: report-ablation.js <sweep.json> [...]');
        process.exit(1);
    }
    for (const file of files) {
        const j = JSON.parse(fs.readFileSync(file));
        console.log(`\n## ${file}`);
        console.log(`\nlevel=${j.level} runs=${j.runs} tiers=${j.tiers.join(',')} `
            + `review=${j.review} chrome=${j.chrome}`);
        const b = j.arms[0];
        console.log(`build: ${b.branch} @ ${b.sha.slice(0, 8)}${b.dirty ? ' DIRTY' : ''} `
            + `arms: ${j.arms.map(a => a.ablate).join(', ')}`);
        console.log(`machine: ${j.machine.model} (${j.machine.cpus} cpu)`);

        const keyOf = (r) => `${r.slug} ${r.tier}`;
        const groups = new Map();
        for (const r of j.results) {
            (groups.get(keyOf(r)) ?? groups.set(keyOf(r), []).get(keyOf(r))).push(r);
        }
        for (const [k, rs] of groups) {
            const [slug, tier] = k.split(' ');
            const base = rs.find(r => r.ablate === 'none') ?? rs[0];
            console.log(`\n### ${slug} @ ${tier}x  (baseline arm: ${base.ablate})\n`);
            const head = ['metric', ...rs.map(r => r.ablate)];
            console.log('| ' + head.join(' | ') + ' |');
            console.log('|' + head.map(() => '---').join('|') + '|');
            for (const [key, label, unit] of METRICS) {
                const cells = rs.map((r) => {
                    const xs = r.runs.filter(x => !x.error)
                        .map(x => leaf(x, key)).filter(x => typeof x === 'number');
                    if (!xs.length) {
                        return '-';
                    }
                    const med = `${r1(median(xs))}±${r1(Math.max(...xs) - Math.min(...xs))}`;
                    if (r === base) {
                        return med;
                    }
                    /* Paired by run index against the baseline arm, so the delta has
                     * its own spread and can be held to the evidence bar. */
                    const deltas = [];
                    for (const run of r.runs) {
                        const mate = base.runs.find(x => x.run === run.run);
                        const a = leaf(run, key);
                        const bb = mate === undefined ? undefined : leaf(mate, key);
                        if (typeof a === 'number' && typeof bb === 'number') {
                            deltas.push(a - bb);
                        }
                    }
                    if (!deltas.length) {
                        return med;
                    }
                    const dm = median(deltas);
                    const ds = Math.max(...deltas) - Math.min(...deltas);
                    /* The bar: a delta only counts if it exceeds its own spread. */
                    const bar = Math.abs(dm) > ds ? '' : ' *unresolved*';
                    const pct = (() => {
                        const bmed = median(base.runs.map(x => leaf(x, key))
                            .filter(x => typeof x === 'number'));
                        return bmed ? ` ${dm > 0 ? '+' : ''}${Math.round(dm / bmed * 100)}%` : '';
                    })();
                    return `${med}<br>Δ ${dm > 0 ? '+' : ''}${r1(dm)}±${r1(ds)}${pct}${bar}`;
                });
                console.log(`| ${label} (${unit}) | ` + cells.join(' | ') + ' |');
            }
        }
    }
}
main();
