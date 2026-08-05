// Ticket 11's drain tables.  THROWAWAY - startup-slowness investigation only.
//
//   node perf-harness/report-drain.js <sweep.json> [...]
//
// Reads only; re-measures nothing.
//
// The drain is the one phase whose nested spans cannot be made to tile it, and
// that is a property of the thing rather than a gap in the instrumentation.
// viewer.postProcess() and ReportSearch.buildSearchIndex() are two generators
// resumed by two independent setTimeout(0) chains, so they interleave: each span
// is one pass's own accumulated work, measured with the clock stopped at every
// yield, while the phase is elapsed time shared between them plus whatever the
// browser chooses to run in the gaps.  `interleave` below is therefore a
// first-class quantity - elapsed minus work - and not a residual to be closed.
//
// Every figure is computed per run and only then reduced to a median, so it
// carries a spread.  Differencing medians would throw that away.
const fs = require('fs');

const VIEWER = ['drain.viewer.select', 'drain.viewer.pass1', 'drain.viewer.pass2'];
const SEARCH = ['drain.search.facts', 'drain.search.docs', 'drain.search.lunrAdd',
    'drain.search.lunrBuild', 'drain.search.doneCallback'];

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const spread = (xs) => (xs.length < 2 ? 0 : (Math.max(...xs) - Math.min(...xs)) / 2);
const f1 = (x) => (x === undefined || Number.isNaN(x) ? '-' : (Math.round(x * 10) / 10).toLocaleString('en-US'));
const f0 = (x) => (x === undefined || Number.isNaN(x) ? '-' : Math.round(x).toLocaleString('en-US'));
const f4 = (x) => (x === undefined || Number.isNaN(x) ? '-' : x.toPrecision(3));
const pct = (x, of) => (x === undefined || !of ? '-' : `${(100 * x / of).toFixed(1)}%`);
/* median±spread of a per-run series: the only form the evidence bar accepts. */
const pm = (xs, f = f1) => (xs.length ? `${f(median(xs))}±${f(spread(xs))}` : '-');

const span = (run, name) => run.spans?.[name]?.ms ?? 0;
const sum = (run, names) => names.reduce((a, n) => a + span(run, n), 0);
/* Within-run, because both marks carry the whole load's variance. */
const elapsed = (run) => run.windows?.drainGap;

function table(header, lines) {
    return [`| ${header.join(' | ')} |`,
        `|${header.map(() => '---').join('|')}|`, ...lines].join('\n');
}

