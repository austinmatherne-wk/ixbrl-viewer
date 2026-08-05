// Phase-level startup measurement across the corpus.  THROWAWAY - for the
// startup-slowness investigation (.scratch/startup-slowness, ticket 03) only.
//
//   node perf-harness/measure-phases.js [slug ...]     # default: every fixture
//
// One command, every metric the map's evidence bar demands: both time windows
// with their first frames, per-phase and sub-phase spans, volume counters, heap
// and DOM size, at two CPU tiers, over >=5 runs, reported as median with spread,
// optionally paired against a second build of the same fixture.
//
// Requires the instrumented build (perf.js exports on window.IXVPERF).  Against
// an uninstrumented build every run reports timedOut with no marks - that is the
// expected failure, not a harness bug; use CONTROL= to measure such a build as
// the paired arm, where only the externally-observable numbers are read.
//
// Env:
//   RUNS=n            runs per (fixture, tier, build).  Default 5 - the map's bar.
//   TIERS=1,4         CPU throttle tiers.  Default "1,4".
//   LEVEL=phase|deep  ?ixvperf= level.  deep splits the wrapper hot path and
//                     distorts it; never source a phase table from deep.
//   REVIEW=1          load with ?review=1, so the untagged-numbers phase runs.
//   CONTROL=dir       repo checkout of a second build to measure as a paired arm
//                     on a second port, same session, alternating runs.  Its
//                     dist/ixbrlviewer.dev.js must already be built.
//   ABLATE_ARMS=a,b   ticket 05's ablation arms, measured as N paired arms off
//                     *one* build and one server, differing only by ?ixvablate=,
//                     alternating run by run.  Arms: none (unablated), noscan,
//                     nostyle, styleonly - see ABLATE in perf.js.  Mutually
//                     exclusive with CONTROL.
//   PROFILE=1         write a .cpuprofile for run 0 of each arm.
//   FIXTURE_ROOT=dir  where the fixture dirs live.  Default <repo>/.scratch/
//                     startup-slowness, which in a worktree is NOT the checkout
//                     holding the corpus - pass it explicitly there.
//   PORT=n            first port; the control arm takes n+1.  Default 8910.
//   OUT=file          JSON output.  Default perf-harness/out/phases-<stamp>.json
//   HEADFUL=1         run a visible browser (debugging only; changes timings).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.dirname(__dirname);
const HARNESS_DIR = __dirname;
const FIXTURE_ROOT = process.env.FIXTURE_ROOT || path.join(REPO, '.scratch', 'startup-slowness');
const BUNDLE = path.join('iXBRLViewerPlugin', 'viewer', 'dist', 'ixbrlviewer.dev.js');
const RUNS = Number(process.env.RUNS || 5);
const TIERS = (process.env.TIERS || '1,4').split(',').map(Number);
const LEVEL = process.env.LEVEL || 'phase';
const CONTROL = process.env.CONTROL || null;
const ABLATE_ARMS = process.env.ABLATE_ARMS ? process.env.ABLATE_ARMS.split(',') : null;
const PORT = Number(process.env.PORT || 8910);
if (ABLATE_ARMS && CONTROL) {
    console.error('ABLATE_ARMS and CONTROL are mutually exclusive');
    process.exit(1);
}

/* A git worktree has no node_modules of its own, so fall back to the checkout the
 * fixtures live in - it has to be a checkout of this repo for FIXTURE_ROOT to
 * resolve at all.  Saves an npm ci per worktree, and the harness needs only
 * puppeteer-core and http-server, neither of which is version-sensitive here. */
const NODE_MODULES = [
    path.join(REPO, 'node_modules'),
    path.join(path.dirname(path.dirname(FIXTURE_ROOT)), 'node_modules'),
].find(d => fs.existsSync(path.join(d, 'puppeteer-core')));
if (NODE_MODULES === undefined) {
    console.error('no node_modules with puppeteer-core found - run npm ci');
    process.exit(1);
}
const puppeteer = require(path.join(NODE_MODULES, 'puppeteer-core'));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = process.env.OUT || path.join(HARNESS_DIR, 'out', `phases-${stamp}.json`);

/* Every metric is reported as a median with its spread, so a single run is never
 * quotable.  These are the numeric leaves aggregation walks. */
