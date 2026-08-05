// Fit ticket-02's input dimensions against ticket-04's per-phase costs.
// THROWAWAY - for the startup-slowness investigation (ticket 07) only.
//
//   node perf-harness/fit-model.js <fixtureRoot>
//
// Reads t04's sweep (phase costs), t02's three dimension files, t05's stylesheet
// shape and t05's deep counters, then for every phase reports what predicts it.
// Writes markdown to stdout.  Nothing here measures; it only fits.
//
// FOUR METHOD CHOICES, because ten points cannot support a regression and the
// corpus spans four orders of magnitude on nearly every axis:
//
//  1. Classify before fitting.  A phase whose whole corpus range is comparable to
//     its own run-to-run spread is FLAT, and flat is an answer.  Fitting it
//     produces a large-looking rho off pure noise - the first draft of this script
//     "explained" `boot` with rho -0.69 on a phase that runs 6.9-8.5ms everywhere.
//
//  2. Spearman rank rho, not Pearson r, and the critical value is n-specific.
//     One fixture dominates any least-squares fit on raw values.
//
//  3. Count the axes that clear the bar.  When 20 of 45 size axes "predict" a
//     phase, the corpus has told you they are collinear, not that you found the
//     driver.  That count is printed for every phase and it is the single most
//     important number in this report.
//
//  4. Prefer a proportional fit to an exponent.  Where a phase has a direct work
//     counter (elements walked, poll ticks, facts indexed), k = y/x per fixture
//     with the range of k across fixtures is a stronger and more legible claim
//     than a log-log slope: it needs no regression at all.  A log-log exponent is
//     quoted only where no such counter exists, always with its R^2.
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
if (!root) {
    console.error('usage: node perf-harness/fit-model.js <fixtureRoot>');
    process.exit(1);
}
const rd = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

const sweep = rd('t04/t04-main-sweep.json');
const D = Object.fromEntries(rd('corpus/dimensions.json').map(r => [r.slug, r]));
const M = Object.fromEntries(rd('corpus/metadata-shape.json').map(r => [r.slug, r]));
const B = Object.fromEntries(rd('corpus/byte-composition.json').map(r => [r.slug, r]));
const S = Object.fromEntries(rd('t05/stylesheet-shape.json').map(r => [r.slug, r]));

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/* Deep counters, 1x arm.  A counter absent from a fixture's run is a STRUCTURAL
 * ZERO, not missing data: `fcwn.cellTextChars` is never emitted by a filing with
 * no tables, and that filing's true cell-text volume is 0.  Coalescing to 0 (not
 * dropping the row) is what lets every axis be fitted over the same n - the first
 * draft ranked a 7-point axis above a 9-point one and called it the winner. */
const deepCount = {};
for (const r of rd('t05/corpus-deep.json').results.filter(x => x.tier === 1 && x.arm === 'instrumented')) {
    const o = {};
    for (const [k, v] of Object.entries(r.summary)) {
        if (k.startsWith('counts.')) {
            o[k.replace('counts.', '')] = v.median;
        }
    }
    deepCount[r.slug] = o;
}
const dc = (s, k) => deepCount[s]?.[k] ?? 0;

const cdp = {};
for (const r of sweep.results.filter(x => x.arm === 'instrumented')) {
    cdp[`${r.slug}@${r.tier}`] = {
        recalcs: r.summary['metricsAtLoaderRemoved.RecalcStyleCount']?.median,
        nodes: r.summary['metrics.Nodes']?.median,
    };
}

/* ---------------- candidate axes ----------------
 * Every axis a reader might reach for, including the ones tickets 02 and 05
 * refuted - a refutation only convinces if the axis was actually tried.  `warn`
 * carries the earlier ticket's caveat to wherever the axis wins.
 *
 * `work: true` marks an axis that counts the loop's own iterations rather than a
 * property of the input.  Those get a proportional fit; they are also not
 * predictions, since you cannot know them without running the viewer. */
