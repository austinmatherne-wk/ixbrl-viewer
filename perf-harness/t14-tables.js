// Ticket 14's continuation-map tables.  THROWAWAY - startup-remediation only.
//
//   node perf-harness/t14-tables.js <phase-sweep.json> <deep-sweep.json> [...]
//
// Every delta is paired by run index inside one sweep.  Phase-level runs decide
// payoff; deep runs attribute select/iteration/chain and never supply a startup
// window.
const fs = require('fs');

const FILES = process.argv.slice(2);
if (!FILES.length) {
    console.error('usage: t14-tables.js <sweep.json> [...]');
    process.exit(1);
}

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const spread = (xs) => xs.length < 2 ? 0 : (Math.max(...xs) - Math.min(...xs)) / 2;
const f1 = (x) => x === null || x === undefined || !Number.isFinite(x)
    ? '-' : (Math.round(x * 10) / 10).toLocaleString('en-US');
const span = (k) => (r) => r.spans?.[k]?.ms;
const count = (k) => (r) => r.counts?.[k];
const externalLoader = (r) => r.external?.loaderRemoved;
const drained = (r) => r.windows?.toDrained;
const loaderFrameLag = (r) => r.windows?.toLoaderRemovedFrame - r.windows?.toLoaderRemoved;
const drainedFrameLag = (r) => r.windows?.toDrainedFrame - r.windows?.toDrained;

const groups = {};
const metadata = [];
for (const file of FILES) {
    const json = JSON.parse(fs.readFileSync(file));
    metadata.push({ file, stamp: json.stamp, level: json.level, chrome: json.chrome });
    for (const result of json.results) {
        const key = `${json.level}|${result.slug}|${result.tier}`;
        (groups[key] ??= {})[result.ablate] = result.runs.filter(r => !r.error);
    }
}
const levels = [...new Set(Object.keys(groups).map(k => k.split('|')[0]))].sort();
const slugs = [...new Set(Object.keys(groups).map(k => k.split('|')[1]))].sort();
const tiers = [...new Set(Object.keys(groups).map(k => Number(k.split('|')[2])))]
    .sort((a, b) => a - b);

function paired(arms, arm, base, metric) {
    if (!arms?.[arm] || !arms?.[base]) {
        return null;
    }
    const n = Math.min(arms[arm].length, arms[base].length);
    const values = [];
    for (let i = 0; i < n; i++) {
        const value = metric(arms[arm][i]) - metric(arms[base][i]);
        if (Number.isFinite(value)) {
            values.push(value);
        }
    }
    if (!values.length) {
        return null;
    }
    const m = median(values);
    const s = spread(values);
    return { m, s, resolved: Math.abs(m) > s, n: values.length };
}

function cell(result) {
    if (result === null) {
        return '-';
    }
    return `${result.m > 0 ? '+' : ''}${f1(result.m)}±${f1(result.s)}`
        + (result.resolved ? '' : ' *ns*');
}

function baseCell(runs, metric) {
    const values = (runs ?? []).map(metric).filter(Number.isFinite);
    return values.length ? `${f1(median(values))}±${f1(spread(values))}` : '-';
}

console.log('# Ticket 14 — continuation-map walk\n');
console.log(`Sweeps: ${metadata.map(m => `\`${m.level}\` ${m.stamp} (${m.chrome})`).join(' · ')}\n`);

for (const tier of tiers) {
    console.log(`## Candidate payoff — ${tier}× phase runs\n`);
    console.log('`contid` narrows to id-bearing descendants and removes jQuery iteration.'
        + ' `contidjq` is the selector-only control that exposes their interaction.\n');
    console.log('| fixture | baseline map ms | selector-only Δ map | candidate Δ map | Δ loader removed | Δ drained | Δ loader frame lag | Δ drained frame lag |');
    console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const slug of slugs) {
        const arms = groups[`phase|${slug}|${tier}`];
        if (!arms?.none || !arms?.contidjq || !arms?.contid) {
            continue;
        }
        console.log(`| \`${slug}\` | ${baseCell(arms.none, span('viewer.buildContinuationMaps'))} `
            + `| ${cell(paired(arms, 'contidjq', 'none', span('viewer.buildContinuationMaps')))} `
            + `| ${cell(paired(arms, 'contid', 'none', span('viewer.buildContinuationMaps')))} `
            + `| ${cell(paired(arms, 'contid', 'none', externalLoader))} `
            + `| ${cell(paired(arms, 'contid', 'none', drained))} `
            + `| ${cell(paired(arms, 'contid', 'none', loaderFrameLag))} `
            + `| ${cell(paired(arms, 'contid', 'none', drainedFrameLag))} |`);
    }
    console.log();
}