const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r1 = (x) => (typeof x === 'number' ? Math.round(x * 10) / 10 : x);

function sh(cmd, args, opts = {}) {
    const r = require('child_process').spawnSync(cmd, args, { encoding: 'utf8', ...opts });
    return (r.stdout || '').trim();
}

function buildInfo(repo) {
    const bundle = path.join(repo, BUNDLE);
    if (!fs.existsSync(bundle)) {
        throw new Error(`no built bundle at ${bundle} - run npm run font && npm run dev in ${repo}`);
    }
    return {
        repo,
        sha: sh('git', ['-C', repo, 'rev-parse', 'HEAD']),
        branch: sh('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']),
        /* A dirty tree means the SHA does not identify what was measured. */
        dirty: sh('git', ['-C', repo, 'status', '--porcelain', '--', 'iXBRLViewerPlugin']) !== '',
        bundleBytes: fs.statSync(bundle).size,
        bundleMtime: fs.statSync(bundle).mtime.toISOString(),
    };
}

function fixtures() {
    return fs.readdirSync(FIXTURE_ROOT)
        .filter(d => fs.existsSync(path.join(FIXTURE_ROOT, d, 'fixture.json')))
        .map(d => ({ slug: d, ...JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, d, 'fixture.json'))) }))
        .sort((a, b) => a.slug.localeCompare(b.slug));
}

/*
 * Serve root for one build: a tree of symlinks, one directory per fixture, with
 * ixbrlviewer.dev.js pointed at that build's dist.  This is what makes the paired
 * two-build comparison affordable - the corpus holds 600MB of source documents
 * and none of it is copied, and neither checkout's own dist/ is disturbed.
 */
function serveRoot(build, all) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ixv-perf-'));
    for (const fx of all) {
        const dir = path.join(root, fx.slug);
        fs.mkdirSync(dir);
        for (const entry of fs.readdirSync(path.join(FIXTURE_ROOT, fx.slug))) {
            if (entry === 'ixbrlviewer.dev.js') {
                continue;
            }
            fs.symlinkSync(path.join(FIXTURE_ROOT, fx.slug, entry), path.join(dir, entry));
        }
        fs.symlinkSync(path.join(build.repo, BUNDLE), path.join(dir, 'ixbrlviewer.dev.js'));
    }
    return root;
}

/*
 * Timeouts have to span four orders of magnitude of fixture size: 37KB loads in
 * under a second, 203MB takes minutes, and a 4x tier multiplies both.  A timeout
 * tuned for one is either wasteful or fatal for the other.
 */
function timeoutFor(fx, tier) {
    const mb = (fx.source_bytes + (fx.stub_bytes ?? 0)) / 1e6;
    return Math.min(1_800_000, Math.round((30_000 + mb * 3_000) * tier));
}

/* Read once, at the end: these CDP counters are cumulative for the page's whole
 * life, so a single read after drain is the total.  LayoutDuration and
 * RecalcStyleDuration are the only view the harness has of time spent in layout
 * and style resolution rather than in JS. */
const CDP_METRICS = [
    'Nodes', 'Documents', 'JSEventListeners', 'LayoutCount', 'RecalcStyleCount',
    'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration',
    'JSHeapUsedSize', 'JSHeapTotalSize',
];

async function cdpMetrics(cdp) {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const out = {};
    for (const m of metrics) {
        if (CDP_METRICS.includes(m.name)) {
            /* The Duration metrics are seconds; everything else is a count or bytes. */
            out[m.name] = m.name.endsWith('Duration') ? m.value * 1000 : m.value;
        }
    }
    return out;
}

/*
 * Injected before any page script, into both arms: an externally observed
 * loader-removal time that does not depend on the build being instrumented.
 *
 * This is what makes a paired comparison against an uninstrumented build
 * meaningful - both arms are then measured by identical machinery, and the
 * instrumented build's own marks are only used for attribution within it.  The
 * older harness polled the DOM every 100ms for this, which is far too coarse to
 * see an instrumentation overhead of tens of milliseconds.
 *
 * The observer is attached to #ixv with childList and no subtree, because the
 * loader is a direct child of it.  A subtree observer would be catastrophic here:
 * this load rewrites every node of a document that runs to 203MB.
 */
