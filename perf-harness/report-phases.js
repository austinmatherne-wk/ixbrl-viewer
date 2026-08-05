// Turn measure-phases.js JSON into the ticket-04 tables.  THROWAWAY - for the
// startup-slowness investigation (.scratch/startup-slowness, ticket 04) only.
//
//   node perf-harness/report-phases.js perf-harness/out/t04-main-sweep.json [...]
//
// Reads one or more sweep files and writes markdown to stdout.  Every number is
// the median of the runs in the file with its spread, because a single run is
// never quotable.  Nothing here re-measures: it only reshapes.
const fs = require('fs');

/* The startup timeline, in source order, as a *complete partition* of nav start
 * -> drained.  The five phases the source already had (the setProgress
 * boundaries) do not tile the window on their own: the browser's own parse of
 * the host document sits before the first of them, and three gaps sit between
 * them.  Each is named here rather than left in a residual, because on an inline
 * filing the parse gap alone is the largest thing outside preProcess.
 *
 * `from`/`to` are mark names; `spans` are the perfSpan / perfOpen names nested
 * inside.  Kept as data so a span added to perf.js becomes a row for free. */
const PHASES = [
    { key: 'parse', label: 'nav -> DOMContentLoaded (browser parses host doc, evals bundle)',
        from: null, to: 'marks.load.start',
        spans: [] },
    { key: 'config', label: 'runtime config fetch',
        from: 'marks.load.start', to: 'marks.runtimeConfig.loaded',
        spans: [] },
    { key: 'boot', label: 'boot (inspector HTML -> loader shown)',
        from: 'marks.runtimeConfig.loaded', to: 'marks.loaderShown',
        spans: ['loadInspectorHTML'] },
    { key: 'metadata', label: 'metadata (read, parse, ReportSet, reparent)',
        from: 'marks.loaderShown', to: 'marks.phase.loading.start',
        spans: ['taxonomyData.read', 'taxonomyData.parse', 'reportSet.construct', 'reparentDocument'] },
    { key: 'loading', label: 'phase.loading (iframe readyState poll)',
        from: 'marks.phase.loading.start', to: 'marks.phase.loading.end',
        spans: [] },
    { key: 'construct', label: 'Viewer construct + continuation maps',
        from: 'marks.phase.loading.end', to: 'marks.phase.preProcess.start',
        spans: ['viewer.construct', 'viewer.buildContinuationMaps'] },
    { key: 'preProcess', label: 'phase.preProcess (document walk)',
        from: 'marks.phase.preProcess.start', to: 'marks.phase.preProcess.end',
        spans: ['viewer.preProcessiXBRL', 'viewer.setContinuationMaps', 'viewer.findOrCreateWrapperNode'] },
    { key: 'toUntagged', label: 'preProcess.end -> untagged.start (review mode only)',
        from: 'marks.phase.preProcess.end', to: 'marks.phase.untagged.start',
        spans: [] },
    { key: 'untagged', label: 'phase.untagged (review mode only)',
        from: 'marks.phase.untagged.start', to: 'marks.phase.untagged.end',
        spans: ['viewer.untagged.hideChildren', 'viewer.wrapUntaggedNumbers', 'viewer.untagged.showChildren'] },
    /* The progress hop: setProgress resolves on a double rAF, so this is pure
     * waiting.  In review mode the untagged phase sits inside it, which is why the
     * start mark falls back through two candidates. */
    { key: 'toPrepare', label: 'progress hop -> prepare.start (setProgress double rAF)',
        from: ['marks.phase.untagged.end', 'marks.phase.preProcess.end'],
        to: 'marks.phase.prepare.start',
        spans: [] },
    { key: 'prepare', label: 'phase.prepare',
        from: 'marks.phase.prepare.start', to: 'marks.phase.prepare.end',
        spans: ['viewer.setIXNodeMap', 'viewer.applyStyles', 'viewer.bindHandlers', 'viewer.addDocumentSetTabs'] },
    { key: 'toInspector', label: 'prepare.end -> inspector.initialize.start',
        from: 'marks.phase.prepare.end', to: 'marks.inspector.initialize.start',
        spans: [] },
    { key: 'inspectorPre', label: 'inspector setup (before inspectorInit)',
        from: 'marks.inspector.initialize.start', to: 'marks.phase.inspectorInit.start',
        spans: ['inspector.bindStaticHandlers', 'inspector.initializeTooltips',
            'inspector.initializeReviewMode', 'inspector.buildMenus', 'inspector.buildLanguages',
            'inspector.localize', 'inspector.createSummary', 'inspector.buildOutline',
            'inspector.initializeZoom'] },
    { key: 'inspectorInit', label: 'phase.inspectorInit',
        from: 'marks.phase.inspectorInit.start', to: 'marks.phase.inspectorInit.end',
        spans: ['inspector.searchConstruct', 'inspector.rebuildViewer', 'inspector.initializeViewer',
            'inspector.buildFactListByGroup', 'inspector.factListRows', 'inspector.doInitialSelection'] },
    { key: 'toLoaderGone', label: 'inspectorInit.end -> loader removed (interact)',
        from: 'marks.phase.inspectorInit.end', to: 'marks.loaderRemoved',
        spans: ['interact.configure'] },
    { key: 'drain', label: 'post-load drain (loader gone -> drained)',
        from: 'marks.loaderRemoved', to: 'marks.drained',
        spans: [] },
];