const AXES = [
    ['elements', s => D[s].elements],
    ['iframe_dom_elements', s => D[s].iframe_dom_elements],
    ['text_chars', s => D[s].text_chars],
    ['markup_chars', s => B[s].markup_chars],
    ['source_bytes', s => D[s].source_bytes, 'treacherous for JS phases (t02: 77-97% stylesheet on 2 fixtures)'],
    ['stub_bytes', s => D[s].stub_bytes],
    ['images', s => D[s].images],
    ['facts_visible', s => D[s].facts_visible],
    ['metadata_facts', s => M[s].metadata_facts],
    ['continuations', s => D[s].continuations],
    ['sum_fact_text_chars', s => D[s].sum_fact_text_chars],
    ['sum_fact_descendants', s => D[s].sum_fact_descendants],
    ['tables', s => D[s].tables],
    ['cells', s => D[s].cells],
    ['table_chars', s => D[s].table_chars],
    ['max_table_cells', s => D[s].max_table_cells],
    ['facts_in_cell', s => D[s].facts_in_cell],
    ['style_chars', s => B[s].style_chars, 'inverted (t05: 70.5/72.9MB of Aviva is inert data: URLs)'],
    ['matching_chars', s => S[s].matching_chars],
    ['css_rules', s => S[s].rules],
    ['position_rules', s => S[s].position_rules],
    ['metadata_concepts', s => M[s].metadata_concepts],
    ['metadata_roles', s => M[s].metadata_roles],
    ['pres_elrs', s => M[s].pres_elrs],
    ['label_chars', s => M[s].label_chars],
    ['aspects_per_fact_mean', s => M[s].aspects_per_fact_mean],
    ['sections', s => D[s].sections],
    ['rows', s => D[s].rows, 'saturated (t02: FACTS_PER_GROUP caps at 19/section on 8 of 10)'],
    /* work counters */
    ['continuationMaps.elementsWalked', s => dc(s, 'continuationMaps.elementsWalked'), null, true],
    ['iframePoll.ticks', s => dc(s, 'iframePoll.ticks'), null, true],
    ['fcwn.wrapNodeCalls', s => dc(s, 'fcwn.wrapNodeCalls'), null, true],
    ['fcwn.subNodesScanned', s => dc(s, 'fcwn.subNodesScanned'), null, true],
    ['fcwn.absoluteSubNodes', s => dc(s, 'fcwn.absoluteSubNodes'),
        'inverted alone (t05: nl-esef has more than Aviva, 1/99th the recalcs)', true],
    ['fcwn.cellTextChars', s => dc(s, 'fcwn.cellTextChars'), null, true],
    ['wrapNode.wrapped', s => dc(s, 'wrapNode.wrapped'), null, true],
    ['factList.rowsBuilt', s => dc(s, 'factList.rowsBuilt'), 'saturated, same cap', true],
    ['factList.factsInGroups', s => dc(s, 'factList.factsInGroups'), null, true],
    ['taxonomyData.chars', s => dc(s, 'taxonomyData.chars'), null, true],
    /* t05's conjunction, as single multiplicative terms */
    ['absSubNodes x tables', s => dc(s, 'fcwn.absoluteSubNodes') * D[s].tables, null, true],
    ['absSubNodes x cells', s => dc(s, 'fcwn.absoluteSubNodes') * D[s].cells, null, true],
    /* t05's conjunction in INPUT-only form.  `position_rules` is the upstream cause
     * of the absolutely positioned descendants (32,751 on Aviva, 1 on es-esef-huge-doc)
     * and `tables` is the layout mode the pathology needs, so the product is the one
     * form of t05's finding that can be read off a filing without running it. */
    ['position_rules x tables', s => S[s].position_rules * D[s].tables],
    ['position_rules x cells', s => S[s].position_rules * D[s].cells],
    /* the renderer's own count of the work.  Not an input dimension: included so
     * "cannot predict the cost" can be told apart from "cannot predict the count". */
    ['RecalcStyleCount', (s, t) => cdp[`${s}@${t}`]?.recalcs, null, true],
];

/* Wrapper nodes summed over the rows actually built, from ticket 06's corpus table
 * (`t06/t06-tables.md`, "per-wrapper-node cost of the htmlHidden test").  Embedded
 * rather than recomputed: it comes from a `LEVEL=deep` per-section counter that the
 * t04 sweep does not carry, and ticket 06 is closed, so the number is fixed.
 * `es-esef-huge-doc` has no outline and so builds no rows at all. */
const T06_WRAPPER_NODES = {
    'aviva-2025': 7897,
    'nl-esef-heavy-meta': 6782,
    'fr-esef-both-huge': 1868,
    'sec-lennar-stub': 1028,
    'sec-lennar-inline': 1028,
    'clorox-2022': 1002,
    'pl-esef-tiny-doc': 184,
    'gb-esef-mid': 87,
    'workiva-8k-2023': 19,
    'es-esef-huge-doc': 0,
};
AXES.push(['t06.wrapperNodes', s => T06_WRAPPER_NODES[s], null, true]);

const PHASES = require('./phases.js');

/* Mechanistically plausible axes per phase, from reading the code the phase runs
 * plus the earlier tickets' attributions.  This is the gate that stops a
 * collinear coincidence being reported as a driver: an axis wins only if some
 * statement in the phase can be shown to iterate over it. */
