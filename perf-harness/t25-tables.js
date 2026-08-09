// Ticket 25's tables.  THROWAWAY - startup-remediation effort only.
//
//   node perf-harness/t25-tables.js <sweep.json>
//
// Reads only; re-measures nothing.  Every figure is computed per run and only
// then reduced to a median, so it carries a spread; every cross-arm figure is
// paired by run index against the same session's `none` arm.
//
// This ticket's job is to close a gap rather than open one.  Ticket 09 could only
// *bound* the conditional rewrite's payoff (-471 to -544 ms worst-filing) because
// no arm modelled it: untaggednorewrite skips the rewrite on every text node, and
// the deep segment R_u is paid on every text node too, while the change only saves
// the non-matching ones.  untaggedcondrewrite is that arm, so the delta here is
// measured rather than bounded - and untagged.rewrittenNodes reports the split that
// ticket 09 had to bound from matches/textNodes.
const fs = require('fs');

const [SWEEP] = process.argv.slice(2);
if (!SWEEP) {
    console.error('usage: t25-tables.js <sweep.json>');
    process.exit(1);
}
const j = JSON.parse(fs.readFileSync(SWEEP));

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const spread = (xs) => (xs.length < 2 ? 0 : (Math.max(...xs) - Math.min(...xs)) / 2);
const f1 = (x) => (x === null || !Number.isFinite(x) ? '-' : (Math.round(x * 10) / 10).toLocaleString('en-US'));

const ARM = 'untaggedcondrewrite';
/* The map's floor: below this a change cannot be told from session drift. */
const FLOOR = 50;

/* The phase the change lives in, as a mark difference.  hideChildren and
 * showChildren sit inside it, and showChildren is a forced relayout of what the
 * walk just built - so it is printed separately and never folded in.  Ticket 25:
 * this arm leaves the SAME node count behind as none, so unlike the other three
 * untagged arms it should not move showChildren at all.  That is the falsification
 * test - if showChildren moves, the output is not identical. */
const untagged = (r) => r.marks?.['phase.untagged.end'] - r.marks?.['phase.untagged.start'];
const walkSpan = (r) => r.spans?.['viewer.wrapUntaggedNumbers']?.ms;
const showChildren = (r) => r.spans?.['viewer.untagged.showChildren']?.ms;
const hideChildren = (r) => r.spans?.['viewer.untagged.hideChildren']?.ms;

/* Both windows, always, never collapsed. */
const loaderRemoved = (r) => r.external?.loaderRemoved;
const drained = (r) => r.windows?.toDrained;
/* Within-run, so it carries none of the whole load's variance.  Ticket 24: work
 * removed from before loader removal can reappear at the first paint, and neither
 * window can see that. */
const frameLagLoader = (r) => r.windows?.toLoaderRemovedFrame - r.windows?.toLoaderRemoved;
const frameLagDrained = (r) => r.windows?.toDrainedFrame - r.windows?.toDrained;
/* Ticket 24's surviving quantity: nav start to the first frame the user could act
 * on.  A loaderRemoved delta that is handed straight back here is not a win. */
const toActionable = (r) => loaderRemoved(r) + frameLagLoader(r);

const count = (k) => (r) => r.counts?.[k];

const groups = {};
for (const a of j.results) {
    (groups[`${a.slug}|${a.tier}`] ??= {})[a.ablate] = a.runs.filter(r => !r.error);
}
const slugs = [...new Set(j.results.map(r => r.slug))].sort();
const tiers = [...new Set(j.results.map(r => r.tier))].sort((a, b) => a - b);

/* Paired: the delta is computed per run index and only then reduced, so it has a
 * spread of its own.  Differencing two medians would throw that away, and the
 * evidence bar is "a delta larger than the measured spread". */
