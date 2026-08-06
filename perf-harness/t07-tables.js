// Ticket 07's tables.  THROWAWAY - startup-remediation effort only.
//
//   node perf-harness/t07-tables.js <sweep.json>
//
// Reads only; re-measures nothing.  Every figure is computed per run and only
// then reduced to a median, so it carries a spread; every cross-arm figure is
// paired by run index against a named baseline arm in the same session.
//
// Two baselines, and that is the point of this ticket.  `none` is the shipped
// code.  `drainbatched` is the tip ticket 03 leaves behind, and deleting pass 1
// is a different proposition there - pass 2 no longer dirties style between its
// own reads, so it no longer needs pass 1 to have warmed anything.
const fs = require('fs');

const [SWEEP] = process.argv.slice(2);
if (!SWEEP) {
    console.error('usage: t07-tables.js <sweep.json>');
    process.exit(1);
}
const j = JSON.parse(fs.readFileSync(SWEEP));

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const spread = (xs) => (xs.length < 2 ? 0 : (Math.max(...xs) - Math.min(...xs)) / 2);
const f1 = (x) => (Math.round(x * 10) / 10).toLocaleString('en-US');

/* Arm order is the argument's order: the shipped code, the candidate, the
 * candidate with ticket 06's font guard, ticket 03's tip, ticket 03's tip with
 * the candidate applied, and finally both passes gone as the upper bound. */
const ALL = ['none', 'drainnopass1', 'drainnopass1fonts', 'drainbatched',
    'drainbatchednopass1', 'drainnopass'];
const VS_NONE = ALL.slice(1);
/* The map's floor: below this a change cannot be told from session drift. */
const FLOOR = 50;

const drainGap = (r) => r.windows?.drainGap;
const loaderRemoved = (r) => r.external?.loaderRemoved;
const drained = (r) => r.windows?.toDrained;
/* Within-run, so it carries none of the whole load's variance.  This ticket
 * halves the drain's yield count, which is a change to when the browser may
 * paint, so it carries this column even though it also removes work. */
const frameLag = (r) => r.windows?.toLoaderRemovedFrame - r.windows?.toLoaderRemoved;

const span = (name) => (r) => r.spans?.[name]?.ms ?? 0;
const pass1 = span('drain.viewer.pass1');
const pass2 = span('drain.viewer.pass2');
const passWork = (r) => pass1(r) + pass2(r);
const count = (name) => (r) => r.counts?.[name] ?? 0;
/* Read over the drain only: these CDP counters are cumulative for the page's
 * whole life, so the drain's own share is the difference between the read at
 * loader removal and the read at drained. */
const overDrain = (name) => (r) =>
    (r.metrics?.[name] ?? 0) - (r.metricsAtLoaderRemoved?.[name] ?? 0);

const groups = {};
for (const a of j.results) {
    (groups[`${a.slug}|${a.tier}`] ??= {})[a.ablate] = a.runs.filter(r => !r.error);
}
const slugs = [...new Set(j.results.map(r => r.slug))].sort();
const tiers = [...new Set(j.results.map(r => r.tier))].sort((a, b) => a - b);
/* Only the fixtures this change can touch at all.  postProcess's loop body runs
 * once per .ixbrl-contains-absolute container, so a fixture with none of them is
 * a null by construction, not by measurement. */
const withContainers = slugs.filter(s => tiers.some(t =>
    (groups[`${s}|${t}`]?.none ?? []).some(r => count('drain.viewer.containsAbsolute')(r) > 0)));

/* Paired: the delta is computed per run index and only then reduced, so it has a
 * spread of its own.  Differencing two medians would throw that away, and the
 * evidence bar is "a delta larger than the measured spread". */
function paired(arms, arm, f, base = 'none') {
    if (!arms[base] || !arms[arm]) {
        return null;
    }
    const d = arms[arm].map((r, i) => f(r) - f(arms[base][i])).filter(Number.isFinite);
    if (!d.length) {
        return null;
    }
    const m = median(d), s = spread(d);
    return { m, s, resolved: Math.abs(m) > s };
}
const cell = (p) => (p === null ? '—'
    : `${p.m > 0 ? '+' : ''}${f1(p.m)}±${f1(p.s)}${p.resolved ? '' : ' *ns*'}`);

function payoff(tier, f, label, arms = VS_NONE, base = 'none', rows = slugs) {
    console.log(`\n### ${label}, ${tier}x — paired against each fixture's own \`${base}\` arm\n`);
    console.log(`| slug | \`${base}\` | ` + arms.map(a => `\`${a}\` Δ`).join(' | ') + ' |');
    console.log('|---|---|' + arms.map(() => '---').join('|') + '|');
    for (const slug of rows) {
        const g = groups[`${slug}|${tier}`];
        if (!g?.[base]) {
            continue;
        }
        const b = g[base].map(f).filter(Number.isFinite);
        console.log(`| \`${slug}\` | ${f1(median(b))}±${f1(spread(b))} | `
            + arms.map(a => cell(paired(g, a, f, base))).join(' | ') + ' |');
    }
}