const MECHANISM = {
    parse: { axes: ['stub_bytes', 'source_bytes'],
        why: 'the browser parses the *host* document: the stub in stub mode, the whole filing inline' },
    metadata: { axes: ['taxonomyData.chars', 'stub_bytes', 'metadata_concepts', 'label_chars'],
        why: 'JSON.parse over the metadata blob, then ReportSet construction over its concepts' },
    loading: { axes: ['iframePoll.ticks', 'source_bytes'],
        why: 'a 250ms setInterval waiting for the source document to reach readyState complete '
            + '(ixbrlviewer.js:358); the browser must fetch and parse every byte, inert or not' },
    construct: { axes: ['continuationMaps.elementsWalked', 'elements', 'iframe_dom_elements', 'markup_chars'],
        why: '_buildContinuationMaps does find("body *") over every element of the report '
            + '(viewer.js:503) - elementsWalked is that loop\'s own counter' },
    preProcess: { axes: ['position_rules x tables', 'position_rules x cells', 'tables',
        'fcwn.subNodesScanned', 'fcwn.absoluteSubNodes', 'absSubNodes x tables',
        'absSubNodes x cells', 'RecalcStyleCount'],
        why: 't05: the classList.add write at viewer.js:374 invalidates style the next '
            + 'getComputedStyle must flush; cost is forced style recalculations, which need '
            + 'absolutely positioned descendants AND table layout' },
    prepare: { axes: ['fcwn.wrapNodeCalls', 'facts_visible', 'fcwn.absoluteSubNodes'],
        why: '_bindHandlers selects $(".ixbrl-element") (viewer.js:727), i.e. every wrapper node; '
            + 'setIXNodeMap is per fact' },
    inspectorPre: { axes: ['pres_elrs', 'sections', 'metadata_facts', 'metadata_concepts'],
        why: 'buildOutline builds a ReportSetOutline over the presentation ELRs; createSummary '
            + 'walks facts, namespaces and files. NB most of this phase is not either - see below' },
    toPrepare: { axes: ['tables', 'cells', 'max_table_cells', 'elements'],
        why: 'setProgress resolves on a double requestAnimationFrame, so no JS runs here - but the '
            + 'frame cannot be served until the renderer finishes the layout and paint the phase '
            + 'before it dirtied, which is table-layout work' },
    inspectorInit: { axes: ['t06.wrapperNodes', 'factList.rowsBuilt', 'rows', 'sections',
        'fcwn.absoluteSubNodes'],
        why: 't06: factListRow()\'s only style read is isHTMLHidden(), which walks every wrapper '
            + 'node the fact owns - including t05\'s ixbrl-sub-element descendants (viewer.js:481)' },
    drain: { axes: ['metadata_facts', 'fcwn.absoluteSubNodes'],
        why: 'two loops: buildSearchIndex over every fact (search.js:11) and postProcess over '
            + 'every .ixbrl-contains-absolute doing two forced-layout passes (viewer.js:1043)' },
};

/* Fixtures a phase must not be fitted over.  A zero entered for a fixture that
 * structurally cannot exhibit the phase is a fabricated point, not a datum. */
const EXCLUDE = {
    inspectorInit: { 'es-esef-huge-doc': 'no outline: 0 sections, 0 rows, buildFactListByGroup is 0.1ms' },
    inspectorPre: { 'es-esef-huge-doc': 'no outline: buildOutline is 0.2ms' },
    preProcess: { 'clorox-2022': 'DOM fact coverage 0.024 - walks 43 of the 1,812 facts it declares' },
    construct: { 'clorox-2022': 'DOM fact coverage 0.024' },
    prepare: { 'clorox-2022': 'DOM fact coverage 0.024' },
};

/* ---------------- phase costs ---------------- */

const markIn = (marks, spec) => {
    if (spec === null) {
        return 0;
    }
    for (const k of [].concat(spec)) {
        const n = k.replace(/^marks\./, '');
        if (marks?.[n] !== undefined) {
            return marks[n];
        }
    }
    return undefined;
};

const res = sweep.results.filter(r => r.arm === 'instrumented');
const slugs = [...new Set(res.map(r => r.slug))];
const tiers = [...new Set(res.map(r => r.tier))].sort((a, b) => a - b);
const at = (slug, tier) => res.find(r => r.slug === slug && r.tier === tier);

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

const cost = {};
for (const ph of PHASES) {
    cost[ph.key] = {};
    for (const tier of tiers) {
        cost[ph.key][tier] = {};
        for (const slug of slugs) {
            const xs = phaseRuns(at(slug, tier), ph);
            if (xs.length) {
                cost[ph.key][tier][slug] = { ms: median(xs), spread: Math.max(...xs) - Math.min(...xs) };
            }
        }
    }
}

/* ---------------- statistics ---------------- */

function rank(xs) {
    const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(xs.length);
    let i = 0;
    while (i < idx.length) {
        let j = i;
        while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) {
            j++;
        }
        const avg = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) {
            r[idx[k][1]] = avg;
        }
        i = j + 1;
    }
    return r;
}

function pearson(xs, ys) {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
        sxy += (xs[i] - mx) * (ys[i] - my);
        sxx += (xs[i] - mx) ** 2;
        syy += (ys[i] - my) ** 2;
    }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

const spearman = (xs, ys) => pearson(rank(xs), rank(ys));

function logFit(xs, ys) {
    const lx = xs.map(Math.log);
    const ly = ys.map(Math.log);
    const n = lx.length;
    const mx = lx.reduce((a, b) => a + b, 0) / n;
    const my = ly.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i++) {
        sxy += (lx[i] - mx) * (ly[i] - my);
        sxx += (lx[i] - mx) ** 2;
    }
    const b = sxx ? sxy / sxx : NaN;
    const a = my - b * mx;
    const r = pearson(lx, ly);
    return { b, r2: r * r, predict: x => Math.exp(a) * x ** b };
}

/* Least squares y = c + k*x.
 *
 * Needed because a bare proportional fit (k = y/x per fixture) is destroyed by
 * floor-dominated fixtures: `workiva-8k-2023` walks 368 elements and spends 12ms,
 * nearly all of it the fixed cost of entering the phase, which reports as a
 * per-element cost 97x everyone else's.  Fitting the floor explicitly separates
 * "what it costs to start" from "what it costs per unit", and both are things the
 * report needs to say. */
