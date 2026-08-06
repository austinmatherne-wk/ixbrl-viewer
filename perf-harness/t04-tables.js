// Ticket 04's tables.  THROWAWAY - startup-remediation effort only.
//
//   node perf-harness/t04-tables.js <main-1x.json> <session1-1x.json> <4x.json>
//
// Reads only; re-measures nothing.  Every figure is computed per run and only
// then reduced to a median, so it carries a spread; every cross-arm figure is
// paired by run index against the same session's `none` arm.
const fs = require('fs');

const [MAIN, SESSION1, FOURX] = process.argv.slice(2);
if (!FOURX) {
    console.error('usage: t04-tables.js <main-1x.json> <session1-1x.json> <4x.json>');
    process.exit(1);
}
const load = (p) => JSON.parse(fs.readFileSync(p));

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const spread = (xs) => (xs.length < 2 ? 0 : (Math.max(...xs) - Math.min(...xs)) / 2);
const f1 = (x) => (Math.round(x * 10) / 10).toLocaleString('en-US');

/* The drain's own work: both generators' accumulated spans, clocked with the
 * timer stopped at every yield.  `interleave` is elapsed minus this, which is
 * report entry #4's quantity. */
const WORK = ['drain.viewer.select', 'drain.viewer.pass1', 'drain.viewer.pass2',
    'drain.search.facts', 'drain.search.docs', 'drain.search.lunrAdd',
    'drain.search.lunrBuild', 'drain.search.doneCallback'];
const work = (r) => WORK.reduce((s, n) => s + (r.spans?.[n]?.ms ?? 0), 0);
const gap = (r) => r.windows.drainGap;
const interleave = (r) => gap(r) - work(r);
/* Within-run, so it carries none of the whole load's variance. */
const frameLag = (r) => r.windows.toLoaderRemovedFrame - r.windows.toLoaderRemoved;
const loaderRemoved = (r) => r.external?.loaderRemoved;
const drained = (r) => r.windows.toDrained;
const hops = (r) => (r.counts?.['sched.hops.viewer'] ?? 0) + (r.counts?.['sched.hops.search'] ?? 0);

const byFixture = (j) => {
    const g = new Map();
    for (const r of j.results) {
        if (!g.has(r.slug)) {
            g.set(r.slug, {});
        }
        g.get(r.slug)[r.ablate] = r;
    }
    return g;
};

const ARMS = ['yieldmsg', 'yieldbudget', 'yieldboth', 'yieldsched'];
const GUARDS = ['drain.viewer.yields', 'drain.search.yields', 'drain.viewer.containsAbsolute',
    'drain.viewer.pass1Layout', 'drain.viewer.noHighlight', 'drain.search.factCount',
    'drain.search.docsBuilt'];

const main = byFixture(load(MAIN));
const session1 = byFixture(load(SESSION1));
const fourx = byFixture(load(FOURX));

/* Ordered by baseline interleave: the fixtures this ticket is about come first. */
const order = [...main.keys()].sort((a, b) =>
    median(main.get(b).none.runs.map(interleave)) - median(main.get(a).none.runs.map(interleave)));

/* Paired by run index, so the delta has a spread of its own and can be held to
 * the map's bar.  Differencing two medians would throw that away. */
function paired(m, arm, fn) {
    const out = [];
    for (const r of m[arm].runs) {
        const mate = m.none.runs.find(x => x.run === r.run);
        if (mate === undefined) {
            continue;
        }
        const a = fn(r);
        const b = fn(mate);
        if (typeof a === 'number' && typeof b === 'number') {
            out.push(a - b);
        }
    }
    return out;
}

function delta(d, base) {
    const dm = median(d);
    const ds = spread(d);
    const pct = base ? ` (${dm > 0 ? '+' : ''}${Math.round(dm / base * 100)}%)` : '';
    return `${dm > 0 ? '+' : ''}${f1(dm)}±${f1(ds)}${Math.abs(dm) > ds ? pct : ' *unres*'}`;
}

const out = [];
const P = (...s) => out.push(...s);

