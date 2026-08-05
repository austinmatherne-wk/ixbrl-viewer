// Ticket 12's tables: review mode's untagged-numbers walk, split into its parts.
// THROWAWAY - startup-slowness investigation only.
//
//   node perf-harness/report-untagged.js <ablate-sweep.json> [...] [--deep <deep-sweep.json>]
//
// Reads only; re-measures nothing.
//
// The split is an *ablation* decomposition, not a span decomposition, because the
// walk is per-node and a span per node would become the thing it measures.  Four
// arms off one bundle (see ABLATE in perf.js) give four elapsed phase times, and
// the four terms fall out of their differences:
//
//   T    = phase(none) - phase(untaggedwalkonly)   everything in the text-node
//                                                  branch; what is left in
//                                                  walkonly is the traversal.
//   M    = T - (phase(none) - phase(untaggednorewrite))
//                                                  the regex matcher alone:
//                                                  norewrite keeps the matcher and
//                                                  drops both rewrites, so what it
//                                                  does *not* remove is the matcher.
//   R_m  = (phase(none) - phase(untaggednomatch)) - M
//                                                  the span building the matches
//                                                  drive: nomatch drops the matcher
//                                                  and the match-driven appends and
//                                                  keeps the unconditional rewrite.
//   R_u  = T - (phase(none) - phase(untaggednomatch))
//                                                  the rewrite every text node pays
//                                                  whether it matched or not - the
//                                                  output div, the tail text node
//                                                  and the replaceWith.
//
// Every delta is paired by run index against the `none` arm before being reduced to
// a median, so it carries its own spread and can be held to the map's bar.
//
// The phase is a *mark* difference, not the walk span, because hideChildren and
// showChildren sit inside it too and showChildren is a forced relayout of what the
// walk just built - so it moves on an arm for a reason that is not the ablated
// statement.  It is printed per arm rather than folded in.
const fs = require('fs');

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const phase = (run) => run.marks['phase.untagged.end'] - run.marks['phase.untagged.start'];
const span = (run, name) => run.spans?.[name]?.ms ?? 0;
const count = (rows, name) => median(rows.map(r => r.counts?.[name] ?? 0));

/* Paired per run index, then reduced.  Returns [median, spread] of
 * phase(arm) - phase(none), so a saving is negative. */
function pairedDelta(arm, base) {
    const ds = arm.runs
        .map(x => [x, base.runs.find(y => y.run === x.run)])
        .filter(([x, y]) => y !== undefined && !x.error && !y.error)
        .map(([x, y]) => phase(x) - phase(y));
    return [median(ds), Math.max(...ds) - Math.min(...ds)];
}

/* Least squares y = a + b.x, with R^2, for the per-unit rate claims.  Only ever
 * applied to an axis a statement demonstrably iterates over - the map's rule after
 * ticket 07 found 44 candidate axes rank-correlating with everything. */
function fit(xs, ys) {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    const sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
    const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    const b = sxy / sxx;
    const a = my - b * mx;
    const ssTot = ys.reduce((s, y) => s + (y - my) ** 2, 0);
    const ssRes = ys.reduce((s, y, i) => s + (y - (a + b * xs[i])) ** 2, 0);
    return { a, b, r2: 1 - ssRes / ssTot };
}

