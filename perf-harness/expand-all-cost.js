// What does the first "Expand all sections" cost once the concealed-fact test is
// deferred to it?  THROWAWAY - startup-remediation ticket 24 only.
//
//   FIXTURE_ROOT=... node perf-harness/expand-all-cost.js [slug ...]
//
// Ticket 24 moves isHTMLHidden() off the startup path and on to the moment a
// row is first shown.  That is a relocation, not a deletion, so the bill has to
// be shown arriving somewhere, and the map's rule is to report it rather than
// hide it.  Every fixture's outline sections are built collapsed and nothing
// expands them during a load, so the whole of a filing's outline-row share lands
// on whoever presses Expand all first.  It is paid once per row lifetime.
//
// Measured, per arm, alternating run by run in one session:
//   clickMs   wall time of the synchronous click handler.  This is what the
//             button press costs the main thread, and on `none` it is the
//             control: that arm paid at startup and owes nothing here.
//   frameMs   click to the second requestAnimationFrame after it.  The click
//             also runs jQuery slideDown()s, so this is the whole interaction,
//             not the tagging alone, and it is carried for the same reason
//             ticket 04 carries frameLag - a change that is fast because it does
//             not paint is not a win.
//   tagMs     inspector.tagConcealedFacts, the rig's own span for the deferred
//             work.  Zero on every arm but rowdefer.
//   rowsShown / tagged  what the pass actually did.
//
// The startup half of the trade is NOT re-derived here - it is the sweep's job.
// This tool answers only "and how much does the user pay later".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const HARNESS_DIR = __dirname;
const REPO = path.resolve(HARNESS_DIR, '..');
const NODE_MODULES = path.join(REPO, 'node_modules');
const BUNDLE = 'iXBRLViewerPlugin/viewer/dist/ixbrlviewer.dev.js';
const FIXTURE_ROOT = process.env.FIXTURE_ROOT
    ?? path.join(REPO, '.scratch/startup-slowness');
const PORT = Number(process.env.PORT ?? 8940);
const RUNS = Number(process.env.RUNS ?? 5);
const ARMS = (process.env.ABLATE_ARMS ?? 'none,rowdefer').split(',');
const OUT = process.env.OUT ?? path.join(HARNESS_DIR, 'out', 'expand-all-cost.json');

/* The perf-profiling-era markup uses classes inside .fact-inspector; master
 * renamed them to ids.  Try both so the tool does not silently measure a click
 * on nothing. */
const EXPAND_SELECTORS = [
    '#inspector .fact-inspector .expand-all-sections',
    '#expand-all-sections',
];

function slugs() {
    if (process.argv.length > 2) {
        return process.argv.slice(2);
    }
    return fs.readdirSync(FIXTURE_ROOT)
        .filter(d => fs.existsSync(path.join(FIXTURE_ROOT, d, 'fixture.json')))
        .sort();
}

function serveRoot(slug) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ixv-expand-'));
    const dir = path.join(root, slug);
    fs.mkdirSync(dir);
    for (const entry of fs.readdirSync(path.join(FIXTURE_ROOT, slug))) {
        if (entry !== 'ixbrlviewer.dev.js') {
            fs.symlinkSync(path.join(FIXTURE_ROOT, slug, entry), path.join(dir, entry));
        }
    }
    fs.symlinkSync(path.join(REPO, BUNDLE), path.join(dir, 'ixbrlviewer.dev.js'));
    return root;
}

function stats(xs) {
    if (xs.length === 0) {
        return null;
    }
    const s = [...xs].sort((a, b) => a - b);
    const median = s[Math.floor(s.length / 2)];
    return {
        median: Math.round(median * 10) / 10,
        min: Math.round(s[0] * 10) / 10,
        max: Math.round(s[s.length - 1] * 10) / 10,
        spread: Math.round((s[s.length - 1] - s[0]) / 2 * 10) / 10,
        n: s.length,
    };
}