P('## 1. The payoff — `drainGap`, all ten fixtures, all five arms, 1×', '');
P('Medians of 5 runs, spread = (max − min) / 2. Δ is the **paired per-run** delta against the same',
    "session's `none` arm and carries its own spread; *unres* means the map's bar — a delta wider than",
    'its own spread — is not met. Ordered by baseline interleave, descending.', '');
P('| fixture | `none` gap | Δ `yieldmsg` | Δ `yieldbudget` | Δ `yieldboth` | Δ `yieldsched` |',
    '|---|---|---|---|---|---|');
for (const s of order) {
    const m = main.get(s);
    const xs = m.none.runs.map(gap);
    P(`| \`${s}\` | ${f1(median(xs))}±${f1(spread(xs))} | `
        + ARMS.map(a => delta(paired(m, a, gap), median(xs))).join(' | ') + ' |');
}

P('', '## 2. The responsiveness column — frame lag at loader removal, 1×', '');
P('`frameLag` is `windows.toLoaderRemovedFrame − windows.toLoaderRemoved`: loader removal to the',
    'second rAF after it, computed **within run**. It is how long the user waits for a painted frame',
    'while the drain runs, and it is the only column that can see an arm buying its delta by not',
    'painting.', '');
P('| fixture | `none` lag | Δ `yieldmsg` | Δ `yieldbudget` | Δ `yieldboth` | Δ `yieldsched` |',
    '|---|---|---|---|---|---|');
for (const s of order) {
    const m = main.get(s);
    const xs = m.none.runs.map(frameLag);
    P(`| \`${s}\` | ${f1(median(xs))}±${f1(spread(xs))} | `
        + ARMS.map(a => delta(paired(m, a, frameLag), median(xs))).join(' | ') + ' |');
}

P('', '## 3. `yieldmsg` trades no window, and where the delta actually comes from', '');
P('`loaderRemoved` is the harness MutationObserver time — an absolute, so its spread is the whole',
    "load's and it resolves nowhere, which is what a change living entirely inside the post-load drain",
    'must do. `work` is the two generators\' own accumulated time, clocked with the timer stopped at',
    'every yield.', '');
P('**A confound to report rather than hide: the work itself gets 2–8% cheaper** on the five fixtures',
    'where it resolves (`fr` −36.1, `sec-lennar-inline` −21.7, `sec-lennar-stub` −16.1, `aviva` −15.2,',
    'and `pl` +1.0 the other way). The likely reading is that the baseline spends its 4 ms gaps on',
    'layout and paint, which dirties state the next slice\'s forced-layout reads must flush again,',
    'while back-to-back message tasks leave it warm — but this ticket measured *that* it happens, not',
    'why. It bounds how much of the headline is scheduling: on `fr`, 36.1 of the 536.2 ms delta is',
    'work getting cheaper, so **93% is the interleave** and the rest is this. The interleave columns',
    'are the ones the mechanism claim rests on.', '');
P('| fixture | Δ loaderRemoved | Δ drained | work `none` | Δ work | interleave `none` '
    + '| interleave `yieldmsg` | removed |', '|---|---|---|---|---|---|---|---|');
for (const s of order) {
    const m = main.get(s);
    const w = median(m.none.runs.map(work));
    const iN = median(m.none.runs.map(interleave));
    const iM = median(m.yieldmsg.runs.map(interleave));
    P(`| \`${s}\` | ${delta(paired(m, 'yieldmsg', loaderRemoved))} `
        + `| ${delta(paired(m, 'yieldmsg', drained))} | ${f1(w)} `
        + `| ${delta(paired(m, 'yieldmsg', work), w)} | ${f1(iN)} | ${f1(iM)} `
        + `| ${Math.round(100 * (1 - iM / iN))}% |`);
}

P('', '## 4. Mechanism — hop count is unchanged, so the delta is per-hop cost', '');
P('`sched.hops` counts posted resumes. `yieldmsg` leaves it identical and takes the whole delta',
    'anyway, so the delta is the cost of a hop and nothing else. The last column is that cost, to be',
    "read against report entry #4's independently measured **1.1–5.2 ms per yield against a 4 ms",
    'clamp**.', '');