function affineFit(xs, ys) {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i++) {
        sxy += (xs[i] - mx) * (ys[i] - my);
        sxx += (xs[i] - mx) ** 2;
    }
    const k = sxx ? sxy / sxx : NaN;
    const c = my - k * mx;
    const r = pearson(xs, ys);
    return { c, k, r2: r * r };
}

/* Two-tailed p=0.05 critical values for Spearman rho. */
const RHO_CRIT = { 6: 0.886, 7: 0.786, 8: 0.738, 9: 0.700, 10: 0.648 };
const crit = n => RHO_CRIT[n] ?? 0.648;

function usable(phaseKey, tier) {
    const excl = EXCLUDE[phaseKey] ?? {};
    return slugs.filter(s => !excl[s] && cost[phaseKey][tier][s] !== undefined);
}

function fitAxis(axis, tier, phaseKey, keep) {
    const [name, get, warn, work] = axis;
    const pts = [];
    for (const slug of keep) {
        const x = get(slug, tier);
        const y = cost[phaseKey][tier][slug].ms;
        if (x === undefined || !Number.isFinite(x)) {
            return null;                    /* axis undefined here: drop the axis, not the fixture */
        }
        pts.push({ slug, x, y });
    }
    const rho = spearman(pts.map(p => p.x), pts.map(p => p.y));
    const pos = pts.filter(p => p.x > 0 && p.y > 0);
    const fit = pos.length >= 6 ? logFit(pos.map(p => p.x), pos.map(p => p.y)) : null;
    /* Proportional fit: k = y/x per fixture, over the fixtures where x > 0. */
    const ks = pos.map(p => ({ slug: p.slug, k: p.y / p.x }));
    /* Affine fit, and the per-unit cost each fixture implies once the fitted floor
     * is removed.  A fixture whose x is small enough that c dominates cannot say
     * anything about k, so those are dropped from the per-unit spread. */
    const aff = pts.length >= 3 ? affineFit(pts.map(p => p.x), pts.map(p => p.y)) : null;
    /* Keep only fixtures whose variable part is at least twice the fitted floor.
     * Below that, (y - c)/x is mostly the floor's own error divided by a small x,
     * which is how the first draft reported a 97x per-element spread for a phase
     * that fits at R^2 = 0.98. */
    const kAfter = aff
        ? pts.filter(p => p.x > 0 && aff.k * p.x > 2 * Math.max(aff.c, 0))
            .map(p => ({ slug: p.slug, k: (p.y - aff.c) / p.x }))
            .filter(x => x.k > 0)
        : [];
    return { name, warn, work, n: pts.length, rho, fit, aff, kAfter, pts, ks, nPos: pos.length };
}

/* ---------------- output ---------------- */

const out = [];
const f1 = x => (!Number.isFinite(x) ? '-' : (Math.round(x * 10) / 10).toLocaleString('en-US'));
const f2 = x => (!Number.isFinite(x) ? '-' : x.toFixed(2));
const short = s => s.replace(/^(...).*-(.{0,6})$/, '$1…$2');
const tbl = (hdr, lines) => [`| ${hdr.join(' | ')} |`, `|${hdr.map(() => '---').join('|')}|`,
    ...lines.map(l => `| ${l.join(' | ')} |`)].join('\n');

out.push('<!-- generated by perf-harness/fit-model.js -->');
out.push('');
out.push(`Source: \`t04/t04-main-sweep.json\` (stamp \`${sweep.stamp}\`, ${sweep.runs} runs, `
    + `tiers ${tiers.join('/')}×), \`t05/corpus-deep.json\`, ticket 02's three dimension files, `
    + '`t05/stylesheet-shape.json`. Nothing is re-measured here.');
out.push(`Machine: ${sweep.machine.model}, ${sweep.machine.cpus} cores. ${sweep.chrome}.`);

/* --- 1. classification --- */
out.push('', '## Is the phase even variable? (1×)', '');
out.push('A phase whose whole corpus range sits inside a few multiples of its own run-to-run '
    + 'spread has no scaling behaviour to model, and fitting it returns noise. `range` is '
    + 'max/min of the per-fixture medians; `spread` is the median per-fixture spread.');
out.push('');
const CLASS = {};
{
    const lines = [];
    for (const ph of PHASES) {
        const c = Object.values(cost[ph.key][1]);
        if (!c.length) {
            continue;
        }
        const mss = c.map(x => x.ms);
        const lo = Math.min(...mss);
        const hi = Math.max(...mss);
        const sp = median(c.map(x => x.spread));
        /* Two ways a phase carries no model: it is too small to time at all, or its
         * variation across the corpus is not bigger than one fixture's own noise. */
        const cls = hi < 2 ? 'below timer resolution'
            : (hi - lo) < 3 * sp ? 'flat'
                : 'variable';
        CLASS[ph.key] = cls;
        lines.push([`\`${ph.key}\``, f1(lo), f1(hi), `${(hi / Math.max(lo, 0.05)).toFixed(1)}×`,
            f1(sp), cls === 'variable' ? 'variable' : `**${cls}**`]);
    }
    out.push(tbl(['phase', 'min ms', 'max ms', 'range', 'median spread', 'class'], lines));
}

