// Ticket 31's matched inline/stub tables.  Reads only; re-measures nothing.
//
//   node perf-harness/t31-tables.js <paired-sweep.json>
//
// Every delta is inline minus stub, paired by run index.  Positive startup
// deltas therefore mean that stub is faster.
const fs = require('fs');

const file = process.argv[2];
if (!file) {
    console.error('usage: t31-tables.js <paired-sweep.json>');
    process.exit(1);
}
const sweep = JSON.parse(fs.readFileSync(file));
if (!sweep.pairMode) {
    throw new Error('sweep was not captured with PAIR_MODE=1');
}

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const spread = (xs) => xs.length < 2 ? 0 : (Math.max(...xs) - Math.min(...xs)) / 2;
const f1 = (x) => x === null || x === undefined || !Number.isFinite(x)
    ? '-' : (Math.round(x * 10) / 10).toLocaleString('en-US');
const mb = (x) => x / 1e6;
const mib = (x) => x / (1024 * 1024);
const FLOOR = 50;

const groups = {};
for (const result of sweep.results) {
    const key = `${result.pair}|${result.tier}|${result.ablate}`;
    (groups[key] ??= {})[result.fixture.mode] = result;
}
const pairs = [...new Set(sweep.results.map(r => r.pair))].sort();
const tiers = [...new Set(sweep.results.map(r => r.tier))].sort((a, b) => a - b);
const configs = [...new Set(sweep.results.map(r => r.ablate))];

function forms(pair, tier, config) {
    return groups[`${pair}|${tier}|${config}`];
}

function paired(pair, tier, config, metric) {
    const group = forms(pair, tier, config);
    if (!group?.inline || !group.stub) {
        return null;
    }
    const inline = new Map(group.inline.runs.filter(r => !r.error).map(r => [r.run, r]));
    const stub = new Map(group.stub.runs.filter(r => !r.error).map(r => [r.run, r]));
    const values = [];
    for (const [run, ir] of inline) {
        const sr = stub.get(run);
        if (!sr) {
            continue;
        }
        const value = metric(ir) - metric(sr);
        if (Number.isFinite(value)) {
            values.push(value);
        }
    }
    if (!values.length) {
        return null;
    }
    const m = median(values);
    const s = spread(values);
    return { m, s, resolved: Math.abs(m) > s, n: values.length, values };
}

const delta = (value) => value === null ? '-'
    : `${value.m > 0 ? '+' : ''}${f1(value.m)}±${f1(value.s)}`
        + (value.resolved ? '' : ' *ns*');
const mark = (name) => r => r.marks?.[name];
const span = (name) => r => r.spans?.[name]?.ms;
const count = (name) => r => r.counts?.[name];
const loader = r => r.external?.loaderRemoved;
const drained = r => r.windows?.toDrained;
const parse = mark('phase.loading.start');
const loading = r => r.marks?.['phase.loading.end'] - r.marks?.['phase.loading.start'];
const readiness = r => r.marks?.['phase.loading.end'] - r.marks?.['iframePoll.start'];
const loaderFrameLag = r => r.windows?.toLoaderRemovedFrame - r.windows?.toLoaderRemoved;
const drainedFrameLag = r => r.windows?.toDrainedFrame - r.windows?.toDrained;
const loaderFrame = r => r.windows?.toLoaderRemovedFrame;
const drainedFrame = r => r.windows?.toDrainedFrame;
const heap = r => mib(r.peakHeapAtMarks);

console.log(`# Ticket 31 matched inline/stub results

Chrome: ${sweep.chrome}. Instrumented rig: \`${sweep.arms[0].sha}\`.
Every cell is median inline-minus-stub over ${sweep.runs} paired AB/BA runs;
\`±\` is half-range of the paired deltas. Positive startup values favor stub.
\`*ns*\` means |delta| did not exceed its spread. The map floor is ${FLOOR} ms.

\`none\` is current fork-\`master\` startup behavior. \`loadevent\` is ticket 21's
equivalent readiness behavior from the same bundle, so no build or server
difference enters either format comparison.`);

for (const tier of tiers) {
    for (const config of configs) {
        console.log(`\n## ${tier}× — \`${config}\`\n`);
        console.log('| report | source MB | loader removed | drained | loader frame lag | drained frame lag | drained frame | peak heap MiB |');
        console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
        for (const pair of pairs) {
            const group = forms(pair, tier, config);
            if (!group) {
                continue;
            }
            console.log(`| \`${pair}\` | ${f1(mb(group.inline.fixture.source_bytes))} `
                + `| ${delta(paired(pair, tier, config, loader))} `
                + `| ${delta(paired(pair, tier, config, drained))} `
                + `| ${delta(paired(pair, tier, config, loaderFrameLag))} `
                + `| ${delta(paired(pair, tier, config, drainedFrameLag))} `
                + `| ${delta(paired(pair, tier, config, drainedFrame))} `
                + `| ${delta(paired(pair, tier, config, heap))} |`);
        }
    }
}

