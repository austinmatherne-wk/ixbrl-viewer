// Per-run frame lag for the paired control comparison.  THROWAWAY - ticket 04.
//
//   node perf-harness/frame-lag.js perf-harness/out/t04-master-control.json
//
// The map's one window where the baseline branch and master can differ is *after*
// loader removal: the baseline hides collapsed section bodies with display:none,
// so the rows it built are never laid out.  Differencing two medians of absolute
// timestamps buries that in the arms' own run-to-run spread, because both arms'
// absolute times move together with whatever the machine is doing.  The lag
// between loader removal and the frame that follows it is a *within-run*
// difference, so it cancels that common movement - which is the only way a
// ~30ms effect is visible against a ±90ms absolute spread.
const fs = require('fs');

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const f1 = (x) => (x === undefined || Number.isNaN(x) ? '-' : (Math.round(x * 10) / 10).toString());

for (const file of process.argv.slice(2)) {
    const j = JSON.parse(fs.readFileSync(file));
    console.log(`\n## ${file.replace(/.*\//, '')} — frame lag (external observer, per run)\n`);
    console.log('| slug | tier | arm | frame lag ms (median) | min | max | n | rows | sections |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    const lags = {};
    for (const r of j.results) {
        const per = r.runs
            .filter(x => x.external?.loaderRemoved !== undefined
                && x.external?.loaderRemovedFrame !== undefined)
            .map(x => x.external.loaderRemovedFrame - x.external.loaderRemoved);
        if (!per.length) {
            continue;
        }
        lags[`${r.slug}|${r.tier}|${r.arm}`] = per;
        console.log(`| \`${r.slug}\` | ${r.tier}× | ${r.arm} | ${f1(median(per))} | `
            + `${f1(Math.min(...per))} | ${f1(Math.max(...per))} | ${per.length} | `
            + `${r.summary.rows?.median ?? '-'} | ${r.summary.sections?.median ?? '-'} |`);
    }
    console.log('\n### Δ frame lag, control − instrumented\n');
    console.log('| slug | tier | instrumented | control | Δ | control spread | verdict |');
    console.log('|---|---|---|---|---|---|---|');
    for (const key of Object.keys(lags)) {
        const [slug, tier, arm] = key.split('|');
        if (arm !== 'instrumented') {
            continue;
        }
        const c = lags[`${slug}|${tier}|control`];
        if (!c) {
            continue;
        }
        const a = lags[key];
        const d = median(c) - median(a);
        /* The map's evidence bar: a delta smaller than the spread it sits in is
         * suspected, not proven. */
        const spread = Math.max(Math.max(...c) - Math.min(...c), Math.max(...a) - Math.min(...a));
        console.log(`| \`${slug}\` | ${tier}× | ${f1(median(a))} | ${f1(median(c))} | ${f1(d)} | `
            + `±${f1(spread)} | ${Math.abs(d) > spread ? '**resolved**' : 'inside spread'} |`);
    }
}