/* --- 2. cost and share --- */
for (const tier of tiers) {
    out.push('', `## Phase cost and share of the drained window — ${tier}×`, '');
    const lines = [];
    const win = Object.fromEntries(slugs.map(s => [s, at(s, tier).summary['windows.toDrained'].median]));
    for (const ph of PHASES) {
        const cells = slugs.map((slug) => {
            const c = cost[ph.key][tier][slug];
            return c ? `${f1(c.ms)} (${(100 * c.ms / win[slug]).toFixed(1)}%)`
                + `${(EXCLUDE[ph.key] ?? {})[slug] ? '\\*' : ''}` : '-';
        });
        if (!cells.every(c => c === '-')) {
            lines.push([`\`${ph.key}\``, ...cells]);
        }
    }
    out.push(tbl(['phase', ...slugs.map(short)], lines));
    out.push('');
    out.push('`\\*` = excluded from that phase\'s fit; the per-phase sections say why.');
}

/* --- 3. throttle --- */
if (tiers.length > 1) {
    const lo = tiers[0];
    const hi = tiers[tiers.length - 1];
    out.push('', `## Throttle sensitivity (${hi}×/${lo}×)`, '');
    out.push('4.0 means every millisecond of the phase is work the CPU does; 1.0 means the phase '
        + 'waits on something a slower CPU does not slow down. Ratios on phases under 2ms at 1× '
        + 'are timer quantisation and are suppressed.');
    out.push('');
    const lines = [];
    for (const ph of PHASES) {
        const rs = [];
        const cells = slugs.map((slug) => {
            const a = cost[ph.key][lo][slug];
            const b = cost[ph.key][hi][slug];
            if (!a || !b || a.ms < 2) {
                return '-';
            }
            rs.push(b.ms / a.ms);
            return f2(b.ms / a.ms);
        });
        if (rs.length) {
            lines.push([`\`${ph.key}\``, ...cells, `**${f2(median(rs))}**`,
                `${f2(Math.min(...rs))}–${f2(Math.max(...rs))}`]);
        }
    }
    out.push(tbl(['phase', ...slugs.map(short), 'median', 'range'], lines));
}