function installExternalObserver() {
    window.__IXVEXT = {};
    const attach = (ixv) => {
        const obs = new MutationObserver((records) => {
            for (const r of records) {
                for (const n of r.removedNodes) {
                    if (n.nodeType === 1 && n.classList.contains('loader')) {
                        window.__IXVEXT.loaderRemoved = performance.now();
                        obs.disconnect();
                        requestAnimationFrame(() => requestAnimationFrame(() => {
                            window.__IXVEXT.loaderRemovedFrame = performance.now();
                        }));
                        return;
                    }
                }
            }
        });
        obs.observe(ixv, { childList: true });
        /* Recorded so a run where the observer attached too late to see the
         * removal is identifiable rather than silently missing a number. */
        window.__IXVEXT.attached = performance.now();
    };
    const find = setInterval(() => {
        const ixv = document.getElementById('ixv');
        if (ixv) {
            clearInterval(find);
            attach(ixv);
        }
    }, 5);
}

/*
 * Live node count across the viewer document and every report iframe.  The CDP
 * Nodes metric counts every node the renderer still holds, in any document and
 * including detached ones, so Nodes minus this is a detached-node estimate.
 *
 * Counting all node types, not just elements, is what makes that subtraction
 * mean anything: text nodes are the majority of a report's DOM, and comparing an
 * all-nodes total against an elements-only total would report a filing's text
 * nodes as if they had been detached.  The walk is expensive on a 203MB report,
 * but it runs after every timing has been taken.
 */
function liveDomCounts() {
    const countAll = (doc) => {
        let n = 1;                                  /* the document node itself */
        const w = doc.createTreeWalker(doc, NodeFilter.SHOW_ALL);
        while (w.nextNode()) {
            n++;
        }
        return n;
    };
    let iframeNodes = 0;
    let iframeElements = 0;
    let iframes = 0;
    for (const f of document.querySelectorAll('iframe')) {
        iframes++;
        try {
            iframeNodes += countAll(f.contentDocument);
            iframeElements += f.contentDocument.getElementsByTagName('*').length;
        }
        catch (e) { /* cross-origin; not possible for our fixtures */ }
    }
    return {
        viewerNodes: countAll(document),
        viewerElements: document.getElementsByTagName('*').length,
        iframeNodes,
        iframeElements,
        iframes,
    };
}

