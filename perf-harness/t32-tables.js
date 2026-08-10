// Ticket 32 tables: what removing text-block values from viewer metadata buys.
//
// The arms are fixture variants rather than build or query-string arms, because
// the cost under test is JSON.parse over emitted bytes and no in-source arm can
// decline to parse bytes that are in the document:
//
//   baseline  the fetched stub viewer's payload, re-serialised byte-identically
//   deferred  text-block values moved to a second script tag the viewer never
//             reads.  Bytes still loaded and tokenised; JSON.parse sees none.
//   stripped  values gone from the document.  The ceiling for any candidate.
//
// So (baseline - deferred) is what a deferred-parse change can recover and
// (deferred - stripped) is what only shedding the bytes can, which is the term
// that decides between the ticket's candidates.
//
// The harness runs each fixture's block to completion, so arms are not
// interleaved run by run and the 1x medians carry a per-block warm-up: runs 0-1
// land ~70ms above runs 2-4 in *every* arm.  That is common-mode, and differencing
// run index i against run index i cancels it, exactly as the README's advice to
// reach for a within-run interval would.  Both are printed; where they disagree,
// the run-matched column is the one to read.
//
// Usage: node perf-harness/t32-tables.js <sweep.json> [<sweep.json> ...]

const fs = require('fs');

const METRICS = [
    ['external.loaderRemoved', r => r.external?.loaderRemoved],
    ['windows.toLoaderRemovedFrame', r => r.windows?.toLoaderRemovedFrame],
    ['windows.toDrained', r => r.windows?.toDrained],
    ['windows.drainGap', r => r.windows?.drainGap],
    ['frameLag.loaderRemoved', r => r.windows === undefined ? undefined
        : r.windows.toLoaderRemovedFrame - r.windows.toLoaderRemoved],
    ['frameLag.drained', r => r.windows === undefined ? undefined
        : r.windows.toDrainedFrame - r.windows.toDrained],
    ['taxonomyData.parse', r => r.spans?.['taxonomyData.parse']?.ms],
    ['taxonomyData.read', r => r.spans?.['taxonomyData.read']?.ms],
    ['phase.loading.start', r => r.marks?.['phase.loading.start']],
    ['phase.loading.duration', r => r.marks === undefined ? undefined
        : r.marks['phase.loading.end'] - r.marks['phase.loading.start']],
    ['heap.loaderRemoved', r => r.heap?.loaderRemoved / 1e6],
    ['metrics.ScriptDuration', r => r.metricsAtLoaderRemoved?.ScriptDuration],
    ['metrics.TaskDuration', r => r.metricsAtLoaderRemoved?.TaskDuration],
];

// Counters no arm here has any business moving: all three carry the same facts,
// the same report document and the same drain work.
const GUARDS = [
    'counts.factList.rowsBuilt',
    'counts.drain.viewer.containsAbsolute',
    'counts.drain.viewer.pass1Layout',
    'counts.drain.search.factCount',
    'counts.continuationMaps.items',
    'counts.sched.hops.viewer',
];

const r1 = x => Math.round(x * 10) / 10;

function stat(xs) {
    const ys = xs.filter(x => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
    if (!ys.length) {
        return null;
    }
    const mid = Math.floor(ys.length / 2);
    return {
        median: ys.length % 2 ? ys[mid] : (ys[mid - 1] + ys[mid]) / 2,
        min: ys[0],
        max: ys[ys.length - 1],
        spread: ys[ys.length - 1] - ys[0],
        n: ys.length,
    };
}

function variantOf(slug) {
    return slug.replace(/^[a-z]-/, '');
}

function main() {
    const files = process.argv.slice(2);
    if (!files.length) {
        console.error('usage: t32-tables.js <sweep.json> ...');
        process.exit(1);
    }

    for (const file of files) {
        const sweep = JSON.parse(fs.readFileSync(file));
        const order = sweep.results
            .filter(r => r.tier === sweep.tiers[0])
            .map(r => `${variantOf(r.slug)}`);
        console.log(`\n## ${file.replace(/^.*\//, '')}`);
        console.log(`\nChrome ${sweep.chrome}, ${sweep.runs} runs, level=${sweep.level}, `
            + `sweep order ${order.join(' -> ')}`);

        const byKey = {};
        for (const res of sweep.results) {
            byKey[`${variantOf(res.slug)}|${res.tier}`] = res;
        }
        const variants = [...new Set(sweep.results.map(r => variantOf(r.slug)))];
        const baseline = 'baseline';

        for (const tier of sweep.tiers) {
            console.log(`\n### ${tier}x\n`);
            const others = variants.filter(v => v !== baseline);
            const head = ['metric', `${baseline} median±spread`];
            for (const v of others) {
                head.push(`${v} median±spread`, `Δ vs ${baseline}`, 'Δ run-matched±spread');
            }
            console.log(`| ${head.join(' | ')} |`);
            console.log(`|${head.map(() => '---').join('|')}|`);

            for (const [name, get] of METRICS) {
                const base = byKey[`${baseline}|${tier}`];
                const bs = stat(base.runs.map(get));
                if (bs === null) {
                    continue;
                }
                const cells = [name, `${r1(bs.median)}±${r1(bs.spread)}`];
                for (const v of others) {
                    const arm = byKey[`${v}|${tier}`];
                    const as = stat(arm.runs.map(get));
                    /* Run index i against run index i: each fixture's block has the
                     * same internal warm-up, so this cancels it. */
                    const paired = arm.runs.map((run, i) => {
                        const b = get(base.runs[i]);
                        const a = get(run);
                        return typeof a === 'number' && typeof b === 'number' ? a - b : undefined;
                    });
                    const ps = stat(paired);
                    cells.push(`${r1(as.median)}±${r1(as.spread)}`,
                        `${r1(as.median - bs.median)}`,
                        ps === null ? '-' : `${r1(ps.median)}±${r1(ps.spread)}`);
                }
                console.log(`| ${cells.join(' | ')} |`);
            }

            console.log('\nGuard counters (must be identical across arms):\n');
            console.log(`| counter | ${variants.join(' | ')} |`);
            console.log(`|${['---', ...variants.map(() => '---')].join('|')}|`);
            for (const g of GUARDS) {
                const cells = variants.map(v => {
                    const res = byKey[`${v}|${tier}`];
                    const s = stat(res.runs.map(run => {
                        const [, ...rest] = g.split('.');
                        return run.counts?.[rest.join('.')];
                    }));
                    return s === null ? '-' : (s.spread === 0 ? `${s.median}` : `${s.median} (±${s.spread}!)`);
                });
                console.log(`| ${g} | ${cells.join(' | ')} |`);
            }
        }
    }
}

main();
