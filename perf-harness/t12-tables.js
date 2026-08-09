// Ticket 12's tables.  THROWAWAY - startup-remediation effort only.
//
//   node perf-harness/t12-tables.js <sweep.json> [...]
//
// Reads only; re-measures nothing.  Every figure is computed per run and only then
// reduced to a median, so it carries a spread; every cross-arm figure is paired by
// run index against a baseline arm measured in the SAME session, alternating run
// by run.
//
// Ticket 12 asks for a measured position on three directions - move the index
// build off the startup path, index less, or replace lunr - and they are nested:
// direction 1 removes everything the other two could remove and more.  So the
// ceiling of direction 1 bounds the whole ticket, and two arms price all three.
//
// Two pairings, because the ceiling has to be quoted in two worlds:
//
//   searchnoindex     vs none      the ceiling today
//   searchnoindexmsg  vs yieldmsg  the ceiling once ticket 22 merges ticket 20
//   searchnolunr      vs none      the ceiling of directions 2 and 3 together
//
// The two-world pairing is not decoration.  On seven of ten fixtures the search
// generator is the TAIL of the drain and its hops are most of the drain gap, and
// those are the same hops ticket 20 already claims -300.7 ms of.  Quoting the
// `none` pairing alone would bank that overlap twice.
const fs = require('fs');

const SWEEPS = process.argv.slice(2);
if (!SWEEPS.length) {
    console.error('usage: t12-tables.js <sweep.json> [...]');
    process.exit(1);
}

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const spread = (xs) => (xs.length < 2 ? 0 : (Math.max(...xs) - Math.min(...xs)) / 2);
const f1 = (x) => (x === null || x === undefined || !Number.isFinite(x)
    ? '-' : (Math.round(x * 10) / 10).toLocaleString('en-US'));

/* The map's floor: below this a change cannot be told from session drift. */
const FLOOR = 50;

/* Each candidate arm and the arm it must be paired against.  A ceiling arm paired
 * against the wrong baseline is a double-count, not a rounding error. */
const PAIRS = [
    ['searchnoindex', 'none', 'direction 1 ceiling, world as it is'],
    ['searchnoindexmsg', 'yieldmsg', 'direction 1 ceiling, world where ticket 22 merges'],
    ['searchnolunr', 'none', 'directions 2+3 ceiling'],
];

/* Both windows, always, never collapsed.  external.loaderRemoved is the only
 * cross-arm comparable absolute - it is timed by the harness's injected
 * MutationObserver rather than by the build's own marks. */
const loaderRemoved = (r) => r.external?.loaderRemoved;
const drained = (r) => r.windows?.toDrained;
const drainGap = (r) => r.windows?.drainGap;
/* Within-run, so it carries none of the whole load's variance.  The map's rule:
 * work removed from startup has three places to reappear and only frameLag can
 * see the third. */
const frameLagLoader = (r) => r.windows?.toLoaderRemovedFrame - r.windows?.toLoaderRemoved;
const frameLagDrained = (r) => r.windows?.toDrainedFrame - r.windows?.toDrained;
/* Ticket 24's surviving quantity: nav start to the first frame the user could act
 * on.  A window delta handed straight back here is not a win. */
const toActionable = (r) => loaderRemoved(r) + frameLagLoader(r);
const toDrainedFrame = (r) => r.windows?.toDrainedFrame;

/* The two drain generators' own end marks.  These are the structural fact this
 * ticket turns on: whichever is later IS windows.toDrained, so an arm that empties
 * the search generator can only move the window on a fixture where search is the
 * tail - or by removing interleave from the viewer's slices. */
const viewerEnd = (r) => r.marks?.['viewer.postLoadAsync.end'];
const inspectorEnd = (r) => r.marks?.['inspector.postLoadAsync.end'];

const span = (k) => (r) => r.spans?.[k]?.ms;
const count = (k) => (r) => r.counts?.[k];
const searchWork = (r) => ['drain.search.facts', 'drain.search.docs', 'drain.search.lunrAdd',
    'drain.search.lunrBuild', 'drain.search.doneCallback']
    .reduce((a, k) => a + (r.spans?.[k]?.ms ?? 0), 0);

