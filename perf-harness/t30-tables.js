// Ticket 30's production confirmation tables. THROWAWAY - startup-remediation only.
//
//   node perf-harness/t30-tables.js <phase-sweep.json>
//
// Every delta is paired by run index inside one sweep.
const fs = require('fs');

const file = process.argv[2];
if (!file) {
    console.error('usage: t30-tables.js <phase-sweep.json>');
    process.exit(1);
}

const json = JSON.parse(fs.readFileSync(file));
const median = (xs) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
};
const spread = (xs) => xs.length < 2 ? 0 : (Math.max(...xs) - Math.min(...xs)) / 2;
const f1 = (x) => (Math.round(x * 10) / 10).toLocaleString('en-US');
const span = (key) => (run) => run.spans?.[key]?.ms;
const count = (key) => (run) => run.counts?.[key];
const externalLoader = (run) => run.external?.loaderRemoved;
const drained = (run) => run.windows?.toDrained;
const loaderFrameLag = (run) => run.windows?.toLoaderRemovedFrame - run.windows?.toLoaderRemoved;
const drainedFrameLag = (run) => run.windows?.toDrainedFrame - run.windows?.toDrained;

const groups = {};
for (const result of json.results) {
    (groups[`${result.slug}|${result.tier}`] ??= {})[result.ablate] =
        result.runs.filter(run => !run.error);
}
const slugs = [...new Set(json.results.map(result => result.slug))].sort();

function reduce(runs, metric) {
    const values = runs.map(metric).filter(Number.isFinite);
    return { median: median(values), spread: spread(values) };
}

function paired(arms, metric) {
    const values = arms.contid.map((run, i) => metric(run) - metric(arms.none[i]))
        .filter(Number.isFinite);
    const value = median(values);
    const range = spread(values);
    return { value, spread: range, resolved: Math.abs(value) > range };
}

function absoluteCell(runs, metric) {
    const result = reduce(runs, metric);
    return `${f1(result.median)}±${f1(result.spread)}`;
}

function deltaCell(result) {
    return `${result.value > 0 ? '+' : ''}${f1(result.value)}±${f1(result.spread)}`
        + (result.resolved ? '' : ' *ns*');
}

console.log('# Ticket 30 — native continuation-map production confirmation\n');
console.log(`Sweep: \`${json.level}\` ${json.stamp} (${json.chrome}), five paired runs per fixture and tier.\n`);

for (const tier of json.tiers) {
    console.log(`## Payoff — ${tier}×\n`);
    console.log('| fixture | baseline map | candidate map | Δ map | Δ loader removed | Δ drained | Δ loader frame lag | Δ drained frame lag |');
    console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const slug of slugs) {
        const arms = groups[`${slug}|${tier}`];
        console.log(`| \`${slug}\` `
            + `| ${absoluteCell(arms.none, span('viewer.buildContinuationMaps'))} `
            + `| ${absoluteCell(arms.contid, span('viewer.buildContinuationMaps'))} `
            + `| ${deltaCell(paired(arms, span('viewer.buildContinuationMaps')))} `
            + `| ${deltaCell(paired(arms, externalLoader))} `
            + `| ${deltaCell(paired(arms, drained))} `
            + `| ${deltaCell(paired(arms, loaderFrameLag))} `
            + `| ${deltaCell(paired(arms, drainedFrameLag))} |`);
    }
    console.log();
}

for (const tier of json.tiers) {
    console.log(`## Continuation-map counters — ${tier}×\n`);
    console.log('| fixture | elements walked baseline → candidate | eligible | items | edges | links |');
    console.log('|---|---:|---:|---:|---:|---:|');
    for (const slug of slugs) {
        const arms = groups[`${slug}|${tier}`];
        const value = (arm, key) => median(arms[arm].map(count(key)).filter(Number.isFinite));
        console.log(`| \`${slug}\` | ${f1(value('none', 'continuationMaps.elementsWalked'))} → ${f1(value('contid', 'continuationMaps.elementsWalked'))} `
            + `| ${f1(value('none', 'continuationMaps.eligible'))} `
            + `| ${f1(value('none', 'continuationMaps.items'))} `
            + `| ${f1(value('none', 'continuationMaps.edges'))} `
            + `| ${f1(value('none', 'continuationMaps.links'))} |`);
    }
    console.log();
}

const guards = [
    'continuationMaps.eligible', 'continuationMaps.items', 'continuationMaps.edges',
    'continuationMaps.links', 'reports.factsItemsScanned', 'factList.rowsBuilt',
    'factList.groups', 'outline.buildElrs', 'outline.buildFactsWalked',
    'drain.viewer.containsAbsolute', 'drain.viewer.pass1Layout',
    'drain.viewer.noHighlight', 'drain.search.factCount', 'drain.search.docsBuilt',
];
for (const tier of json.tiers) {
    console.log(`## Guard counters — ${tier}×\n`);
    console.log('| fixture | moved guards |');
    console.log('|---|---|');
    for (const slug of slugs) {
        const arms = groups[`${slug}|${tier}`];
        const moved = guards.filter(key => {
            const baseline = arms.none.map(count(key)).filter(Number.isFinite);
            const candidate = arms.contid.map(count(key)).filter(Number.isFinite);
            return baseline.length !== candidate.length
                || baseline.some((value, i) => value !== candidate[i]);
        });
        console.log(`| \`${slug}\` | ${moved.length ? moved.map(key => `\`${key}\``).join(', ') : '**0**'} |`);
    }
    console.log();
}

for (const tier of json.tiers) {
    const rows = slugs.map(slug => ({
        slug,
        ...paired(groups[`${slug}|${tier}`], span('viewer.buildContinuationMaps')),
    })).sort((a, b) => a.value - b.value);
    const resolved = rows.filter(row => row.resolved);
    const aboveFloor = resolved.filter(row => -row.value >= 50);
    console.log(`## Ranking summary — ${tier}×\n`);
    console.log(`Worst fixture: \`${rows[0].slug}\` ${deltaCell(rows[0])}. `
        + `Resolved ${resolved.length}/${rows.length}; at least 50 ms ${aboveFloor.length}/${rows.length}`
        + (aboveFloor.length ? ` (${aboveFloor.map(row => `\`${row.slug}\``).join(', ')})` : '') + '.\n');
}