/* Spans that wrap whole groups of the phases above, so they double-count against
 * them and are listed apart. */
const CROSS = ['viewer.initialize', 'inspector.initialize', 'setProgress.wait'];

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const med = (s, k) => (s[k] ? s[k].median : undefined);
const f1 = (x) => (x === undefined ? '-' : (Math.round(x * 10) / 10).toLocaleString('en-US'));
const f0 = (x) => (x === undefined ? '-' : Math.round(x).toLocaleString('en-US'));
const pct = (x, of) => (x === undefined || !of ? '-' : `${(100 * x / of).toFixed(1)}%`);
const pm = (s, k, f = f1) => (s[k] ? `${f(s[k].median)}±${f(s[k].spread)}` : '-');

/*
 * Phase durations are computed per run and only then reduced to a median.
 *
 * The alternative - differencing the medians of the two boundary marks - looks
 * equivalent and is not: those marks are absolute times since navigation start,
 * so each carries the whole run's accumulated variance.  Differencing two such
 * medians on an 80ms phase inside a window that itself moves +/-75ms produced a
 * phase shorter than a span nested inside it.  A within-run difference cancels
 * that common movement, and it is the only form that can carry a spread.
 */
function markIn(marks, spec) {
    if (spec === null) {
        return 0;                                   /* nav start is the time origin */
    }
    for (const k of [].concat(spec)) {
        const name = k.replace(/^marks\./, '');
        if (marks?.[name] !== undefined) {
            return marks[name];
        }
    }
    return undefined;
}

function phaseRuns(r, ph) {
    const xs = [];
    for (const run of r.runs ?? []) {
        const a = markIn(run.marks, ph.from);
        const b = markIn(run.marks, ph.to);
        if (a !== undefined && b !== undefined) {
            xs.push(b - a);
        }
    }
    return xs;
}

/* Per-run sum over every phase, so the residual is a within-run quantity too. */
function phaseSumRuns(r) {
    const xs = [];
    for (const run of r.runs ?? []) {
        let t = 0;
        for (const ph of PHASES) {
            const a = markIn(run.marks, ph.from);
            const b = markIn(run.marks, ph.to);
            if (a !== undefined && b !== undefined) {
                t += b - a;
            }
        }
        xs.push(t);
    }
    return xs;
}

function residualRuns(r) {
    const xs = [];
    for (const run of r.runs ?? []) {
        if (run.windows?.toDrained === undefined) {
            continue;
        }
        let t = 0;
        for (const ph of PHASES) {
            const a = markIn(run.marks, ph.from);
            const b = markIn(run.marks, ph.to);
            if (a !== undefined && b !== undefined) {
                t += b - a;
            }
        }
        xs.push(run.windows.toDrained - t);
    }
    return xs;
}

/* median±spread of a per-run series, or '-' when the phase did not occur. */
const cell = (xs, f = f1) => (xs.length
    ? `${f(median(xs))}±${f(Math.max(...xs) - Math.min(...xs))}`
    : '-');

function phaseMs(r, ph) {
    const xs = phaseRuns(r, ph);
    return xs.length ? median(xs) : undefined;
}