const groups = {};
let stamp = [], chrome = [];
for (const f of SWEEPS) {
    const j = JSON.parse(fs.readFileSync(f));
    stamp.push(j.stamp);
    chrome.push(j.chrome);
    for (const a of j.results) {
        (groups[`${a.slug}|${a.tier}`] ??= {})[a.ablate] = a.runs.filter(r => !r.error);
    }
}
const slugs = [...new Set(Object.keys(groups).map(k => k.split('|')[0]))].sort();
const tiers = [...new Set(Object.keys(groups).map(k => Number(k.split('|')[1])))]
    .sort((a, b) => a - b);

/* Paired: the delta is computed per run index and only then reduced, so it has a
 * spread of its own.  Differencing two medians would throw that away, and the
 * evidence bar is "a delta larger than the measured spread". */
function paired(arms, arm, base, f) {
    if (!arms?.[base] || !arms[arm]) {
        return null;
    }
    const n = Math.min(arms[base].length, arms[arm].length);
    const d = [];
    for (let i = 0; i < n; i++) {
        const v = f(arms[arm][i]) - f(arms[base][i]);
        if (Number.isFinite(v)) {
            d.push(v);
        }
    }
    if (!d.length) {
        return null;
    }
    const m = median(d), s = spread(d);
    return { m, s, resolved: Math.abs(m) > s };
}
const cell = (p) => (p === null ? '-'
    : `${p.m > 0 ? '+' : ''}${f1(p.m)}±${f1(p.s)}${p.resolved ? '' : ' *ns*'}`);

function baseCell(arms, base, f) {
    const b = (arms?.[base] ?? []).map(f).filter(Number.isFinite);
    return b.length ? `${f1(median(b))}±${f1(spread(b))}` : '-';
}

/* ------------------------------------------------------------------ */
/* The structural table: which generator is the tail, on the baseline. */
function structure(tier) {
    console.log(`\n### Which drain generator is the tail — ${tier}×, \`none\` arm only\n`);
    console.log('`windows.toDrained` is the later of the two `postLoadAsync.end` marks, so this decides'
        + ' the shape of every delta below.\n');
    console.log('| slug | drain gap | viewer end | search end | tail | search lead | search work | hops.search |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const slug of slugs) {
        const arms = groups[`${slug}|${tier}`];
        if (!arms?.none) {
            continue;
        }
        const runs = arms.none;
        const lead = runs.map(r => inspectorEnd(r) - viewerEnd(r)).filter(Number.isFinite);
        const l = median(lead);
        console.log(`| \`${slug}\` | ${baseCell(arms, 'none', drainGap)} `
            + `| ${f1(median(runs.map(viewerEnd)))} | ${f1(median(runs.map(inspectorEnd)))} `
            + `| ${l > 0 ? '**search**' : 'viewer'} | ${f1(l)}±${f1(spread(lead))} `
            + `| ${f1(median(runs.map(searchWork)))} | ${f1(median(runs.map(count('sched.hops.search'))))} |`);
    }
}

/* ------------------------------------------------------------------ */
function table(tier, arm, base, cols, label, note) {
    console.log(`\n### ${label} — ${tier}×, \`${arm}\` paired against each fixture's own \`${base}\` arm\n`);
    if (note) {
        console.log(`${note}\n`);
    }
    console.log('| slug | ' + cols.map(c => c[0]).join(' | ') + ' |');
    console.log('|---|' + cols.map(() => '---').join('|') + '|');
    for (const slug of slugs) {
        const arms = groups[`${slug}|${tier}`];
        if (!arms?.[base] || !arms[arm]) {
            continue;
        }
        console.log(`| \`${slug}\` | ` + cols.map(c => c[1](arms)).join(' | ') + ' |');
    }
}

/* Worst-filing milliseconds removed at 1x is the map's ranking key; breadth is how
 * many fixtures clear the floor with a delta larger than its own spread.  Three
 * rulers, per the map's Notes - resolved and above-floor are printed separately
 * and never collapsed into one number. */