function paired(arms, f) {
    if (!arms?.none || !arms[ARM]) {
        return null;
    }
    const n = Math.min(arms.none.length, arms[ARM].length);
    const d = [];
    for (let i = 0; i < n; i++) {
        const v = f(arms[ARM][i]) - f(arms.none[i]);
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

function baseCell(arms, f) {
    const b = (arms?.none ?? []).map(f).filter(Number.isFinite);
    return b.length ? `${f1(median(b))}±${f1(spread(b))}` : '-';
}

function table(tier, cols, label, note) {
    console.log(`\n### ${label} — ${tier}×, paired against each fixture's own \`none\` arm\n`);
    if (note) {
        console.log(`${note}\n`);
    }
    console.log('| slug | ' + cols.map(c => c[0]).join(' | ') + ' |');
    console.log('|---|' + cols.map(() => '---').join('|') + '|');
    for (const slug of slugs) {
        const arms = groups[`${slug}|${tier}`];
        if (!arms?.none) {
            continue;
        }
        console.log(`| \`${slug}\` | ` + cols.map(c => c[1](arms)).join(' | ') + ' |');
    }
}

/* Worst-filing milliseconds removed at 1x is the map's ranking key; breadth is how
 * many fixtures clear the floor with a delta larger than its own spread. */
function ranking(tier, metrics) {
    console.log(`\n### Ranking key — ${tier}×\n`);
    console.log('| metric | worst-filing Δ | on | resolved | breadth (resolved and ≥ 50 ms) |');
    console.log('|---|---|---|---|---|');
    for (const [label, f] of metrics) {
        let best = null, bestSlug = '';
        const breadth = [], res = [];
        for (const slug of slugs) {
            const p = paired(groups[`${slug}|${tier}`], f);
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

/* The counter table is a guard first and a finding second.  Every counter here bar
 * rewrittenNodes and emptyTextNodes must be IDENTICAL across the two arms: the walk
 * is untouched and the change only decides whether an equal node is put back.  A
 * move in any of them means the delta is not the statement this ticket claims. */
function guards(tier) {
    const KEYS = ['untagged.textNodes', 'untagged.elementNodes', 'untagged.textChars',
        'untagged.elementsRecursed', 'untagged.matches', 'untagged.wrapped',
        'untagged.keptAsText', 'untagged.rewrittenNodes', 'untagged.emptyTextNodes'];
    console.log(`\n### Volume guards — ${tier}×  (\`none\` → \`${ARM}\`, min = max over all runs required)\n`);
    console.log('| slug | ' + KEYS.map(k => `\`${k.replace('untagged.', '')}\``).join(' | ') + ' | moved |');
    console.log('|---|' + KEYS.map(() => '---').join('|') + '|---|');
    for (const slug of slugs) {
        const arms = groups[`${slug}|${tier}`];
        if (!arms?.none || !arms[ARM]) {
            continue;
        }
        const cells = [], moved = [];
        for (const k of KEYS) {
            const a = arms.none.map(count(k)).filter(Number.isFinite);
            const b = arms[ARM].map(count(k)).filter(Number.isFinite);
            const stable = (xs) => xs.length && Math.min(...xs) === Math.max(...xs);
            const va = a.length ? median(a) : null;
            const vb = b.length ? median(b) : null;
            if (va === null && vb === null) {
                cells.push('-');
                continue;
            }
            const same = va === vb && stable(a) && stable(b);
            cells.push(same ? `${f1(va)}` : `${f1(va)} → ${f1(vb)}`);
            if (!same) {
                moved.push(k.replace('untagged.', ''));
            }
        }
        console.log(`| \`${slug}\` | ${cells.join(' | ')} | ${moved.length ? moved.join(', ') : '**0**'} |`);
    }
}

/* The split ticket 09 could only bound.  rewrittenNodes / textNodes is the fraction
 * of text nodes the change CANNOT help, so 1 - that is the fraction of R_u it
 * recovers - and it is measured here rather than inferred from matches/textNodes,
 * which counts matches and so only bounds it. */
function split(tier) {
    console.log(`\n### What the change can reach — ${tier}×\n`);
    console.log('| slug | text nodes | rewritten (matched or empty) | **skipped** | skipped share | matches | ticket 09\'s bound on the share |');
    console.log('|---|---|---|---|---|---|---|');
    for (const slug of slugs) {
        const arms = groups[`${slug}|${tier}`];
        if (!arms?.none) {
            continue;
        }
        const tn = median(arms.none.map(count('untagged.textNodes')).filter(Number.isFinite));
        const rw = median(arms.none.map(count('untagged.rewrittenNodes')).filter(Number.isFinite));
        const mt = median(arms.none.map(count('untagged.matches')).filter(Number.isFinite));
        if (!Number.isFinite(tn) || !Number.isFinite(rw)) {
            continue;
        }
        const skipped = tn - rw;
        const lower = Math.max(0, 1 - mt / tn);
        console.log(`| \`${slug}\` | ${f1(tn)} | ${f1(rw)} | **${f1(skipped)}** | `
            + `${f1(100 * skipped / tn)}% | ${f1(mt)} | ≥ ${f1(100 * lower)}% |`);
    }
}

console.log(`# Ticket 25 tables — rewrite a text node only when the matcher matched

Generated by \`perf-harness/t25-tables.js\` from \`${SWEEP.split('/').pop()}\`.
Session \`${j.stamp}\`, ${j.chrome}, ${j.machine?.model} (${j.machine?.cpus} cpu),
runs=${j.runs} per (fixture, tier, arm), level=${j.level}, review=${j.review}.

Arms: \`none\` and \`${ARM}\`, measured off **one** bundle and one server, alternating
run by run, so a delta cannot be a build or a server difference.

\`±\` is (max − min)/2 over the paired per-run deltas. \`*ns*\` marks |Δ| ≤ ±, i.e. not
resolved. The map's floor is ${FLOOR} ms worst-filing.

**\`aviva-2025\` cannot resolve a few-hundred-ms effect end to end** (±419 ms on a
21.4 s window, ticket 21) — read it on \`phase.untagged\` or the walk span, and do
not count it against breadth either way.`);

for (const tier of tiers) {
    table(tier, [
        ['`phase.untagged` `none`', (a) => baseCell(a, untagged)],
        ['`phase.untagged` Δ', (a) => cell(paired(a, untagged))],
        ['walk span `none`', (a) => baseCell(a, walkSpan)],
        ['walk span Δ', (a) => cell(paired(a, walkSpan))],
        ['`showChildren` Δ', (a) => cell(paired(a, showChildren))],
        ['`hideChildren` Δ', (a) => cell(paired(a, hideChildren))],
    ], 'The phase and the walk',
    '`showChildren` is the falsification test: this arm leaves the same node count '
    + 'behind as `none`, so it should not move. If it does, the output is not identical.');
}

for (const tier of tiers) {
    table(tier, [
        ['`loaderRemoved` `none`', (a) => baseCell(a, loaderRemoved)],
        ['`loaderRemoved` Δ', (a) => cell(paired(a, loaderRemoved))],
        ['`drained` `none`', (a) => baseCell(a, drained)],
        ['`drained` Δ', (a) => cell(paired(a, drained))],
        ['`frameLag.loaderRemoved` Δ', (a) => cell(paired(a, frameLagLoader))],
        ['`frameLag.drained` Δ', (a) => cell(paired(a, frameLagDrained))],
        ['nav → actionable frame Δ', (a) => cell(paired(a, toActionable))],
    ], 'Both windows, and where the work could have gone',
    'Ticket 24: `loaderRemoved` alone can be actively misleading. The quantity that '
    + 'survives is `loaderRemoved + frameLag.loaderRemoved`.');
}

for (const tier of tiers) {
    ranking(tier, [
        ['`phase.untagged`', untagged],
        ['walk span', walkSpan],
        ['`loaderRemoved`', loaderRemoved],
        ['`drained`', drained],
        ['nav → actionable frame', toActionable],
    ]);
}

for (const tier of tiers) {
    guards(tier);
}
split(tiers[0]);

console.log(`\n---\n
Every number above is a median of ${j.runs} paired runs with its own spread, from one
session on one machine and one Chrome. Per the map: no absolute here may be
differenced against another ticket's.`);