function loadArms(files) {
    const rows = [];
    for (const file of files) {
        const j = JSON.parse(fs.readFileSync(file));
        for (const r of j.results) {
            rows.push({ ...r, file, review: j.review, level: j.level,
                machine: j.machine, chrome: j.chrome, stamp: j.stamp,
                arms: j.arms });
        }
    }
    return rows;
}

function table(header, lines) {
    return [`| ${header.join(' | ')} |`,
        `|${header.map(() => '---').join('|')}|`,
        ...lines.map(l => `| ${l.join(' | ')} |`)].join('\n');
}

const files = process.argv.slice(2);
if (!files.length) {
    console.error('usage: node perf-harness/report-phases.js <sweep.json> ...');
    process.exit(1);
}
const rows = loadArms(files);
const instr = rows.filter(r => r.arm === 'instrumented');
const slugs = [...new Set(instr.map(r => r.slug))];
const tiers = [...new Set(instr.map(r => r.tier))].sort((a, b) => a - b);
const out = [];

const meta = rows[0];
out.push(`<!-- generated by perf-harness/report-phases.js from ${files.join(', ')} -->`);
out.push('');
out.push(`Machine: ${meta.machine.model}, ${meta.machine.cpus} cores, `
    + `${Math.round(meta.machine.totalMemBytes / 1e9)}GB. ${meta.chrome}. `
    + `Session stamp \`${meta.stamp}\`. Level \`${meta.level}\`, review=${meta.review}.`);
const seenArms = new Set();
for (const r of rows) {
    for (const a of r.arms) {
        const key = `${r.file}/${a.name}`;
        if (seenArms.has(key)) {
            continue;
        }
        seenArms.add(key);
        out.push(`\`${r.file.replace(/.*\//, '')}\` arm **${a.name}**: \`${a.branch}\` @ `
            + `\`${a.sha.slice(0, 8)}\`, bundle ${(a.bundleBytes / 1e6).toFixed(2)}MB`
            + `${a.dirty ? ' **DIRTY TREE**' : ''}, level ${a.level}.`);
    }
}

/* ---- 1. The two windows ---- */
for (const tier of tiers) {
    out.push('', `## Windows — ${tier}× CPU`, '');
    out.push(table(
        ['slug', 'loadEventEnd', 'loaderRemoved', 'its frame', 'drained', 'its frame',
            'drain gap', 'gap %', 'runs'],
        slugs.map((slug) => {
            const r = instr.find(x => x.slug === slug && x.tier === tier);
            if (!r) return [slug, ...Array(8).fill('-')];
            const s = r.summary;
            const drained = med(s, 'windows.toDrained');
            return [`\`${slug}\``,
                f0(med(s, 'loadEventEnd')),
                pm(s, 'windows.toLoaderRemoved', f0),
                pm(s, 'windows.toLoaderRemovedFrame', f0),
                pm(s, 'windows.toDrained', f0),
                pm(s, 'windows.toDrainedFrame', f0),
                pm(s, 'windows.drainGap', f0),
                pct(med(s, 'windows.drainGap'), drained),
                `${r.ok}${r.timedOut ? ` (${r.timedOut} timed out)` : ''}`];
        })));
}

/* ---- 2. Phase table, per tier ---- */
for (const tier of tiers) {
    out.push('', `## Phases — ${tier}× CPU (ms, median of runs)`, '');
    const header = ['phase', ...slugs.map(s => s.replace(/^(...).*-(.{0,6})$/, '$1…$2'))];
    const lines = [];
    const at = (slug) => instr.find(x => x.slug === slug && x.tier === tier);
    for (const ph of PHASES) {
        lines.push([ph.label, ...slugs.map((slug) => {
            const r = at(slug);
            return r ? cell(phaseRuns(r, ph)) : '-';
        })]);
    }
    lines.push(['**Σ phases**', ...slugs.map(slug => (at(slug) ? cell(phaseSumRuns(at(slug))) : '-'))]);
    lines.push(['**window: drained**', ...slugs.map((slug) => {
        const r = at(slug);
        return r ? pm(r.summary, 'windows.toDrained') : '-';
    })]);
    lines.push(['**residual (in no phase)**',
        ...slugs.map(slug => (at(slug) ? cell(residualRuns(at(slug))) : '-'))]);
    out.push(table(header, lines));
}