/* --- 4. per-phase fits --- */
out.push('', '## What predicts each phase (1×)', '');
const SUMMARY = [];
for (const ph of PHASES) {
    const tier = 1;
    const keep = usable(ph.key, tier);
    if (!keep.length) {
        continue;
    }
    out.push('', `### \`${ph.key}\` — ${ph.label}`, '');
    const excl = EXCLUDE[ph.key] ?? {};
    if (Object.keys(excl).length) {
        out.push(`Excluded: ${Object.entries(excl).map(([s, w]) => `\`${s}\` (${w})`).join('; ')}.`);
        out.push('');
    }
    if (CLASS[ph.key] !== 'variable') {
        const c = Object.values(cost[ph.key][tier]).map(x => x.ms);
        out.push(`**${CLASS[ph.key] === 'flat' ? 'Flat' : 'Below timer resolution'}** — `
            + `${f1(Math.min(...c))}–${f1(Math.max(...c))}ms across a corpus spanning `
            + `${(Math.max(...slugs.map(s => D[s].source_bytes)) / Math.min(...slugs.map(s => D[s].source_bytes))).toFixed(0)}× `
            + 'in source bytes. No input dimension drives it; there is nothing to fit.');
        SUMMARY.push([`\`${ph.key}\``, '— none needed', '-', 'constant', 'high']);
        continue;
    }

    const fits = AXES.map(a => fitAxis(a, tier, ph.key, keep)).filter(Boolean);
    const n = keep.length;
    const passing = fits.filter(f => Math.abs(f.rho) >= crit(n));
    fits.sort((x, y) => (Math.abs(y.rho) - Math.abs(x.rho)) || ((y.fit?.r2 ?? 0) - (x.fit?.r2 ?? 0)));

    out.push(`n = ${n}. **${passing.length} of ${fits.length} axes clear rho = ${crit(n)}** — `
        + `${passing.length > fits.length / 3
            ? 'the corpus cannot separate them, so "best rho" is not evidence of a driver'
            : 'few enough that the ranking carries some information'}.`);
    out.push('');
    out.push(tbl(['axis', 'rho', 'b (exponent)', 'R²', 'caveat'],
        fits.slice(0, 5).map(f => [`\`${f.name}\``,
            Math.abs(f.rho) >= crit(n) ? f2(f.rho) : `(${f2(f.rho)})`,
            f.fit && f.fit.r2 > 0.3 ? f2(f.fit.b) : '-',
            f.fit ? f2(f.fit.r2) : '-', f.warn ?? ''])));

    const mech = MECHANISM[ph.key];
    if (!mech) {
        out.push('', '**No mechanism identified.** Every axis above is a correlation with no '
            + 'statement behind it, so none is reported as a driver.');
        SUMMARY.push([`\`${ph.key}\``, '**unexplained**', '-', '-', 'none']);
        continue;
    }
    out.push('', `**Mechanism** — ${mech.why}.`);
    out.push('');
    const mfits = mech.axes.map(a => fits.find(f => f.name === a)).filter(Boolean);
    const kSpread = (f) => {
        const ks = f.kAfter.map(x => x.k).filter(k => k > 0);
        return ks.length >= 3 ? Math.max(...ks) / Math.min(...ks) : Infinity;
    };
    const propSpread = (f) => {
        const ks = f.ks.map(x => x.k).filter(k => k > 0);
        return ks.length >= 3 ? Math.max(...ks) / Math.min(...ks) : Infinity;
    };
    out.push(tbl(['mechanistic axis', 'rho', 'floor c (ms)', 'k (ms/unit)', 'affine R²',
        'k spread, floor removed', 'k spread, no floor'],
    mfits.map((f) => {
        const sp = kSpread(f);
        const pp = propSpread(f);
        return [`\`${f.name}\``, Math.abs(f.rho) >= crit(n) ? f2(f.rho) : `(${f2(f.rho)})`,
            f.aff ? f1(f.aff.c) : '-',
            f.aff ? f.aff.k.toPrecision(3) : '-',
            f.aff ? f2(f.aff.r2) : '-',
            Number.isFinite(sp) ? `${sp.toFixed(1)}× (n=${f.kAfter.length})` : 'too few above the floor',
            Number.isFinite(pp) ? `${pp.toFixed(1)}×` : '-'];
    })));

    /* Two winners, deliberately, because they answer different questions.
     *
     * The ticket asks which *input* dimension predicts the phase - something a
     * reader can read off a filing before opening it, which is what makes a
     * regression test or a "this filing will hurt" prediction possible.  A work
     * counter cannot do that job: you only know `elementsWalked` by running the
     * viewer.  But the counter is the better *explanation*, because it is the
     * loop's own iteration count, so a tight fit against it is a statement about
     * the loop rather than about which filings happen to be large.
     *
     * Reporting only the first understates what is understood; reporting only the
     * second overstates what is predictable. */
    const rank2 = (a, b) => ((b.aff?.r2 ?? 0) - (a.aff?.r2 ?? 0)) || (Math.abs(b.rho) - Math.abs(a.rho));
    const passingMech = mfits.filter(f => Math.abs(f.rho) >= crit(n));
    const bestInput = passingMech.filter(f => !f.work).sort(rank2)[0];
    const bestCounter = passingMech.filter(f => f.work).sort(rank2)[0];
    const best = bestCounter ?? bestInput;
    if (!best) {
        out.push('', '**Unexplained by any mechanistically plausible axis.** '
            + `The best of them is \`${mfits[0]?.name}\` at rho ${f2(mfits[0]?.rho)}, below `
            + `${crit(n)}.`);
        SUMMARY.push([`\`${ph.key}\``, '**unexplained**', '-', '-', 'none']);
        continue;
    }
    const kRange = kSpread(best);
    let shape;
    let conf;
    if (best.aff && best.aff.r2 >= 0.9) {
        shape = `linear: ${f1(best.aff.c)}ms floor + ${best.aff.k.toPrecision(3)} ms/unit`
            + `${Number.isFinite(kRange) ? `, per-unit cost varying ${kRange.toFixed(1)}×` : ''}`;
        conf = `high (affine R² ${f2(best.aff.r2)})`;
    } else if (best.work && kRange < 3) {
        shape = `linear: ${f1(best.aff.c)}ms floor + ${best.aff.k.toPrecision(3)} ms/unit `
            + `(per-unit cost varies ${kRange.toFixed(1)}×)`;
        conf = `medium (affine R² ${f2(best.aff.r2)})`;
    } else if (best.fit && best.fit.r2 >= 0.7) {
        shape = `~x^${f2(best.fit.b)} (log-log R² ${f2(best.fit.r2)})`;
        conf = passing.length > fits.length / 3 ? 'low (axis is collinear with many others)' : 'medium';
    } else {
        shape = 'ordering only — magnitude not predicted';
        conf = 'low';
    }
    out.push('');
    if (bestInput && bestCounter && bestInput !== bestCounter) {
        out.push(`Best **input** axis (knowable without running the viewer): \`${bestInput.name}\`. `
            + `Best **work counter** (the loop's own iteration count, and the better explanation, `
            + `but not a prediction): \`${bestCounter.name}\`.`);
    } else if (!bestInput) {
        out.push(`**No input dimension predicts this phase** — only the work counter `
            + `\`${bestCounter.name}\` does, and that cannot be read off a filing. `
            + 'A regression test for this phase has to run the viewer and assert on the counter.');
    }
    /* A phase with two populations has no single shape, so the summary must send the
     * reader to the classifier rather than print an exponent fitted across both. */
    const BIMODAL = { preProcess: 'threshold, not a curve — see the `preProcess` section' };
    SUMMARY.push([`\`${ph.key}\``,
        bestInput ? `\`${bestInput.name}\`${bestInput.warn ? ' ⚠' : ''}` : '**none**',
        best.work ? `\`${best.name}\`` : '(same)',
        BIMODAL[ph.key] ?? shape,
        BIMODAL[ph.key] ? 'kind yes, degree no' : conf]);
    if (bestInput?.warn) {
        out.push('', `⚠ \`${bestInput.name}\` is ${bestInput.warn} — the caveat travels with the `
            + 'claim wherever it is quoted.');
    }

    if (best.fit) {
        const rs = best.pts.filter(p => p.x > 0 && p.y > 0)
            .map(p => ({ slug: p.slug, ratio: p.y / best.fit.predict(p.x) }))
            .sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)));
        const bad = rs.filter(r => r.ratio > 2 || r.ratio < 0.5);
        out.push('', `Residuals against \`${best.name}\`^${f2(best.fit.b)}: `
            + rs.map(r => `\`${r.slug}\` ${r.ratio.toFixed(2)}×`).join(', ') + '.');
        if (bad.length) {
            out.push('');
            out.push(`**Named residuals** (>2× or <0.5×): ${bad.map(r => `\`${r.slug}\` `
                + `${r.ratio.toFixed(2)}×`).join(', ')}. A miss this large on a 9-point fit means `
                + 'a dimension is missing, not that the fixture is odd.');
        }
    }
    if (best.work && best.kAfter.length) {
        out.push('', 'Per-unit cost by fixture, fitted floor removed: '
            + `${best.kAfter.slice().sort((a, b) => b.k - a.k)
                .map(x => `\`${x.slug}\` ${x.k.toPrecision(3)}`).join(', ')} ms/unit `
            + `(${Number.isFinite(kRange) ? `${kRange.toFixed(1)}× spread` : 'too few points'}).`);
    }
}

/* --- 5. the two phases whose mechanism has two terms ---
 * Both are worth separating by hand rather than fitting, because the corpus
 * happens to pin one term exactly: six fixtures have zero absolutely positioned
 * sub-nodes, so on those the wrapper-node term is absent by construction and
 * whatever remains is the other term alone. */
out.push('', '## Two-term phases: `drain`, separated', '');
{
    const zero = slugs.filter(s => dc(s, 'fcwn.absoluteSubNodes') < 100);
    const nonzero = slugs.filter(s => dc(s, 'fcwn.absoluteSubNodes') >= 100);
    out.push('`viewer.postProcess()` walks `.ixbrl-contains-absolute` doing two forced-layout '
        + 'passes; `buildSearchIndex` walks every fact. On a filing with no absolutely positioned '
        + 'sub-nodes the first loop has nothing to visit, so the drain there *is* the search index '
        + 'and nothing else — which calibrates the per-fact cost with no fitting at all.');
    out.push('');
    out.push(tbl(['fixture', 'absolute sub-nodes', 'drain 1× ms', 'metadata facts', 'ms/fact'],
        zero.map(s => [`\`${s}\``, f1(dc(s, 'fcwn.absoluteSubNodes')), f1(cost.drain[1][s].ms),
            f1(M[s].metadata_facts), (cost.drain[1][s].ms / M[s].metadata_facts).toPrecision(3)])));
    /* Calibrate on the zero-set, excluding any fixture with too few facts to divide by. */
    const cal = zero.filter(s => M[s].metadata_facts >= 100)
        .map(s => cost.drain[1][s].ms / M[s].metadata_facts);
    const perFact = median(cal);
    out.push('');
    out.push(`Per-fact search-index cost: **${perFact.toPrecision(3)} ms/fact** `
        + `(median of ${cal.length}, range ${Math.min(...cal).toPrecision(3)}–`
        + `${Math.max(...cal).toPrecision(3)}). `
        + '`workiva-8k-2023` is excluded from the calibration: 25 facts is too few to divide by.');
    out.push('');
    out.push('Applying that to the three filings that *do* have absolute sub-nodes leaves the '
        + 'residual the postProcess layout pass must account for:');
    out.push('');
    out.push(tbl(['fixture', 'drain 1× ms', 'facts', 'predicted search ms', 'residual ms',
        'absolute sub-nodes', 'ms per sub-node', 'tables'],
    nonzero.map((s) => {
        const y = cost.drain[1][s].ms;
        const pred = perFact * M[s].metadata_facts;
        const abs = dc(s, 'fcwn.absoluteSubNodes');
        return [`\`${s}\``, f1(y), f1(M[s].metadata_facts), f1(pred), f1(y - pred),
            f1(abs), ((y - pred) / abs).toPrecision(3), f1(D[s].tables)];
    })));
}