for (const tier of tiers) {
    console.log(`## The 2×2 — ${tier}× phase runs, Δ \`viewer.buildContinuationMaps\`\n`);
    console.log('| fixture | native/full vs jq/full | jq/id vs jq/full | native/id vs native/full | native/id vs jq/id | candidate vs baseline |');
    console.log('|---|---:|---:|---:|---:|---:|');
    for (const slug of slugs) {
        const arms = groups[`phase|${slug}|${tier}`];
        if (!arms?.none || !arms?.contplain || !arms?.contidjq || !arms?.contid) {
            continue;
        }
        const metric = span('viewer.buildContinuationMaps');
        console.log(`| \`${slug}\` `
            + `| ${cell(paired(arms, 'contplain', 'none', metric))} `
            + `| ${cell(paired(arms, 'contidjq', 'none', metric))} `
            + `| ${cell(paired(arms, 'contid', 'contplain', metric))} `
            + `| ${cell(paired(arms, 'contid', 'contidjq', metric))} `
            + `| ${cell(paired(arms, 'contid', 'none', metric))} |`);
    }
    console.log();
}

for (const tier of tiers) {
    console.log(`## Deep attribution — ${tier}×\n`);
    console.log('| fixture | arm | total map | select | iterate | chain | nodes visited | eligible | items | edges | links |');
    console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const slug of slugs) {
        const arms = groups[`deep|${slug}|${tier}`];
        if (!arms) {
            continue;
        }
        for (const arm of ['none', 'contplain', 'contidjq', 'contid']) {
            const runs = arms[arm];
            if (!runs) {
                continue;
            }
            console.log(`| \`${slug}\` | \`${arm}\` `
                + `| ${baseCell(runs, span('viewer.buildContinuationMaps'))} `
                + `| ${baseCell(runs, span('continuationMaps.select'))} `
                + `| ${baseCell(runs, span('continuationMaps.iterate'))} `
                + `| ${baseCell(runs, span('continuationMaps.chain'))} `
                + `| ${f1(median(runs.map(count('continuationMaps.elementsWalked')).filter(Number.isFinite)))} `
                + `| ${f1(median(runs.map(count('continuationMaps.eligible')).filter(Number.isFinite)))} `
                + `| ${f1(median(runs.map(count('continuationMaps.items')).filter(Number.isFinite)))} `
                + `| ${f1(median(runs.map(count('continuationMaps.edges')).filter(Number.isFinite)))} `
                + `| ${f1(median(runs.map(count('continuationMaps.links')).filter(Number.isFinite)))} |`);
        }
    }
    console.log();
}

const GUARDS = [
    'continuationMaps.eligible', 'continuationMaps.items', 'continuationMaps.edges',
    'continuationMaps.links', 'reports.factsItemsScanned', 'factList.rowsBuilt',
    'factList.groups', 'outline.buildElrs', 'outline.buildFactsWalked',
    'drain.viewer.containsAbsolute', 'drain.viewer.pass1Layout',
    'drain.viewer.noHighlight', 'drain.search.factCount', 'drain.search.docsBuilt',
];
for (const tier of tiers) {
    console.log(`## Guard counters — ${tier}× phase runs, baseline → candidate\n`);
    console.log('`elementsWalked` is intentionally excluded: it is the mechanism counter and must fall.\n');
    console.log('| fixture | moved guards |');
    console.log('|---|---|');
    for (const slug of slugs) {
        const arms = groups[`phase|${slug}|${tier}`];
        if (!arms?.none || !arms?.contid) {
            continue;
        }
        const moved = [];
        for (const key of GUARDS) {
            const a = arms.none.map(count(key)).filter(Number.isFinite);
            const b = arms.contid.map(count(key)).filter(Number.isFinite);
            const stable = (xs) => xs.length && Math.min(...xs) === Math.max(...xs);
            if (!a.length && !b.length) {
                continue;
            }
            if (!a.length || !b.length || median(a) !== median(b) || !stable(a) || !stable(b)) {
                moved.push(key);
            }
        }
        console.log(`| \`${slug}\` | ${moved.length ? moved.map(k => `\`${k}\``).join(', ') : '**0**'} |`);
    }
    console.log();
}

for (const tier of tiers) {
    const rows = [];
    for (const slug of slugs) {
        const arms = groups[`phase|${slug}|${tier}`];
        const result = paired(arms, 'contid', 'none', span('viewer.buildContinuationMaps'));
        if (result) {
            rows.push({ slug, ...result });
        }
    }
    if (!rows.length) {
        continue;
    }
    rows.sort((a, b) => a.m - b.m);
    const resolved = rows.filter(r => r.resolved);
    const aboveFloor = resolved.filter(r => -r.m >= 50);
    console.log(`## Ranking summary — ${tier}×\n`);
    console.log(`Worst fixture: \`${rows[0].slug}\` ${cell(rows[0])}.  `
        + `Resolved ${resolved.length}/${rows.length}; at least 50 ms `
        + `${aboveFloor.length}/${rows.length}`
        + (aboveFloor.length ? ` (${aboveFloor.map(r => `\`${r.slug}\``).join(', ')})` : '') + '.\n');
}

if (!levels.includes('phase')) {
    console.error('warning: no phase sweep supplied; payoff tables are empty');
}
if (!levels.includes('deep')) {
    console.error('warning: no deep sweep supplied; attribution tables are empty');
}