/* ---- 3. Sub-spans, per fixture ---- */
out.push('', '## Sub-spans by fixture (ms median, n calls)', '');
for (const slug of slugs) {
    out.push('', `### \`${slug}\``, '');
    const lines = [];
    for (const ph of PHASES) {
        const cells = tiers.map((tier) => {
            const r = instr.find(x => x.slug === slug && x.tier === tier);
            return r ? cell(phaseRuns(r, ph)) : '-';
        });
        lines.push([`**${ph.key}**`, ...cells, '']);
        for (const sp of ph.spans) {
            const cells2 = tiers.map((tier) => {
                const r = instr.find(x => x.slug === slug && x.tier === tier);
                return r ? pm(r.summary, `spans.${sp}.ms`) : '-';
            });
            const r1x = instr.find(x => x.slug === slug && x.tier === tiers[0]);
            const n = r1x ? med(r1x.summary, `spans.${sp}.n`) : undefined;
            if (cells2.every(c => c === '-')) continue;
            lines.push([`&nbsp;&nbsp;\`${sp}\``, ...cells2, n === undefined ? '' : f0(n)]);
        }
    }
    for (const sp of CROSS) {
        const cells = tiers.map((tier) => {
            const r = instr.find(x => x.slug === slug && x.tier === tier);
            return r ? pm(r.summary, `spans.${sp}.ms`) : '-';
        });
        if (cells.every(c => c === '-')) continue;
        const r1x = instr.find(x => x.slug === slug && x.tier === tiers[0]);
        lines.push([`\`${sp}\` *(cross-phase)*`, ...cells, f0(med(r1x.summary, `spans.${sp}.n`))]);
    }
    out.push(table(['span', ...tiers.map(t => `${t}×`), 'n'], lines));
}

/* ---- 4. Throttle scaling ---- */
if (tiers.length > 1) {
    const lo = tiers[0];
    const hi = tiers[tiers.length - 1];
    out.push('', `## Throttle scaling (${hi}× / ${lo}×) — a ratio near 1 is not CPU-bound`, '');
    const lines = [];
    for (const ph of PHASES) {
        lines.push([ph.label, ...slugs.map((slug) => {
            const a = instr.find(x => x.slug === slug && x.tier === lo);
            const b = instr.find(x => x.slug === slug && x.tier === hi);
            if (!a || !b) return '-';
            const pa = phaseMs(a, ph);
            const pb = phaseMs(b, ph);
            /* Below ~2ms the ratio is quantisation noise, not a scaling claim. */
            return pa === undefined || pb === undefined || pa < 2 ? '-' : (pb / pa).toFixed(2);
        })]);
    }
    lines.push(['**drained window**', ...slugs.map((slug) => {
        const a = instr.find(x => x.slug === slug && x.tier === lo);
        const b = instr.find(x => x.slug === slug && x.tier === hi);
        if (!a || !b) return '-';
        return (med(b.summary, 'windows.toDrained') / med(a.summary, 'windows.toDrained')).toFixed(2);
    })]);
    out.push(table(['phase', ...slugs.map(s => s.replace(/^(...).*-(.{0,6})$/, '$1…$2'))], lines));
}

/* ---- 5. Where the time is NOT javascript ---- */
for (const tier of tiers) {
    out.push('', `## Layout, style and script — ${tier}× (CDP, at loader removal)`, '');
    out.push(table(
        ['slug', 'RecalcStyle ms', 'Layout ms', 'Script ms', 'Task ms', 'RecalcStyle n', 'Layout n', 'style/script'],
        slugs.map((slug) => {
            const r = instr.find(x => x.slug === slug && x.tier === tier);
            if (!r) return [slug, ...Array(7).fill('-')];
            const s = r.summary;
            const st = med(s, 'metricsAtLoaderRemoved.RecalcStyleDuration');
            const sc = med(s, 'metricsAtLoaderRemoved.ScriptDuration');
            return [`\`${slug}\``,
                pm(s, 'metricsAtLoaderRemoved.RecalcStyleDuration', f0),
                pm(s, 'metricsAtLoaderRemoved.LayoutDuration', f0),
                pm(s, 'metricsAtLoaderRemoved.ScriptDuration', f0),
                pm(s, 'metricsAtLoaderRemoved.TaskDuration', f0),
                f0(med(s, 'metricsAtLoaderRemoved.RecalcStyleCount')),
                f0(med(s, 'metricsAtLoaderRemoved.LayoutCount')),
                sc ? (st / sc).toFixed(1) : '-'];
        })));
}