P('| fixture | hops `none` | hops `yieldmsg` | hops `yieldboth` | ms removed per hop (`yieldmsg`) |',
    '|---|---|---|---|---|');
for (const s of order) {
    const m = main.get(s);
    const h = median(m.none.runs.map(hops));
    P(`| \`${s}\` | ${h} | ${median(m.yieldmsg.runs.map(hops))} `
        + `| ${median(m.yieldboth.runs.map(hops))} | ${f1(-median(paired(m, 'yieldmsg', gap)) / h)} |`);
}

P('', '## 5. Falsification — under a 4× CPU throttle the delta shrinks while the work quadruples', '');
P('If the change removed *work*, its delta would scale with the throttle. It does the opposite, and',
    "the interleave term's own scaling reproduces report entry #4's 1.1–2.5×.", '');
P('| fixture | Δ gap 1× | Δ gap 4× | Δ scaling | work 1× | work 4× | work scaling '
    + '| interleave scaling |', '|---|---|---|---|---|---|---|---|');
for (const s of order) {
    if (!fourx.has(s)) {
        continue;
    }
    const m1 = main.get(s);
    const m4 = fourx.get(s);
    const d1 = paired(m1, 'yieldmsg', gap);
    const d4 = paired(m4, 'yieldmsg', gap);
    const w1 = median(m1.none.runs.map(work));
    const w4 = median(m4.none.runs.map(work));
    const i1 = median(m1.none.runs.map(interleave));
    const i4 = median(m4.none.runs.map(interleave));
    P(`| \`${s}\` | ${f1(median(d1))}±${f1(spread(d1))} | ${f1(median(d4))}±${f1(spread(d4))} `
        + `| **${(median(d4) / median(d1)).toFixed(2)}×** | ${f1(w1)} | ${f1(w4)} `
        + `| ${(w4 / w1).toFixed(2)}× | ${(i4 / i1).toFixed(2)}× |`);
}

P('', '## 6. Cross-session reproducibility of the `yieldmsg` delta', '');
P('Two full corpus sweeps in separate sessions off separate bundles. The budget correction between',
    'them does not touch the `yieldmsg` path, so this is a genuine cross-session check of a',
    'within-session paired delta — the one comparison the map otherwise forbids.', '');
P('| fixture | session 1 | session 2 | agreement |', '|---|---|---|---|');
for (const s of order) {
    const a = median(paired(session1.get(s), 'yieldmsg', gap));
    const b = median(paired(main.get(s), 'yieldmsg', gap));
    P(`| \`${s}\` | ${f1(a)} | ${f1(b)} `
        + `| ${Math.abs(a) < 1 ? '— (both null)' : (Math.abs(b - a) / Math.abs(a) * 100).toFixed(1) + '%'} |`);
}

P('', '## 7. Guard counters', '');
let moved = 0;
let cells = 0;
const rows = [];
for (const s of order) {
    const m = main.get(s);
    const vals = GUARDS.map((gd) => {
        const v = ['none', ...ARMS].map(a =>
            median(m[a].runs.map(r => r.counts?.[gd]).filter(x => typeof x === 'number')));
        cells++;
        if (new Set(v).size > 1) {
            moved++;
            console.error(`GUARD MOVED: ${s} ${gd} ${v.join('/')}`);
        }
        return v[0];
    });
    rows.push(`| \`${s}\` | ` + vals.map(v => (Number.isFinite(v) ? v.toLocaleString('en-US') : '—')).join(' | ') + ' |');
}
P(`**${cells - moved} of ${cells} guard cells identical across all five arms.** Nothing here touches`,
    'a generator\'s body, so a moved guard would mean an arm had ablated something it does not own.', '');
P('| fixture | ' + GUARDS.map(x => '`' + x.replace('drain.', '') + '`').join(' | ') + ' |',
    '|---|' + GUARDS.map(() => '---').join('|') + '|');
rows.forEach(r => P(r));

console.log(out.join('\n'));