/* --- 6. the progress hops, which are not where the phase table implies ---
 * `toPrepare` is a setProgress hop by construction, but setProgress is called four
 * times and only one of those gaps is its own phase.  The other three sit *inside*
 * named phases, so the phase table attributes pure waiting to phases whose labels
 * say work.  Worth quantifying because it changes which cost centres are
 * computational and which are latency. */
/* --- 5b. preProcess is bimodal, so the model is a classifier, not a curve --- */
out.push('', '## `preProcess` is a threshold, not a curve', '');
{
    const rows = slugs.map((s) => {
        const ms = cost.preProcess[1][s].ms;
        const pos = S[s].position_rules;
        const tab = D[s].tables;
        return { s, ms, pos, tab, abs: dc(s, 'fcwn.absoluteSubNodes'), pred: pos > 0 && tab > 0 };
    }).sort((a, b) => b.ms - a.ms);
    out.push('Fitting any curve to this phase averages two populations. Two filings exhibit the '
        + 'style-recalculation pathology t05 attributed and pay seconds; the other eight pay '
        + 'milliseconds. The useful model is therefore a *classifier* — which filings hit it — plus '
        + 'the honest admission that nothing here predicts how hard.');
    out.push('');
    out.push(tbl(['fixture', '`preProcess` 1× ms', 'rules setting `position`', 'tables',
        'absolute sub-nodes', '`position_rules>0 && tables>0`'],
    rows.map(r => [`\`${r.s}\``, f1(r.ms), f1(r.pos), f1(r.tab), f1(r.abs),
        r.pred ? '**yes**' : 'no'])));
    const hit = rows.filter(r => r.pred);
    const miss = rows.filter(r => !r.pred);
    out.push('');
    out.push(`The two-term conjunction of **static, input-side** properties separates the corpus `
        + `perfectly: it is true for exactly ${hit.map(r => `\`${r.s}\``).join(' and ')} `
        + `(${f1(Math.min(...hit.map(r => r.ms)))}–${f1(Math.max(...hit.map(r => r.ms)))}ms) and `
        + `false for all ${miss.length} others (${f1(Math.min(...miss.map(r => r.ms)))}–`
        + `${f1(Math.max(...miss.map(r => r.ms)))}ms). Unlike \`fcwn.absoluteSubNodes\`, both terms `
        + 'can be read off a filing without running the viewer.');
    out.push('');
    out.push('**Two things this classifier cannot do, and the report must say both.**');
    out.push('');
    out.push('1. *It does not order the two positives.* `fr-esef-both-huge` has 1.6× Aviva\'s '
        + '`position_rules` and 1.7× its `tables` — 2.7× the product — and is **6.6× cheaper** '
        + `(${f1(rows.find(r => r.s === 'fr-esef-both-huge').ms)}ms against `
        + `${f1(rows.find(r => r.s === 'aviva-2025').ms)}ms). Kind, not degree.`);
    out.push('');
    out.push('2. *The corpus never tests where the threshold sits.* Every fixture is at one '
        + 'extreme of both terms: the four with `tables > 0` and no pathology have **exactly zero** '
        + 'rules setting `position`, and the three with a nonzero-but-small count (1, 5, 12) have '
        + '**exactly zero** tables. No filing has, say, 50 `position` rules and 300 tables, so the '
        + 'corpus cannot say whether that filing is pathological. This is the one place a '
        + 'synthetic generator — ruled out of scope by the map — would have earned its keep, and '
        + 'the strongest argument for revisiting that call.');
}