/* ---- 6. Memory and DOM ---- */
for (const tier of tiers) {
    out.push('', `## Memory and DOM — ${tier}×`, '');
    out.push(table(
        ['slug', 'peak heap at marks MB', 'heap at drained MB', 'Nodes (end)', 'Nodes after GC',
            'live nodes after GC', 'detached est.', 'rows', 'sections'],
        slugs.map((slug) => {
            const r = instr.find(x => x.slug === slug && x.tier === tier);
            if (!r) return [slug, ...Array(8).fill('-')];
            const s = r.summary;
            const mb = (k) => (s[k] ? `${(s[k].median / 1e6).toFixed(1)}` : '-');
            const live = s['liveAfterGC.viewerNodes'] && s['liveAfterGC.iframeNodes']
                ? med(s, 'liveAfterGC.viewerNodes') + med(s, 'liveAfterGC.iframeNodes') : undefined;
            return [`\`${slug}\``,
                mb('peakHeapAtMarks'),
                mb('heap.drained'),
                f0(med(s, 'metrics.Nodes')),
                f0(med(s, 'metricsAfterGC.Nodes')),
                f0(live),
                pm(s, 'detachedNodesEstimate', f0),
                f0(med(s, 'rows')),
                f0(med(s, 'sections'))];
        })));
}

/* ---- 7. Counters ---- */
out.push('', '## Volume counters (median, 1× arm)', '');
const counterKeys = [...new Set(instr.flatMap(r => Object.keys(r.summary)))]
    .filter(k => k.startsWith('counts.')).sort();
out.push(table(['slug', ...counterKeys.map(k => `\`${k.replace('counts.', '')}\``)],
    slugs.map((slug) => {
        const r = instr.find(x => x.slug === slug && x.tier === tiers[0]);
        return [`\`${slug}\``, ...counterKeys.map(k => (r ? f0(med(r.summary, k)) : '-'))];
    })));

/* ---- 8. Paired control arm, if there is one ---- */
const ctrl = rows.filter(r => r.arm === 'control');
if (ctrl.length) {
    out.push('', '## Paired control arm — compare on `external.loaderRemoved` only', '');
    for (const tier of tiers) {
        const lines = [];
        for (const slug of [...new Set(ctrl.map(r => r.slug))]) {
            const a = instr.find(x => x.slug === slug && x.tier === tier);
            const b = ctrl.find(x => x.slug === slug && x.tier === tier);
            if (!a || !b) continue;
            const ext = (r) => med(r.summary, 'external.loaderRemoved');
            const frame = (r) => med(r.summary, 'external.loaderRemovedFrame');
            lines.push([`\`${slug}\``, `${tier}×`,
                pm(a.summary, 'external.loaderRemoved', f0),
                pm(b.summary, 'external.loaderRemoved', f0),
                f1(ext(b) - ext(a)),
                pm(a.summary, 'external.loaderRemovedFrame', f0),
                pm(b.summary, 'external.loaderRemovedFrame', f0),
                f1(frame(b) - frame(a)),
                f1(med(b.summary, 'metricsAtLoaderRemoved.LayoutDuration')
                    - med(a.summary, 'metricsAtLoaderRemoved.LayoutDuration')),
                f1(med(b.summary, 'metricsAtLoaderRemoved.RecalcStyleDuration')
                    - med(a.summary, 'metricsAtLoaderRemoved.RecalcStyleDuration')),
                f0(med(b.summary, 'metricsAtLoaderRemoved.Nodes') - med(a.summary, 'metricsAtLoaderRemoved.Nodes'))]);
        }
        if (lines.length) {
            out.push(table(['slug', 'tier', 'ext base', 'ext control', 'Δ ext',
                'frame base', 'frame control', 'Δ frame', 'Δ Layout ms', 'Δ RecalcStyle ms', 'Δ Nodes'], lines));
        }
    }
}

console.log(out.join('\n'));