async function oneRun(browser, url) {
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
        await page.waitForFunction(() => window.IXVPERF?.done === true,
            { timeout: 600_000, polling: 200 });
        return await page.evaluate((selectors) => {
            const before = {
                tagMs: window.IXVPERF.spans['inspector.tagConcealedFacts']?.ms ?? 0,
                rowsShown: window.IXVPERF.counts['rowDefer.rowsShown'] ?? 0,
                tagged: window.IXVPERF.counts['rowDefer.tagged'] ?? 0,
            };
            let button = null;
            for (const sel of selectors) {
                const e = document.querySelector(sel);
                if (e !== null) {
                    button = e;
                    break;
                }
            }
            if (button === null) {
                return { skipped: 'no expand-all button' };
            }
            const sections = document.querySelectorAll(
                '#inspector .facts-by-group > .collapsible-section').length;
            if (sections === 0) {
                return { skipped: 'no outline sections' };
            }
            const t0 = performance.now();
            button.click();
            const clickMs = performance.now() - t0;
            return new Promise(resolve => {
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    resolve({
                        sections,
                        clickMs,
                        frameMs: performance.now() - t0,
                        tagMs: (window.IXVPERF.spans['inspector.tagConcealedFacts']?.ms ?? 0)
                            - before.tagMs,
                        rowsShown: (window.IXVPERF.counts['rowDefer.rowsShown'] ?? 0)
                            - before.rowsShown,
                        tagged: (window.IXVPERF.counts['rowDefer.tagged'] ?? 0) - before.tagged,
                        rowsExpanded: document.querySelectorAll(
                            '#inspector .facts-by-group .fact-list-item').length,
                        stillPending: document.querySelectorAll(
                            '#inspector .facts-by-group .concealed-tag-pending').length,
                    });
                }));
            });
        }, EXPAND_SELECTORS);
    }
    finally {
        await page.close();
    }
}

async function main() {
    const out = { stamp: new Date().toISOString(), runs: RUNS, arms: ARMS, results: [] };
    const browser = await puppeteer.launch({
        channel: 'chrome',
        headless: process.env.HEADFUL === '1' ? false : 'new',
        args: ['--window-size=1440,900'],
        defaultViewport: { width: 1440, height: 900 },
    });
    out.chrome = await browser.version();
    console.log(`# expand-all cost - ${out.chrome}`);

    for (const slug of slugs()) {
        const fx = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, slug, 'fixture.json')));
        const root = serveRoot(slug);
        const server = spawn(path.join(NODE_MODULES, '.bin', 'http-server'),
            [root, '-p', String(PORT), '-a', '127.0.0.1', '--silent'], { stdio: 'ignore' });
        await new Promise(r => setTimeout(r, 1200));
        const byArm = {};
        for (const arm of ARMS) {
            byArm[arm] = [];
        }
        let skipped = null;
        /* Run index outermost so the arms alternate: a machine drifting mid
         * session drifts both arms equally. */
        for (let run = 0; run < RUNS && skipped === null; run++) {
            for (const arm of ARMS) {
                const url = `http://127.0.0.1:${PORT}/${slug}/${fx.entry}`
                    + `?ixvperf=phase&ixvablate=${arm}`;
                const r = await oneRun(browser, url);
                if (r.skipped) {
                    skipped = r.skipped;
                    break;
                }
                byArm[arm].push(r);
            }
        }
        server.kill();
        fs.rmSync(root, { recursive: true, force: true });

        if (skipped !== null) {
            console.log(`${slug.padEnd(20)} skipped: ${skipped}`);
            out.results.push({ slug, skipped });
            continue;
        }
        const summary = { slug, arms: {} };
        for (const arm of ARMS) {
            const rs = byArm[arm];
            summary.arms[arm] = {
                clickMs: stats(rs.map(r => r.clickMs)),
                frameMs: stats(rs.map(r => r.frameMs)),
                tagMs: stats(rs.map(r => r.tagMs)),
                rowsShown: stats(rs.map(r => r.rowsShown)),
                tagged: stats(rs.map(r => r.tagged)),
                rowsExpanded: stats(rs.map(r => r.rowsExpanded)),
                stillPending: stats(rs.map(r => r.stillPending)),
                sections: rs[0].sections,
            };
        }
        out.results.push(summary);
        const line = ARMS.map(a => {
            const s = summary.arms[a];
            return `${a} click=${s.clickMs.median}±${s.clickMs.spread} `
                + `frame=${s.frameMs.median}±${s.frameMs.spread} tag=${s.tagMs.median} `
                + `rows=${s.rowsExpanded.median} tagged=${s.tagged.median}`;
        }).join('  |  ');
        console.log(`${slug.padEnd(20)} ${line}`);
    }
    await browser.close();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(`\nwrote ${OUT}`);
}

main();