console.log('\n## Mechanism at 1×\n');
console.log('`startup prefix` is navigation start through `phase.loading.start`; this is where inline host-document parsing lives. `loading` runs from that mark through report readiness.\n');
console.log('| report | config | startup prefix | loading | readiness wait | metadata parse | drained |');
console.log('|---|---|---:|---:|---:|---:|---:|');
for (const pair of pairs) {
    for (const config of configs) {
        if (!forms(pair, 1, config)) {
            continue;
        }
        console.log(`| \`${pair}\` | \`${config}\` `
            + `| ${delta(paired(pair, 1, config, parse))} `
            + `| ${delta(paired(pair, 1, config, loading))} `
            + `| ${delta(paired(pair, 1, config, readiness))} `
            + `| ${delta(paired(pair, 1, config, span('taxonomyData.parse')))} `
            + `| ${delta(paired(pair, 1, config, drained))} |`);
    }
}

console.log('\n## Ranking at 1×\n');
console.log('| config | worst report | drained advantage | resolved | breadth (resolved and ≥50 ms) |');
console.log('|---|---|---:|---:|---:|');
for (const config of configs) {
    const rows = pairs.map(pair => ({ pair, ...paired(pair, 1, config, drained) }))
        .filter(r => Number.isFinite(r.m))
        .sort((a, b) => b.m - a.m);
    const resolved = rows.filter(r => r.resolved);
    const breadth = resolved.filter(r => r.m >= FLOOR);
    console.log(`| \`${config}\` | \`${rows[0]?.pair ?? '-'}\` | ${delta(rows[0] ?? null)} `
        + `| ${resolved.length}/${rows.length} | ${breadth.length}/${rows.length} |`);
}

function rank(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return values.map(value => sorted.indexOf(value));
}
function correlation(xs, ys) {
    const xm = xs.reduce((a, b) => a + b, 0) / xs.length;
    const ym = ys.reduce((a, b) => a + b, 0) / ys.length;
    const numerator = xs.reduce((sum, x, i) => sum + (x - xm) * (ys[i] - ym), 0);
    const xd = Math.sqrt(xs.reduce((sum, x) => sum + (x - xm) ** 2, 0));
    const yd = Math.sqrt(ys.reduce((sum, y) => sum + (y - ym) ** 2, 0));
    return numerator / (xd * yd);
}
console.log('\n## Does the advantage track size or avoided parse?\n');
console.log('| config | Spearman ρ vs source bytes | Spearman ρ vs startup-prefix delta |');
console.log('|---|---:|---:|');
for (const config of configs) {
    const rows = pairs.map(pair => {
        const group = forms(pair, 1, config);
        return {
            source: group?.inline.fixture.source_bytes,
            startup: paired(pair, 1, config, parse)?.m,
            drained: paired(pair, 1, config, drained)?.m,
        };
    }).filter(r => Object.values(r).every(Number.isFinite));
    console.log(`| \`${config}\` | ${f1(correlation(rank(rows.map(r => r.source)), rank(rows.map(r => r.drained))))} `
        + `| ${f1(correlation(rank(rows.map(r => r.startup)), rank(rows.map(r => r.drained))))} |`);
}

console.log('\n## Pair integrity\n');
console.log('| report | metadata manifest | browser metadata | transformed report DOM |');
console.log('|---|---|---|---|');
for (const pair of pairs) {
    const group = forms(pair, tiers[0], 'none') ?? forms(pair, tiers[0], configs[0]);
    const ir = group?.inline.runs.find(r => r.run === 0 && r.integrity);
    const sr = group?.stub.runs.find(r => r.run === 0 && r.integrity);
    const manifest = group?.inline.fixture.metadata_sha256 === group?.stub.fixture.metadata_sha256;
    const browserMetadata = ir?.integrity?.metadata === sr?.integrity?.metadata
        && ir?.integrity?.metadata === group?.inline.fixture.metadata_sha256;
    const reportDom = JSON.stringify(ir?.integrity?.reportDom)
        === JSON.stringify(sr?.integrity?.reportDom);
    console.log(`| \`${pair}\` | ${manifest ? 'same' : '**MISMATCH**'} `
        + `| ${browserMetadata ? 'same' : '**MISMATCH**'} | ${reportDom ? 'same' : '**MISMATCH**'} |`);
}

const GUARDS = [
    'taxonomyData.chars',
    'continuationMaps.elementsWalked',
    'reports.sourceReports',
    'reports.targetReports',
    'reports.factsItemsScanned',
    'reports.factsForReportItemsScanned',
    'outline.buildFactsWalked',
    'outline.buildElrs',
    'factList.rowsBuilt',
    'factList.factsInGroups',
    'factList.groups',
    'drain.viewer.containsAbsolute',
    'drain.viewer.pass1Layout',
    'drain.viewer.noHighlight',
];
console.log('\n## Volume guards at 1×\n');
console.log('| report | config | comparable | moved or unstable |');
console.log('|---|---|---:|---|');
for (const pair of pairs) {
    for (const config of configs) {
        const group = forms(pair, 1, config);
        if (!group) {
            continue;
        }
        let comparable = 0;
        const moved = [];
        for (const key of GUARDS) {
            const iv = group.inline.runs.map(count(key)).filter(Number.isFinite);
            const sv = group.stub.runs.map(count(key)).filter(Number.isFinite);
            if (!iv.length && !sv.length) {
                continue;
            }
            comparable++;
            if (!iv.length || !sv.length || Math.min(...iv) !== Math.max(...iv)
                    || Math.min(...sv) !== Math.max(...sv) || median(iv) !== median(sv)) {
                moved.push(key);
            }
        }
        console.log(`| \`${pair}\` | \`${config}\` | ${comparable} `
            + `| ${moved.length ? moved.map(x => `\`${x}\``).join(', ') : '**0**'} |`);
    }
}