/* Worst-filing milliseconds removed at 1x is the map's ranking key; breadth is
 * how many fixtures clear the floor with a delta larger than its own spread. */
function ranking(tier, f, label, arms = VS_NONE, base = 'none') {
    console.log(`\n### Ranking key — ${label}, ${tier}x, against \`${base}\`\n`);
    console.log('| arm | worst-filing Δ | on | breadth (resolved and ≥ 50 ms) |');
    console.log('|---|---|---|---|');
    for (const arm of arms) {
        let best = null, bestSlug = '', breadth = [];
        for (const slug of slugs) {
            const p = paired(groups[`${slug}|${tier}`] ?? {}, arm, f, base);
            if (!p) {
                continue;
            }
            if (best === null || p.m < best) {
                best = p.m;
                bestSlug = slug;
            }
            if (p.resolved && -p.m >= FLOOR) {
                breadth.push(slug);
            }
        }
        console.log(`| \`${arm}\` | ${best === null ? '—' : f1(best)} | \`${bestSlug}\` | `
            + `${breadth.length}/${slugs.length}`
            + (breadth.length ? ` — ${breadth.map(s => `\`${s}\``).join(', ')}` : '') + ' |');
    }
}

/* An integer volume counter.  Printed as its median with the run-to-run range in
 * brackets when it is not constant, because "identical across arms" is only a
 * claim worth making if the counter is first identical across runs. */
function counterTable(label, f, arms = ALL, rows = slugs, note = '') {
    console.log(`\n### ${label}\n${note}`);
    console.log('| slug | tier | ' + arms.map(a => `\`${a}\``).join(' | ') + ' |');
    console.log('|---|---|' + arms.map(() => '---').join('|') + '|');
    for (const slug of rows) {
        for (const tier of tiers) {
            const g = groups[`${slug}|${tier}`];
            if (!g) {
                continue;
            }
            console.log(`| \`${slug}\` | ${tier}x | ` + arms.map(a => {
                const xs = (g[a] ?? []).map(f);
                if (!xs.length) {
                    return '—';
                }
                const lo = Math.min(...xs), hi = Math.max(...xs);
                return lo === hi ? f1(lo) : `${f1(median(xs))} [${f1(lo)}–${f1(hi)}]`;
            }).join(' | ') + ' |');
        }
    }
}

function spanTable(label, arms = ALL, rows = slugs) {
    console.log(`\n### ${label}\n`);
    console.log('| slug | tier | ' + arms.map(a => `\`${a}\` p1 + p2 = total`).join(' | ') + ' |');
    console.log('|---|---|' + arms.map(() => '---').join('|') + '|');
    for (const slug of rows) {
        for (const tier of tiers) {
            const g = groups[`${slug}|${tier}`];
            if (!g) {
                continue;
            }
            console.log(`| \`${slug}\` | ${tier}x | ` + arms.map(a => {
                const runs = g[a] ?? [];
                if (!runs.length) {
                    return '—';
                }
                const t = runs.map(passWork);
                return `${f1(median(runs.map(pass1)))} + ${f1(median(runs.map(pass2)))}`
                    + ` = **${f1(median(t))}±${f1(spread(t))}**`;
            }).join(' | ') + ' |');
        }
    }
}

const a0 = j.arms?.[0] ?? {};
console.log(`# Ticket 07 tables — deleting \`postProcess()\`'s pass 1

Generated by \`perf-harness/t07-tables.js\` from \`${SWEEP.split('/').pop()}\`.
Session \`${j.stamp}\`, ${j.chrome}, ${j.machine?.model} (${j.machine?.cpus} cpu),
runs=${j.runs} per (fixture, tier, arm), level=${j.level}.
Build \`${a0.branch}\` @ \`${(a0.sha ?? '').slice(0, 8)}\`${a0.dirty ? ' **(dirty at sweep time)**' : ''}.
All ${j.arms?.length} arms are the same bundle on the same server, alternating run
by run, so a delta cannot be a build or a server difference.

\`±\` is half the min→max range, the convention \`t04-tables.js\` and
\`t05-tables.js\` used. \`*ns*\` marks a delta no larger than that — it does not
clear the evidence bar, whatever its sign.

**Two baselines, and that is this ticket's finding.** \`none\` is the shipped
code. \`drainbatched\` is the tip [ticket 03](../issues/03-de-interleave-postprocess-pass-2.md)
leaves behind, where pass 2 hoists its class writes past all of its reads.
Deleting pass 1 is a different proposition on each, so both are reported.

**Only ${withContainers.length} of ${slugs.length} fixtures have any
\`.ixbrl-contains-absolute\` container** — ${withContainers.map(s => `\`${s}\``).join(', ')}.
On the others \`postProcess\`'s loop body never executes, so those rows are a
null *by construction* and are kept only to show that they are.`);