function ranking(tier, arm, base, metrics) {
    console.log(`\n### Ranking key — ${tier}×, \`${arm}\` vs \`${base}\`\n`);
    console.log('| metric | worst-filing Δ | on | resolved | breadth (resolved and ≥ 50 ms) |');
    console.log('|---|---|---|---|---|');
    for (const [label, f] of metrics) {
        let best = null, bestSlug = '';
        const breadth = [], res = [];
        for (const slug of slugs) {
            const p = paired(groups[`${slug}|${tier}`], arm, base, f);
            if (!p) {
                continue;
            }
            if (best === null || p.m < best) {
                best = p.m;
                bestSlug = slug;
            }
            if (p.resolved) {
                res.push(slug);
                if (-p.m >= FLOOR) {
                    breadth.push(slug);
                }
            }
        }
        console.log(`| ${label} | ${f1(best)} | \`${bestSlug}\` | ${res.length}/${slugs.length} | `
            + `${breadth.length}/${slugs.length}`
            + (breadth.length ? ` — ${breadth.map(s => `\`${s}\``).join(', ')}` : '') + ' |');
    }
}

/* The guard table.  Every counter here runs to completion BEFORE the drain starts,
 * or belongs to the viewer's generator, so no search arm has any business moving
 * one.  drain.viewer.* is the rule that already caught a 19-second false finding. */
const GUARD_KEYS = ['drain.viewer.containsAbsolute', 'drain.viewer.pass1Layout',
    'drain.viewer.noHighlight', 'drain.viewer.yields', 'factList.rowsBuilt',
    'factList.htmlHiddenTests', 'factList.groups', 'outline.buildElrs',
    'outline.buildFactsWalked', 'continuationMaps.elementsWalked',
    'taxonomyData.chars'];
/* The mechanism counters, which these arms ARE entitled to move - printed apart so
 * a reader never has to guess which table a number belongs in.
 *
 * reports.factsCalls is here rather than in the guard table, and it was the guard
 * table that caught it: buildSearchIndex opens with this._reportSet.facts() and the
 * startup query reads facts().length, so a searchnoindex arm removes exactly two of
 * the baseline's eight calls.  That is the ablation working, not a leak.  It IS
 * still a guard for searchnolunr, which keeps both call sites - so read the column
 * per arm rather than per table. */
const MECH_KEYS = ['drain.search.factCount', 'drain.search.docsBuilt', 'drain.search.yields',
    'searchList.rowsBuilt', 'searchList.htmlHiddenTests', 'sched.hops.search',
    'sched.hops.viewer', 'reports.factsCalls', 'reports.factsItemsScanned'];

function counters(tier, arm, base, keys, label, note) {
    console.log(`\n### ${label} — ${tier}×  (\`${base}\` → \`${arm}\`, min = max over all runs required)\n`);
    if (note) {
        console.log(`${note}\n`);
    }
    console.log('| slug | ' + keys.map(k => `\`${k.split('.').pop()}\``).join(' | ') + ' | moved |');
    console.log('|---|' + keys.map(() => '---').join('|') + '|---|');
    for (const slug of slugs) {
        const arms = groups[`${slug}|${tier}`];
        if (!arms?.[base] || !arms[arm]) {
            continue;
        }
        const cells = [], moved = [];
        for (const k of keys) {
            const a = arms[base].map(count(k)).filter(Number.isFinite);
            const b = arms[arm].map(count(k)).filter(Number.isFinite);
            const stable = (xs) => xs.length && Math.min(...xs) === Math.max(...xs);
            const va = a.length ? median(a) : null;
            const vb = b.length ? median(b) : null;
            if (va === null && vb === null) {
                cells.push('-');
                continue;
            }
            /* A counter emitted by a site the arm never reaches comes back missing
             * rather than zero.  That is a fact about the arm, not a broken run, so
             * it is printed as `absent` and counted as moved. */
            if (vb === null) {
                cells.push(`${f1(va)} → *absent*`);
                moved.push(k.split('.').pop());
                continue;
            }
            const same = va === vb && stable(a) && stable(b);
            cells.push(same ? `${f1(va)}` : `${f1(va)} → ${f1(vb)}`);
            if (!same) {
                moved.push(k.split('.').pop());
            }
        }
        console.log(`| \`${slug}\` | ${cells.join(' | ')} | ${moved.length ? moved.join(', ') : '**0**'} |`);
    }
}

/* The segment split on the baseline.  This is an ATTRIBUTION, not a payoff, and
 * the map's rule says so twice over - it ranks the cost and says nothing about the
 * recovery.  It is here so directions 2 and 3 can be sized if direction 1 declines,
 * and every number in it is bounded above by the searchnolunr column beside it. */
function segments(tier) {
    console.log(`\n### Where the search pass's own time goes — ${tier}×, \`none\` arm\n`);
    console.log('An attributed cost, never a payoff (map Notes).  `lunrAdd + lunrBuild` is what'
        + ' direction 3 attacks, `docs` is what direction 2 attacks, `doneCallback` is ticket 13.\n');
    console.log('| slug | facts | docs | lunrAdd | lunrBuild | doneCallback | total | lunr share | drain gap |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    for (const slug of slugs) {
        const arms = groups[`${slug}|${tier}`];
        if (!arms?.none) {
            continue;
        }
        const m = (k) => median(arms.none.map(span(k)).filter(Number.isFinite));
        const fa = m('drain.search.facts'), dc = m('drain.search.docs');
        const la = m('drain.search.lunrAdd'), lb = m('drain.search.lunrBuild');
        const cb = m('drain.search.doneCallback');
        const tot = fa + dc + la + lb + cb;
        console.log(`| \`${slug}\` | ${f1(fa)} | ${f1(dc)} | ${f1(la)} | ${f1(lb)} | ${f1(cb)} `
            + `| ${f1(tot)} | ${tot ? Math.round(100 * (la + lb) / tot) : '-'}% `
            + `| ${baseCell(arms, 'none', drainGap)} |`);
    }
}

/* ------------------------------------------------------------------ */
console.log('# Ticket 12 — tables\n');
console.log(`Sweeps: ${SWEEPS.map(s => `\`${s.split('/').pop()}\``).join(', ')}  `);
console.log(`Sessions: ${stamp.map(s => `\`${s}\``).join(', ')}  `);
console.log(`Chrome: ${[...new Set(chrome)].map(c => `\`${c}\``).join(', ')}`);
console.log('\nEvery delta is paired by run index within one session.  No absolute here may be'
    + ' differenced against another ticket\'s: the map records three different Chrome builds'
    + ' across this effort.');

const WINDOW_COLS = (arm, base) => [
    [`\`${base}\` loaderRemoved`, (a) => baseCell(a, base, loaderRemoved)],
    ['Δ loaderRemoved', (a) => cell(paired(a, arm, base, loaderRemoved))],
    [`\`${base}\` drained`, (a) => baseCell(a, base, drained)],
    ['**Δ drained**', (a) => cell(paired(a, arm, base, drained))],
    ['Δ drainGap', (a) => cell(paired(a, arm, base, drainGap))],
    ['Δ toDrainedFrame', (a) => cell(paired(a, arm, base, toDrainedFrame))],
];
const FRAME_COLS = (arm, base) => [
    ['Δ frameLag.loaderRemoved', (a) => cell(paired(a, arm, base, frameLagLoader))],
    ['Δ frameLag.drained', (a) => cell(paired(a, arm, base, frameLagDrained))],
    ['Δ loaderRemoved + frameLag', (a) => cell(paired(a, arm, base, toActionable))],
    ['Δ viewer.postLoadAsync.end', (a) => cell(paired(a, arm, base, viewerEnd))],
    ['Δ search work', (a) => cell(paired(a, arm, base, searchWork))],
];
const RANK_METRICS = [
    ['`windows.toDrained`', drained],
    ['`external.loaderRemoved`', loaderRemoved],
    ['`windows.drainGap`', drainGap],
    ['`windows.toDrainedFrame`', toDrainedFrame],
];