function collect(files) {
    const cells = [];
    let meta = null;
    for (const file of files) {
        const j = JSON.parse(fs.readFileSync(file));
        meta ??= j;
        const groups = new Map();
        for (const r of j.results) {
            const k = `${r.slug} ${r.tier}`;
            (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
        }
        for (const [k, rs] of groups) {
            const [slug, tier] = k.split(' ');
            const base = rs.find(r => r.ablate === 'none');
            if (!base) {
                continue;
            }
            const arm = (a) => rs.find(r => r.ablate === a);
            const d = {};
            for (const a of ['untaggedwalkonly', 'untaggednomatch', 'untaggednorewrite']) {
                d[a] = arm(a) ? pairedDelta(arm(a), base) : null;
            }
            if (Object.values(d).some(x => x === null)) {
                continue;
            }
            const T = -d.untaggedwalkonly[0];
            const NR = -d.untaggednorewrite[0];
            const NM = -d.untaggednomatch[0];
            cells.push({
                slug, tier: Number(tier), file,
                phase: median(base.runs.map(phase)),
                walkSpan: median(base.runs.map(r => span(r, 'viewer.wrapUntaggedNumbers'))),
                hide: median(base.runs.map(r => span(r, 'viewer.untagged.hideChildren'))),
                show: median(base.runs.map(r => span(r, 'viewer.untagged.showChildren'))),
                showWalkOnly: median(arm('untaggedwalkonly').runs
                    .map(r => span(r, 'viewer.untagged.showChildren'))),
                T, M: T - NR, Rm: NM - (T - NR), Ru: T - NM,
                deltas: d,
                textNodes: count(base.runs, 'untagged.textNodes'),
                textChars: count(base.runs, 'untagged.textChars'),
                matches: count(base.runs, 'untagged.matches'),
                wrapped: count(base.runs, 'untagged.wrapped'),
                elementNodes: count(base.runs, 'untagged.elementNodes'),
                elementsRecursed: count(base.runs, 'untagged.elementsRecursed'),
                docs: count(base.runs, 'viewer.untagged.docs'),
                window: median(base.runs.map(r => r.windows.toDrained)),
                guards: Object.fromEntries(['untaggedwalkonly', 'untaggednomatch',
                    'untaggednorewrite'].map(a => [a,
                    ['untagged.textNodes', 'untagged.elementNodes', 'untagged.textChars']
                        .map(g => count(arm(a).runs, g) - count(base.runs, g))])),
            });
        }
    }
    cells.sort((a, b) => a.slug.localeCompare(b.slug) || a.tier - b.tier);
    return { cells, meta };
}

function main() {
    const argv = process.argv.slice(2);
    const deepAt = argv.indexOf('--deep');
    const files = (deepAt < 0 ? argv : argv.slice(0, deepAt)).filter(Boolean);
    const deepFiles = deepAt < 0 ? [] : argv.slice(deepAt + 1);
    if (!files.length) {
        console.error('usage: report-untagged.js <ablate-sweep.json> [...] [--deep <sweep.json>]');
        process.exit(1);
    }
    const { cells, meta } = collect(files);
    const b = meta.arms[0];
    console.log(`# Ticket 12 — review mode's untagged-numbers walk\n`);
    console.log(`build: ${b.branch} @ ${b.sha.slice(0, 8)}${b.dirty ? ' DIRTY' : ''}  `
        + `runs=${meta.runs} review=${meta.review} chrome=${meta.chrome}  `
        + `machine: ${meta.machine.model} (${meta.machine.cpus} cpu)`);
    console.log(`sources: ${files.join(', ')}`);

    console.log(`\n## The four terms\n`);
    console.log('`T` is everything in the text-node branch; the traversal is what the'
        + ' `untaggedwalkonly` arm leaves behind. Shares are of `T`.\n');
    console.log('| fixture | tier | phase | walk span | traversal | T | M regex | R_u rewrite-always'
        + ' | R_m rewrite-matches |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    for (const c of cells) {
        const pc = (x) => `${r1(x)} (${Math.round(x / c.T * 100)}%)`;
        console.log(`| ${c.slug} | ${c.tier}x | ${r1(c.phase)} | ${r1(c.walkSpan)} | `
            + `${r1(c.walkSpan - c.T)} | ${r1(c.T)} | ${pc(c.M)} | ${pc(c.Ru)} | ${pc(c.Rm)} |`);
    }

    console.log(`\n## The raw ablation deltas, paired per run\n`);
    console.log('Negative is a saving. The map\'s bar is |Δ| > spread; a delta that fails it'
        + ' is marked.\n');
    console.log('| fixture | tier | phase (none) | Δ untaggedwalkonly | Δ untaggednomatch'
        + ' | Δ untaggednorewrite | guards moved? |');
    console.log('|---|---|---|---|---|---|---|');
    for (const c of cells) {
        const cell = (a) => {
            const [m, s] = c.deltas[a];
            return `${m > 0 ? '+' : ''}${r1(m)}±${r1(s)} (${Math.round(m / c.phase * 100)}%)`
                + `${Math.abs(m) > s ? '' : ' **unresolved**'}`;
        };
        const moved = Object.entries(c.guards)
            .filter(([, gs]) => gs.some(x => x !== 0)).map(([a]) => a);
        console.log(`| ${c.slug} | ${c.tier}x | ${r1(c.phase)} | ${cell('untaggedwalkonly')}`
            + ` | ${cell('untaggednomatch')} | ${cell('untaggednorewrite')} | `
            + `${moved.length ? '**' + moved.join(', ') + '**' : 'no'} |`);
    }

    console.log(`\n## Per-unit rates, and the axis each statement iterates over\n`);
    console.log('| fixture | tier | traversal ms/node | R_u ms/text node | R_m ms/match'
        + ' | M ms | text nodes | chars scanned | matches | nodes visited |');
    console.log('|---|---|---|---|---|---|---|---|---|---|');
    for (const c of cells) {
        const nodes = c.elementNodes + c.textNodes;
        console.log(`| ${c.slug} | ${c.tier}x | ${((c.walkSpan - c.T) / nodes).toFixed(5)} | `
            + `${(c.Ru / c.textNodes).toFixed(5)} | ${(c.Rm / c.matches).toFixed(5)} | `
            + `${r1(c.M)} | ${c.textNodes} | ${c.textChars} | ${c.matches} | ${nodes} |`);
    }

    for (const tier of [...new Set(cells.map(c => c.tier))].sort((a, b) => a - b)) {
        const cs = cells.filter(c => c.tier === tier);
        if (cs.length < 3) {
            continue;
        }
        console.log(`\n### Fits at ${tier}x (n=${cs.length})\n`);
        const rows = [
            ['traversal ~ nodes visited', cs.map(c => c.elementNodes + c.textNodes),
                cs.map(c => c.walkSpan - c.T)],
            ['traversal ~ elements recursed into', cs.map(c => c.elementsRecursed),
                cs.map(c => c.walkSpan - c.T)],
            ['R_u ~ text nodes', cs.map(c => c.textNodes), cs.map(c => c.Ru)],
            ['R_m ~ matches', cs.map(c => c.matches), cs.map(c => c.Rm)],
            ['M ~ chars scanned', cs.map(c => c.textChars), cs.map(c => c.M)],
        ];
        console.log('| term ~ axis | intercept (ms) | slope (ms/unit) | R² |');
        console.log('|---|---|---|---|');
        for (const [label, xs, ys] of rows) {
            const f = fit(xs, ys);
            console.log(`| ${label} | ${r1(f.a)} | ${f.b.toExponential(3)} | `
                + `${f.r2.toFixed(3)} |`);
        }
    }

    console.log(`\n## showChildren — the forced relayout, and the arms' confound\n`);
    console.log('`showChildren` is one `.show()` on the body children the phase hid, so it is a'
        + ' relayout of whatever the walk just built. Three arms leave fewer nodes behind, so it'
        + ' gets cheaper on an arm for a reason that is not the ablated statement — which is why'
        + ' it is quoted per arm and never folded into `T`.\n');
    console.log('| fixture | tier | phase | hideChildren | showChildren (none)'
        + ' | showChildren (walkonly) | show as % of phase |');
    console.log('|---|---|---|---|---|---|---|');
    for (const c of cells) {
        console.log(`| ${c.slug} | ${c.tier}x | ${r1(c.phase)} | ${r1(c.hide)} | ${r1(c.show)}`
            + ` | ${r1(c.showWalkOnly)} | ${Math.round(c.show / c.phase * 100)}% |`);
    }

    console.log(`\n## The phase in its window\n`);
    console.log('| fixture | tier | phase | drained window | share | documents |');
    console.log('|---|---|---|---|---|---|');
    for (const c of cells) {
        console.log(`| ${c.slug} | ${c.tier}x | ${r1(c.phase)} | ${r1(c.window)} | `
            + `${(c.phase / c.window * 100).toFixed(1)}% | ${c.docs} |`);
    }

    if (deepFiles.length) {
        console.log(`\n## The deep-level segment split — an independent corroboration\n`);
        console.log('`LEVEL=deep` clocks the five segments directly rather than differencing'
            + ' arms. It distorts the phase it splits, so the *shares* are the claim and the'
            + ' absolute times are not baseline numbers. It should agree with the ablation'
            + ' decomposition above; where it does not, the ablation wins.\n');
        console.log('| fixture | walk span | contents | elementTest | match | matchRewrite'
            + ' | rewrite | segments as % of span |');
        console.log('|---|---|---|---|---|---|---|---|');
        const deepShare = new Map();
        for (const file of deepFiles) {
            const j = JSON.parse(fs.readFileSync(file));
            for (const r of j.results.filter(x => x.tier === 1)) {
                const s = (n) => median(r.runs.map(x => span(x, n)));
                const w = median(r.runs.map(x => span(x, 'viewer.wrapUntaggedNumbers')));
                const segs = ['untagged.contents', 'untagged.elementTest', 'untagged.match',
                    'untagged.matchRewrite', 'untagged.rewrite'].map(s);
                const sum = segs.reduce((a, x) => a + x, 0);
                /* The text branch only, so the share shares a denominator with the
                 * ablation's T - the two techniques are otherwise measuring
                 * fractions of different things and cannot be compared. */
                const branch = segs[2] + segs[3] + segs[4];
                deepShare.set(r.slug, { M: segs[2] / branch, Rm: segs[3] / branch,
                    Ru: segs[4] / branch });
                console.log(`| ${r.slug} | ${r1(w)} | `
                    + segs.map(x => `${r1(x)} (${Math.round(x / sum * 100)}%)`).join(' | ')
                    + ` | ${Math.round(sum / w * 100)}% |`);
            }
        }
        console.log(`\n### The two techniques side by side\n`);
        console.log('Share of the text-node branch — the ablation\'s `T` and the deep segments\''
            + ' `match + matchRewrite + rewrite` are the same quantity measured two ways, so'
            + ' these are directly comparable. 1x only.\n');
        console.log('| fixture | M ablated | M deep | R_u ablated | R_u deep | R_m ablated'
            + ' | R_m deep |');
        console.log('|---|---|---|---|---|---|---|');
        for (const c of cells.filter(x => x.tier === 1)) {
            const d = deepShare.get(c.slug);
            if (!d) {
                continue;
            }
            const p = (x) => `${Math.round(x * 100)}%`;
            console.log(`| ${c.slug} | ${p(c.M / c.T)} | ${p(d.M)} | ${p(c.Ru / c.T)} | `
                + `${p(d.Ru)} | ${p(c.Rm / c.T)} | ${p(d.Rm)} |`);
        }
    }
}
main();