console.log('\n---\n\n## Payoff — the drain gap');
for (const tier of tiers) {
    payoff(tier, drainGap, 'Drain gap (`toDrained` − `toLoaderRemoved`)');
}
console.log('\n## Payoff on ticket 03\'s tip');
for (const tier of tiers) {
    payoff(tier, drainGap, 'Drain gap (`toDrained` − `toLoaderRemoved`)',
        ['drainbatchednopass1', 'drainnopass'], 'drainbatched');
}
console.log('\n## Both windows, never collapsed');
for (const tier of tiers) {
    payoff(tier, loaderRemoved, 'Window 1: nav start → loader removed (externally observed)');
}
for (const tier of tiers) {
    payoff(tier, drained, 'Window 2: nav start → fully drained');
}
console.log('\n## Ranking');
for (const tier of tiers) {
    ranking(tier, drainGap, 'the drain gap');
}
for (const tier of tiers) {
    ranking(tier, drainGap, 'the drain gap', ['drainbatchednopass1', 'drainnopass'], 'drainbatched');
}

console.log(`\n---\n\n## Mechanism — where the pass work goes

The two passes' own accumulated spans, median over runs. \`drainnopass\` runs
neither, so both are zero there. The question this table answers: when pass 1 is
deleted, does its cost disappear or does pass 2 inherit it?`);
spanTable('Pass work, ms', ALL, withContainers);

console.log(`\n## The finding — \`drain.viewer.noHighlight\`

**This counter is a guard for every other drain arm and a *finding* for this
ticket.** Ticket 06 established that pass 1 buys elapsed time rather than a
second immediate read, so removing it may legitimately leave elements measuring
zero that previously measured non-zero. If this moves, the quirk — or something
standing in for it — is live, and the change may not claim identical output.`);
counterTable('`drain.viewer.noHighlight` — elements classed `ixbrl-no-highlight`',
    count('drain.viewer.noHighlight'), ALL, withContainers,
    '\n`drainnopass` classes nothing at all, by construction.\n');

console.log('\n## Guards');
counterTable('`drain.viewer.containsAbsolute` — a true guard on every arm',
    count('drain.viewer.containsAbsolute'), ALL, slugs,
    '\nEmitted before the arm dispatch, so no arm has any business moving it.\n');
counterTable('`drain.viewer.pass1Layout` — zero on the skipping arms by construction',
    count('drain.viewer.pass1Layout'), ALL, withContainers);
counterTable('`drain.viewer.yields` — the drain\'s own `runGenerator` hops',
    count('drain.viewer.yields'), ALL, withContainers,
    '\nTicket 04 priced a hop at 3.4 ms on `aviva-2025` and 3.9 on `fr-esef-both-huge`, so\n'
    + 'this column is the overlap with [ticket 20](../issues/20-messagechannel-rungenerator.md).\n');
counterTable('`drain.viewer.fontsWaitYields` — ticket 06\'s font hypothesis, priced',
    count('drain.viewer.fontsWaitYields'), ['drainnopass1fonts'], withContainers,
    '\nOnly `drainnopass1fonts` waits. One hop means the promise was already resolved\n'
    + 'when the drain reached it.\n');

console.log(`\n## Mechanism — CDP counters over the drain

\`metrics\` minus \`metricsAtLoaderRemoved\`: the drain's own share of counters
that are cumulative for the page's whole life. Ticket 03 established that pass
2's interleaved writes cost one style recalculation per class applied, and that
\`LayoutDuration\` is invisible to a pure reorder — so a change that moves
\`LayoutDuration\` is removing reads, not reordering them.`);
for (const m of ['RecalcStyleCount', 'LayoutCount', 'LayoutDuration', 'RecalcStyleDuration']) {
    counterTable(`\`${m}\` over the drain`, overDrain(m), ALL, withContainers);
}

console.log(`\n## Frame lag — loader removal to the second rAF after it, within-run

Deleting pass 1 halves the drain's yield count, so it changes when the browser
may paint as well as how much work it does. The map's Notes require this column
of any change that does.`);
for (const tier of tiers) {
    payoff(tier, frameLag, 'Frame lag', VS_NONE, 'none', withContainers);
}