for (const tier of tiers) {
    console.log(`\n\n## ${tier}× tier\n`);
    structure(tier);
    segments(tier);
    for (const [arm, base, why] of PAIRS) {
        const present = slugs.some(s => groups[`${s}|${tier}`]?.[arm]);
        if (!present) {
            continue;
        }
        console.log(`\n\n## \`${arm}\` vs \`${base}\` — ${why} — ${tier}×`);
        table(tier, arm, base, WINDOW_COLS(arm, base), 'Both windows');
        table(tier, arm, base, FRAME_COLS(arm, base), 'Frame lag, the actionable sum, and where the work went',
            'The map\'s rule: a change that removes work has not saved it until you can say where it went.'
            + ' `Δ viewer.postLoadAsync.end` is the interleave being removed from the *other* generator.');
        ranking(tier, arm, base, RANK_METRICS);
        counters(tier, arm, base, GUARD_KEYS, 'Volume guards',
            'Every counter here is fixed before the drain begins or belongs to the viewer\'s generator.'
            + ' A move in any of them means the delta is not the statement this ticket claims.');
        counters(tier, arm, base, MECH_KEYS, 'Mechanism counters (these arms ARE entitled to move these)',
            '`sched.hops.viewer` is deliberately in this table rather than the guard table: both drain'
            + ' generators are in flight at once, so emptying one changes how the other\'s slices land.');
    }
}