async function measure(browser, armObj, fx, tier, runIndex) {
    const { base, name: arm, instrumented } = armObj;
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('Performance.enable');
    if (tier > 1) {
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: tier });
    }
    const profiling = process.env.PROFILE === '1' && runIndex === 0;
    if (profiling) {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
        await cdp.send('Profiler.start');
    }

    const params = [];
    if (armObj.hasPerf) {
        params.push(`ixvperf=${armObj.level}`);
    }
    /* Omitted for the unablated arm so its URL is exactly what every other
     * ticket measures, and a stray ablation cannot hide in a baseline. */
    if (armObj.ablate !== undefined && armObj.ablate !== 'none') {
        params.push(`ixvablate=${armObj.ablate}`);
    }
    if (process.env.REVIEW === '1') {
        params.push('review=1');
    }
    const url = `${base}/${fx.slug}/${fx.entry}` + (params.length ? `?${params.join('&')}` : '');
    const timeout = timeoutFor(fx, tier);

    const out = { slug: fx.slug, tier, arm, armLevel: armObj.level,
        ablate: armObj.ablate ?? 'none', run: runIndex, url, timeout };
    await page.evaluateOnNewDocument(installExternalObserver);
    const wallStart = Date.now();
    await page.goto(url, { waitUntil: 'load', timeout });

    /* Stop at the first window on every arm, and read the cumulative CDP counters
     * there.  Without this the two arms would be read at different points in the
     * page's life - the control has no drain signal to wait for - and their
     * LayoutDuration and RecalcStyleDuration totals would differ by a whole phase
     * for reasons that have nothing to do with what is being compared. */
    await page.waitForFunction(
        () => window.__IXVEXT?.loaderRemovedFrame !== undefined
            || document.querySelector('#inspector.failed-to-load'),
        { timeout, polling: 100 }).catch(() => { out.timedOut = true; });
    /* Reads between the post-load passes' setTimeout slices, so it overshoots the
     * window by at most one slice. */
    out.metricsAtLoaderRemoved = await cdpMetrics(cdp);

    if (instrumented) {
        /* The instrumented build signals drain itself.  This anchor works on a
         * filing with no presentation ELRs, where the section-list anchor the
         * older harness used never satisfies (es-esef-huge-doc). */
        await page.waitForFunction(() => window.IXVPERF?.done === true,
            { timeout, polling: 250 }).catch(() => { out.timedOut = true; });
    }
    out.wallMs = Date.now() - wallStart;

    const observed = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] || {};
        return {
            perf: window.IXVPERF ?? null,
            external: window.__IXVEXT ?? null,
            /* Externally observable, and the only timings the control arm has. */
            observedNow: performance.now(),
            loadEventEnd: nav.loadEventEnd,
            domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
            sections: document.querySelectorAll('#inspector .facts-by-group .collapsible-section').length,
            rows: document.querySelectorAll('#inspector .facts-by-group .fact-list-item').length,
        };
    });
    Object.assign(out, {
        loadEventEnd: observed.loadEventEnd,
        domContentLoadedEventEnd: observed.domContentLoadedEventEnd,
        sections: observed.sections,
        rows: observed.rows,
        external: observed.external,
    });

    const perf = observed.perf;
    if (perf) {
        out.level = perf.level;
        out.marks = perf.marks;
        out.spans = perf.spans;
        out.counts = perf.counts;
        out.heap = perf.heap;
        out.detail = perf.detail;
        /* The two windows the map always reports separately, each with the frame
         * on which its layout and paint actually landed. */
        out.windows = {
            toLoaderRemoved: perf.marks.loaderRemoved,
            toLoaderRemovedFrame: perf.marks.loaderRemovedFrame,
            toDrained: perf.marks.drained,
            toDrainedFrame: perf.marks.drainedFrame,
            /* The gap is itself a finding, per the map's methodology. */
            drainGap: perf.marks.drained !== undefined && perf.marks.loaderRemoved !== undefined
                ? perf.marks.drained - perf.marks.loaderRemoved : undefined,
        };
        out.peakHeapAtMarks = Math.max(0, ...Object.values(perf.heap ?? {}));
    }
    else {
        /* No internal marks: the external observer is the only timing there is,
         * and the second window is unmeasurable on this arm by construction. */
        out.windows = {
            toLoaderRemoved: observed.external?.loaderRemoved,
            toLoaderRemovedFrame: observed.external?.loaderRemovedFrame,
        };
    }

    /* Metrics again at the end.  On the control arm this is the same point as
     * metricsAtLoaderRemoved; on the instrumented arm the difference between the
     * two is the post-load passes' share of layout, style recalc and script. */
    out.metrics = await cdpMetrics(cdp);
    out.live = await page.evaluate(liveDomCounts);
    try {
        await cdp.send('HeapProfiler.collectGarbage');
        out.metricsAfterGC = await cdpMetrics(cdp);
        out.liveAfterGC = await page.evaluate(liveDomCounts);
        /* Nodes the renderer still holds after a forced collection that are in no
         * document - what the load left behind.  An estimate: Blink's Nodes
         * counter and a TreeWalker do not have to agree node for node, so read the
         * trend across fixtures rather than the absolute value. */
        out.detachedNodesEstimate = out.metricsAfterGC.Nodes
            - (out.liveAfterGC.viewerNodes + out.liveAfterGC.iframeNodes);
    }
    catch (e) {
        out.gcError = String(e.message);
    }

    if (profiling) {
        const { profile } = await cdp.send('Profiler.stop');
        const dir = path.join(HARNESS_DIR, 'out');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${fx.slug}-${arm}-cpu${tier}x-${stamp}.cpuprofile`);
        fs.writeFileSync(file, JSON.stringify(profile));
        out.profile = file;
    }
    await page.close();
    return out;
}

/*
 * Aggregate a list of runs into median/spread per numeric leaf.  Generic rather
 * than a fixed metric list so a mark or counter added to perf.js is summarised
 * without touching the harness.
 */
function aggregate(runs) {
    const leaves = {};
    const walk = (obj, prefix) => {
        for (const [k, v] of Object.entries(obj ?? {})) {
            const key = prefix ? `${prefix}.${k}` : k;
            if (typeof v === 'number') {
                (leaves[key] ??= []).push(v);
            }
            else if (v && typeof v === 'object' && !Array.isArray(v)) {
                walk(v, key);
            }
        }
    };
    for (const r of runs) {
        walk({
            windows: r.windows, external: r.external,
            marks: r.marks, spans: r.spans, counts: r.counts,
            heap: r.heap, metricsAtLoaderRemoved: r.metricsAtLoaderRemoved,
            metrics: r.metrics, metricsAfterGC: r.metricsAfterGC,
            live: r.live, liveAfterGC: r.liveAfterGC,
            loadEventEnd: r.loadEventEnd, wallMs: r.wallMs, rows: r.rows,
            sections: r.sections, peakHeapAtMarks: r.peakHeapAtMarks,
            detachedNodesEstimate: r.detachedNodesEstimate,
        }, '');
    }
    const summary = {};
    for (const [k, xs] of Object.entries(leaves)) {
        summary[k] = {
            median: r1(median(xs)),
            min: r1(Math.min(...xs)),
            max: r1(Math.max(...xs)),
            spread: r1(Math.max(...xs) - Math.min(...xs)),
            n: xs.length,
        };
    }
    return summary;
}

async function main() {
    const want = process.argv.slice(2);
    let all = fixtures();
    if (want.length) {
        all = all.filter(f => want.includes(f.slug));
        const missing = want.filter(w => !all.some(f => f.slug === w));
        if (missing.length) {
            console.error(`unknown fixture(s): ${missing.join(', ')}`);
            process.exit(1);
        }
    }
    if (!all.length) {
        console.error(`no fixtures with fixture.json under ${FIXTURE_ROOT}`);
        process.exit(1);
    }

    /* hasPerf: the build carries perf.js, so ?ixvperf= means something to it.
     * level:   what to ask that build for.
     * A level of off leaves no window.IXVPERF, so there is no drain signal to wait
     * for and the arm is measured through the external observer alone - exactly as
     * a plain uninstrumented build is. */
    const arm = (name, repo, hasPerf, level, port) => ({
        name, build: buildInfo(repo), hasPerf, level,
        instrumented: hasPerf && level !== 'off', port,
    });
    /* Ablation arms are one build, one server, one bundle: only the query string
     * differs, so a delta between them cannot be a build-to-build difference.
     * They share a serve root, wired up after the arms are built. */
    const arms = ABLATE_ARMS
        ? ABLATE_ARMS.map(a => ({ ...arm(`ablate-${a}`, REPO, true, LEVEL, PORT), ablate: a }))
        : [arm('instrumented', REPO, true, LEVEL, PORT)];
    if (CONTROL) {
        arms.push(arm('control', path.resolve(CONTROL),
            process.env.CONTROL_INSTRUMENTED === '1',
            /* Pointing CONTROL at this same checkout with CONTROL_LEVEL=off is how
             * the instrumentation's own cost gets measured as a paired, same-build,
             * same-session comparison rather than across two invocations. */
            process.env.CONTROL_LEVEL || LEVEL,
            PORT + 1));
    }

    const servers = [];
    const roots = [];
    /* Arms sharing a port share a serve root and a server - the ablation case,
     * where every arm is the same build and only the query string differs.  One
     * server also removes any chance of a per-server difference being read as an
     * ablation delta. */
    for (const arm of arms) {
        const shared = arms.find(a => a.port === arm.port && a.root !== undefined);
        arm.root = shared?.root ?? serveRoot(arm.build, all);
        arm.base = `http://127.0.0.1:${arm.port}`;
        if (shared !== undefined) {
            continue;
        }
        roots.push(arm.root);
        servers.push(spawn(path.join(NODE_MODULES, '.bin', 'http-server'),
            /* Loopback only, deliberately: these fixtures are third-party filings. */
            [arm.root, '-p', String(arm.port), '-a', '127.0.0.1', '--silent'],
            { stdio: 'ignore' }));
    }
    await new Promise(r => setTimeout(r, 1500));

    const browser = await puppeteer.launch({
        channel: 'chrome',
        headless: process.env.HEADFUL === '1' ? false : 'new',
        /* Precise memory info: without it usedJSHeapSize is bucketed to 100KB. */
        args: ['--window-size=1440,900', '--enable-precise-memory-info'],
        defaultViewport: { width: 1440, height: 900 },
    });

    const result = {
        stamp,
        runs: RUNS,
        tiers: TIERS,
        level: LEVEL,
        review: process.env.REVIEW === '1',
        fixtureRoot: FIXTURE_ROOT,
        machine: { platform: os.platform(), arch: os.arch(), cpus: os.cpus().length,
            model: os.cpus()[0]?.model, totalMemBytes: os.totalmem() },
        chrome: await browser.version(),
        arms: arms.map(a => ({ name: a.name, port: a.port, level: a.level,
            hasPerf: a.hasPerf, instrumented: a.instrumented, ablate: a.ablate ?? 'none',
            ...a.build })),
        results: [],
    };

    const write = () => {
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
    };
    write();

    for (const fx of all) {
        for (const tier of TIERS) {
            const byArm = {};
            for (const arm of arms) {
                byArm[arm.name] = [];
            }
            /* Runs alternate between arms so that a machine that drifts mid-session
             * drifts both arms equally.  Ticket 01 found this machine 2% off its
             * own numbers from a day earlier, which is enough to fake a delta. */
            for (let i = 0; i < RUNS; i++) {
                for (const arm of arms) {
                    process.stderr.write(`${fx.slug} ${tier}x ${arm.name} run ${i} ... `);
                    try {
                        const r = await measure(browser, arm, fx, tier, i);
                        byArm[arm.name].push(r);
                        process.stderr.write(
                            `${r.timedOut ? 'TIMEOUT ' : ''}loaderRemoved=${r1(r.windows.toLoaderRemoved)}ms `
                            + `drained=${r1(r.windows.toDrained)}ms\n`);
                    }
                    catch (e) {
                        process.stderr.write(`FAILED: ${e.message}\n`);
                        byArm[arm.name].push({ slug: fx.slug, tier, arm: arm.name, run: i, error: String(e.message) });
                    }
                }
            }
            for (const arm of arms) {
                const runs = byArm[arm.name].filter(r => !r.error);
                result.results.push({
                    slug: fx.slug,
                    tier,
                    arm: arm.name,
                    armLevel: arm.level,
                    ablate: arm.ablate ?? 'none',
                    fixture: { mode: fx.mode, entry: fx.entry, source_bytes: fx.source_bytes,
                        stub_bytes: fx.stub_bytes ?? null, docs: fx.sources?.length ?? null },
                    ok: runs.length,
                    failed: byArm[arm.name].length - runs.length,
                    timedOut: runs.filter(r => r.timedOut).length,
                    summary: aggregate(runs),
                    runs: byArm[arm.name],
                });
                write();
            }
        }
    }

    await browser.close();
    for (const s of servers) {
        s.kill();
    }
    for (const root of roots) {
        fs.rmSync(root, { recursive: true, force: true });
    }

    /* Console summary: the two windows only.  Everything else is in the JSON,
     * which is what ticket 04 aggregates. */
    console.log(`\n=== medians of ${RUNS} runs, level=${LEVEL} -> ${OUT} ===`);
    for (const r of result.results) {
        const s = r.summary;
        const q = (k) => (s[k] ? `${s[k].median}±${s[k].spread}` : '-');
        console.log([
            r.slug.padEnd(20), `${r.tier}x`.padEnd(4),
            `${r.arm}/${r.armLevel}`.padEnd(20),
            /* external.loaderRemoved is the cross-arm comparable number; the
             * internal marks are for attribution within the instrumented arm. */
            `ext=${q('external.loaderRemoved')}`,
            `frame=${q('external.loaderRemovedFrame')}`,
            `drained=${q('windows.toDrained')}`,
            `gap=${q('windows.drainGap')}`,
            /* Span names contain dots, so they flatten into the key as-is. */
            `fcwn=${q('spans.viewer.findOrCreateWrapperNode.ms')}`,
        ].join(' '));
    }
}
main().catch(e => { console.error(e); process.exit(1); });