out.push('', '## The four `setProgress` hops, and where the phase table puts them', '');
{
    const MARKED_PRE = ['inspector.bindStaticHandlers', 'inspector.initializeTooltips',
        'inspector.initializeReviewMode', 'inspector.buildMenus', 'inspector.buildLanguages',
        'inspector.localize', 'inspector.createSummary', 'inspector.buildOutline',
        'inspector.initializeZoom'];
    out.push('`setProgress` resolves on a double `requestAnimationFrame`. Its total wait is a '
        + 'cross-phase span (`setProgress.wait`, n=4). One hop is the `toPrepare` phase; the rest '
        + 'are inside `inspectorPre` and before `phase.loading`. Subtracting `inspectorPre`\'s '
        + 'marked spans from the phase shows how much of a phase labelled "inspector setup" is '
        + 'actually a progress hop.');
    out.push('');
    out.push(tbl(['fixture', 'setProgress.wait total (4 hops)', '`toPrepare` (1 hop)',
        '`inspectorPre`', 'its marked spans', 'unmarked remainder', 'unmarked share'],
    slugs.map((s) => {
        const r = at(s, 1);
        const wait = r.summary['spans.setProgress.wait.ms']?.median ?? 0;
        const pre = cost.inspectorPre[1][s].ms;
        const marked = MARKED_PRE.reduce((a, sp) => a + (r.summary[`spans.${sp}.ms`]?.median ?? 0), 0);
        return [`\`${s}\``, f1(wait), f1(cost.toPrepare[1][s].ms), f1(pre), f1(marked),
            f1(pre - marked), `${(100 * (pre - marked) / pre).toFixed(0)}%`];
    })));
    const ratios = slugs.map((s) => {
        const a = cost.toPrepare[1][s];
        const b = cost.toPrepare[4][s];
        return b.ms / a.ms;
    });
    out.push('');
    out.push(`The hops are **not fixed latency**: \`toPrepare\` scales ${f2(Math.min(...ratios))}–`
        + `${f2(Math.max(...ratios))}× (median ${f2(median(ratios))}×) under a 4× CPU throttle. `
        + 'A double-rAF hop waits for the renderer to finish the layout and paint the previous '
        + 'phase dirtied, and that work slows with the CPU like any other.');
}

out.push('', '## Summary', '');
out.push(tbl(['phase', 'input driver', 'work counter', 'shape', 'confidence'], SUMMARY));

console.log(out.join('\n'));