function main() {
    const files = process.argv.slice(2);
    if (!files.length) {
        console.error('usage: report-drain.js <sweep.json> [...]');
        process.exit(1);
    }
    const rows = [];
    for (const file of files) {
        const j = JSON.parse(fs.readFileSync(file));
        for (const r of j.results) {
            rows.push({ ...r, level: j.level, review: j.review, chrome: j.chrome, file });
        }
    }
    const instr = rows.filter(r => r.arm === 'instrumented' || r.arm === undefined
        || String(r.arm).startsWith('ablate-none'));
    const slugs = [...new Set(instr.map(r => r.slug))];
    const tiers = [...new Set(instr.map(r => r.tier))].sort((a, b) => a - b);
    const out = [];

    out.push('# Ticket 11 — inside the post-load drain');
    out.push('');
    out.push(`Source: ${[...new Set(rows.map(r => r.file))].join(', ')}  `);
    out.push(`level=${instr[0]?.level} runs=${instr[0]?.runs?.length} `
        + `tiers=${tiers.join(',')} chrome=${instr[0]?.chrome}`);

    /* ---- 1. the split, per tier ---------------------------------------- */
    for (const tier of tiers) {
        out.push('', `## The drain split, ${tier}x`, '');
        out.push('`work` is the two passes\' own accumulated time; `interleave` is'
            + ' elapsed minus work — the setTimeout(0) gaps, and the layout, paint and'
            + ' GC the browser runs in them.');
        out.push('');
        const lines = [];
        for (const slug of slugs) {
            const r = instr.find(x => x.slug === slug && x.tier === tier);
            if (!r) continue;
            const runs = r.runs.filter(x => elapsed(x) !== undefined);
            if (!runs.length) continue;
            const el = runs.map(elapsed);
            const vw = runs.map(x => sum(x, VIEWER));
            const se = runs.map(x => sum(x, SEARCH));
            const wk = runs.map(x => sum(x, VIEWER) + sum(x, SEARCH));
            const iv = runs.map(x => elapsed(x) - sum(x, VIEWER) - sum(x, SEARCH));
            lines.push(`| \`${slug}\` | ${pm(el)} | ${pm(vw)} | ${pm(se)} `
                + `| ${pm(wk)} | ${pm(iv)} | ${pct(median(iv), median(el))} |`);
        }
        out.push(table(['fixture', 'drain elapsed', 'viewer pass', 'search index',
            'work', 'interleave', 'interleave %'], lines));
    }

    /* ---- 2. sub-phase detail ------------------------------------------- */
    for (const tier of tiers) {
        out.push('', `## Sub-phases, ${tier}x`, '');
        const cols = [...VIEWER, ...SEARCH];
        const lines = [];
        for (const slug of slugs) {
            const r = instr.find(x => x.slug === slug && x.tier === tier);
            if (!r) continue;
            lines.push(`| \`${slug}\` | `
                + cols.map(c => pm(r.runs.map(x => span(x, c)))).join(' | ') + ' |');
        }
        out.push(table(['fixture', ...cols.map(c => c.replace('drain.', ''))], lines));
    }

    /* ---- 3. CPU-boundness ---------------------------------------------- */
    if (tiers.length > 1) {
        const lo = tiers[0];
        const hi = tiers[tiers.length - 1];
        out.push('', `## Throttle ratio (${hi}x / ${lo}x)`, '');
        out.push('A term that does not scale with the throttle is not CPU-bound.'
            + ' Ratios are of medians: the two tiers are separate runs, so there is'
            + ' no run to pair them within.');
        out.push('');
        const cols = ['elapsed', 'viewer', 'search', 'work', 'interleave'];
        const lines = [];
        for (const slug of slugs) {
            const a = instr.find(x => x.slug === slug && x.tier === lo);
            const b = instr.find(x => x.slug === slug && x.tier === hi);
            if (!a || !b) continue;
            const val = (r, f) => median(r.runs.filter(x => elapsed(x) !== undefined).map(f));
            const fns = {
                elapsed, viewer: x => sum(x, VIEWER), search: x => sum(x, SEARCH),
                work: x => sum(x, VIEWER) + sum(x, SEARCH),
                interleave: x => elapsed(x) - sum(x, VIEWER) - sum(x, SEARCH),
            };
            lines.push(`| \`${slug}\` | `
                + cols.map(c => f1(val(b, fns[c]) / val(a, fns[c]))).join(' | ') + ' |');
        }
        out.push(table(['fixture', ...cols.map(c => `${c} ${hi}x/${lo}x`)], lines));
    }

    /* ---- 3b. what the interleave is ------------------------------------- */
    out.push('', `## What the interleave is, ${tiers[0]}x`, '');
    out.push('`runGenerator` resumes on `setTimeout(0)`, and after five levels of'
        + ' nesting Chrome clamps that to 4ms — so a yield is where elapsed time'
        + ' goes that no pass accounts for. The CDP columns are the drain\'s own'
        + ' renderer work, the difference between the two cumulative reads the'
        + ' harness already takes. **They are not a component of the interleave and'
        + ' must not be subtracted from it:** a `getBoundingClientRect` forces layout'
        + ' synchronously inside the JS frame, so most of this duration is spent'
        + ' inside the passes\' own spans, not between them.');
    out.push('');
    {
        const il = [];
        for (const slug of slugs) {
            const r = instr.find(x => x.slug === slug && x.tier === tiers[0]);
            if (!r) continue;
            const runs = r.runs.filter(x => elapsed(x) !== undefined && x.metrics
                && x.metricsAtLoaderRemoved);
            if (!runs.length) continue;
            const d = (x, k) => x.metrics[k] - x.metricsAtLoaderRemoved[k];
            const iv = runs.map(x => elapsed(x) - sum(x, VIEWER) - sum(x, SEARCH));
            const y = runs.map(x => (x.counts?.['drain.viewer.yields'] ?? 0)
                + (x.counts?.['drain.search.yields'] ?? 0));
            il.push(`| \`${slug}\` | ${pm(iv)} | ${pm(y, f0)} `
                + `| ${median(y) ? f1(median(iv) / median(y)) : '-'} `
                + `| ${pm(runs.map(x => d(x, 'RecalcStyleDuration')))} `
                + `| ${pm(runs.map(x => d(x, 'RecalcStyleCount')), f0)} `
                + `| ${pm(runs.map(x => d(x, 'LayoutDuration')))} `
                + `| ${pm(runs.map(x => d(x, 'ScriptDuration')))} |`);
        }
        out.push(table(['fixture', 'interleave', 'yields', 'interleave ms/yield',
            'drain recalc ms', 'drain recalcs', 'drain layout ms', 'drain script ms'], il));
    }

    /* ---- 4. scaling ----------------------------------------------------- */
    const tier = tiers[0];
    out.push('', `## What each term scales with, ${tier}x`, '');
    out.push('`containsAbsolute` is the counter ticket 07 named for the viewer\'s'
        + ' pass — containers carrying an absolutely positioned descendant, which is'
        + ' a different and much smaller set than `fcwn.absoluteSubNodes`.'
        + ' `tables` comes from the corpus dimension table and is here because'
        + ' ticket 05\'s conjunction predicts the per-node cost splits on it.');
    out.push('');
    let dims = {};
    try {
        const root = process.env.FIXTURE_ROOT
            || `${__dirname}/../.scratch/startup-slowness`;
        for (const d of JSON.parse(fs.readFileSync(`${root}/corpus/dimensions.json`))) {
            dims[d.slug] = d;
        }
    }
    catch (e) {
        out.push(`_(dimension table unavailable: ${e.message})_`);
        out.push('');
    }
    const lines = [];
    for (const slug of slugs) {
        const r = instr.find(x => x.slug === slug && x.tier === tier);
        if (!r) continue;
        const runs = r.runs.filter(x => elapsed(x) !== undefined);
        if (!runs.length) continue;
        const ca = median(runs.map(x => x.counts?.['drain.viewer.containsAbsolute'] ?? 0));
        const fc = median(runs.map(x => x.counts?.['drain.search.factCount'] ?? 0));
        const vw = median(runs.map(x => sum(x, VIEWER)));
        const se = median(runs.map(x => sum(x, SEARCH)));
        const nAbs = median(runs.map(x => x.counts?.['fcwn.absoluteSubNodes'] ?? NaN));
        lines.push(`| \`${slug}\` | ${f0(ca)} | ${f1(vw)} | ${ca ? f4(vw / ca) : '-'} `
            + `| ${f0(fc)} | ${f1(se)} | ${fc ? f4(se / fc) : '-'} `
            + `| ${f0(dims[slug]?.tables)} | ${Number.isNaN(nAbs) ? '-' : f0(nAbs)} |`);
    }
    out.push(table(['fixture', 'containsAbs', 'viewer ms', 'ms/container',
        'facts', 'search ms', 'ms/fact', 'tables', 'abs sub-nodes (deep only)'], lines));

    out.push('', '## Against ticket 07\'s predicted split', '');
    out.push('Ticket 07 could not mark these passes and separated the drain'
        + ' arithmetically instead: search index at **0.226 ms/fact**, calibrated on'
        + ' the six fixtures with zero absolute sub-nodes, and the viewer\'s pass as'
        + ' the residual. The marks now measure both directly. Where they disagree,'
        + ' the marks win.');
    out.push('');
    const pl = [];
    for (const slug of slugs) {
        const r = instr.find(x => x.slug === slug && x.tier === tier);
        if (!r) continue;
        const runs = r.runs.filter(x => elapsed(x) !== undefined);
        if (!runs.length) continue;
        const fc = median(runs.map(x => x.counts?.['drain.search.factCount'] ?? 0));
        const se = median(runs.map(x => sum(x, SEARCH)));
        const vw = median(runs.map(x => sum(x, VIEWER)));
        const el = median(runs.map(elapsed));
        const pred = 0.226 * fc;
        pl.push(`| \`${slug}\` | ${f1(el)} | ${f1(pred)} | ${f1(se)} `
            + `| ${f1(se - pred)} | ${f1(el - pred)} | ${f1(vw)} |`);
    }
    out.push(table(['fixture', 'drain elapsed', 't07 predicted search', 'measured search',
        'search error', 't07 implied viewer residual', 'measured viewer'], pl));

    /* ---- 5. counters ---------------------------------------------------- */
    out.push('', '## Counters', '');
    const cl = [];
    for (const slug of slugs) {
        const r = instr.find(x => x.slug === slug && x.tier === tier);
        if (!r) continue;
        const c = (k) => pm(r.runs.map(x => x.counts?.[k] ?? 0), f0);
        cl.push(`| \`${slug}\` | ${c('drain.viewer.containsAbsolute')} `
            + `| ${c('drain.viewer.pass1Layout')} | ${c('drain.viewer.noHighlight')} `
            + `| ${c('drain.search.factCount')} | ${c('drain.search.docsBuilt')} |`);
    }
    out.push(table(['fixture', 'containsAbsolute', 'pass1 layout reads', 'no-highlight added',
        'facts', 'docs built'], cl));

    console.log(out.join('\n'));
}

main();
