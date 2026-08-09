// Could the descendant scan's getComputedStyle calls be replaced by a
// stylesheet-derived prefilter?  THROWAWAY.
//
//   FIXTURE_ROOT=/path/to/.scratch/startup-slowness \
//     node perf-harness/probe-abs-selectors.js <slug>
//
// Ticket 11 asks whether `position: absolute` is derivable without one
// getComputedStyle per descendant.  The obvious candidate is to enumerate the
// report document's own stylesheets once, collect every selector whose rule sets
// position:absolute, run ONE querySelectorAll for them, and treat the result as
// the candidate set - confirming each candidate with getComputedStyle so the
// cascade still decides.  That is only worth building if two things hold:
//
//   RECALL must be 1.0.  Every element that actually computes to absolute has to
//   be in the candidate set, or the change silently drops sub-elements and stops
//   highlighting them.  Recall < 1 kills the idea outright.
//
//   The candidate set must be much SMALLER than the scan.  The saving is the
//   reads skipped: scanned - candidatesInScan.  If most scanned descendants are
//   candidates anyway the prefilter buys nothing, and ticket 11's own note says
//   more than half of Aviva's scanned descendants really are absolute.
//
// One page load; no timing is taken, so this may run alongside nothing in
// particular and its own getComputedStyle calls do not matter.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.dirname(__dirname);
const FIXTURE_ROOT = process.env.FIXTURE_ROOT || path.join(REPO, '.scratch', 'startup-slowness');
const BUNDLE = path.join('iXBRLViewerPlugin', 'viewer', 'dist', 'ixbrlviewer.dev.js');
const PORT = Number(process.env.PORT || 8960);
const [SLUG] = process.argv.slice(2);

const NODE_MODULES = [
    path.join(REPO, 'node_modules'),
    path.join(path.dirname(path.dirname(FIXTURE_ROOT)), 'node_modules'),
].find(d => fs.existsSync(path.join(d, 'puppeteer-core')));
const puppeteer = require(path.join(NODE_MODULES, 'puppeteer-core'));

/* Runs in-page. */
function probe() {
    const out = { frames: [] };

    /* Walk a sheet's rules, following @media and @supports, and return the
     * selectors of every style rule that sets position.  A conditional group
     * whose condition does not currently match still counts: the prefilter has
     * to be right after a resize or a print, not just now. */
    function collectSelectors(rules, abs, nonAbs, depth, stats) {
        for (const rule of rules) {
            if (rule.cssRules && rule.cssRules.length > 0 && depth < 8) {
                stats.groups++;
                collectSelectors(rule.cssRules, abs, nonAbs, depth + 1, stats);
                continue;
            }
            if (rule.style === undefined || rule.selectorText === undefined) {
                continue;
            }
            stats.styleRules++;
            const pos = rule.style.getPropertyValue('position');
            if (pos === '') {
                continue;
            }
            (pos.trim() === 'absolute' ? abs : nonAbs).push(rule.selectorText);
        }
    }

    for (const f of document.querySelectorAll('iframe')) {
        const doc = f.contentDocument;
        if (!doc) {
            continue;
        }
        const info = {
            sheets: 0, unreadableSheets: 0, styleRules: 0, groups: 0,
            absRules: 0, nonAbsRules: 0, badSelectors: [],
        };
        const absSelectors = [];
        const nonAbsSelectors = [];
        for (const sheet of doc.styleSheets) {
            info.sheets++;
            let rules;
            try {
                rules = sheet.cssRules;
            }
            catch (e) {
                /* Cross-origin sheet: the prefilter cannot see it at all, which
                 * is a recall hole by construction.  Count it rather than
                 * discovering it as a wrong answer later. */
                info.unreadableSheets++;
                continue;
            }
            collectSelectors(rules, absSelectors, nonAbsSelectors, 0, info);
        }
        info.absRules = absSelectors.length;
        info.nonAbsRules = nonAbsSelectors.length;

        /* One querySelectorAll for the union, exactly as the real change would
         * do it.  Selectors are tested individually first so one unsupported
         * selector cannot take the whole query down. */
        const usable = [];
        for (const sel of absSelectors) {
            try {
                doc.querySelector(sel);
                usable.push(sel);
            }
            catch (e) {
                info.badSelectors.push(sel);
            }
        }
        const candidates = new Set();
        if (usable.length > 0) {
            for (const e of doc.querySelectorAll(usable.join(','))) {
                candidates.add(e);
            }
        }
        /* Inline style is the other way an element can be absolute, and it is
         * cheap to add to the candidate set with a second selector. */
        const inlineAbs = new Set();
        for (const e of doc.querySelectorAll('[style]')) {
            if (/position\s*:\s*absolute/i.test(e.getAttribute('style') ?? '')) {
                inlineAbs.add(e);
                candidates.add(e);
            }
        }
        info.candidates = candidates.size;
        info.inlineAbs = inlineAbs.size;

        /* Ground truth over the whole document. */
        const allElements = doc.querySelectorAll('*');
        info.elements = allElements.length;
        const absolute = new Set();
        for (const e of allElements) {
            if (getComputedStyle(e).getPropertyValue('position') === 'absolute') {
                absolute.add(e);
            }
        }
        info.absolute = absolute.size;
        let hit = 0;
        const missSamples = [];
        for (const e of absolute) {
            if (candidates.has(e)) {
                hit++;
            }
            else if (missSamples.length < 5) {
                missSamples.push({
                    tag: e.tagName, cls: e.getAttribute('class'),
                    style: e.getAttribute('style'),
                    outerStart: e.outerHTML.slice(0, 160),
                });
            }
        }
        info.recallHits = hit;
        info.recallMisses = absolute.size - hit;
        info.missSamples = missSamples;
        info.falsePositives = candidates.size - hit;

        /* The scan's own volume, reproduced exactly as _findOrCreateWrapperNode
         * does it: per .ixbrl-element wrapper, every descendant.  Nested facts
         * scan overlapping subtrees and the real loop double-counts them, so
         * this must too or the saving is overstated. */
        let scanned = 0;
        let scannedAbsolute = 0;
        let scannedCandidates = 0;
        /* Nested facts scan overlapping subtrees, so the same descendant is read
         * several times.  The unique count is the floor a memoised scan could
         * reach without changing a single answer - the one narrowing that does
         * not need the highlight design to change. */
        const uniqueScanned = new Set();
        for (const w of doc.querySelectorAll('.ixbrl-element')) {
            for (const sub of w.querySelectorAll('*')) {
                scanned++;
                uniqueScanned.add(sub);
                if (absolute.has(sub)) {
                    scannedAbsolute++;
                }
                if (candidates.has(sub)) {
                    scannedCandidates++;
                }
            }
        }
        info.scanned = scanned;
        info.scannedUnique = uniqueScanned.size;
        info.scannedAbsolute = scannedAbsolute;
        info.scannedCandidates = scannedCandidates;
        info.subElements = doc.querySelectorAll('.ixbrl-sub-element').length;
        info.containers = doc.querySelectorAll('.ixbrl-contains-absolute').length;
        out.frames.push(info);
    }
    return out;
}

async function main() {
    const fx = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, SLUG, 'fixture.json')));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ixv-abssel-'));
    const dir = path.join(root, SLUG);
    fs.mkdirSync(dir);
    for (const entry of fs.readdirSync(path.join(FIXTURE_ROOT, SLUG))) {
        if (entry !== 'ixbrlviewer.dev.js') {
            fs.symlinkSync(path.join(FIXTURE_ROOT, SLUG, entry), path.join(dir, entry));
        }
    }
    fs.symlinkSync(path.join(REPO, BUNDLE), path.join(dir, 'ixbrlviewer.dev.js'));
    const server = spawn(path.join(NODE_MODULES, '.bin', 'http-server'),
        [root, '-p', String(PORT), '-a', '127.0.0.1', '--silent'], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 1500));
    const browser = await puppeteer.launch({
        channel: 'chrome', headless: 'new',
        /* The in-page half resolves style for every element in the document and
         * then replays the whole scan, which on the largest fixtures takes many
         * minutes - well past puppeteer's 180s default for one callFunctionOn. */
        protocolTimeout: 0,
        args: ['--window-size=1440,900'], defaultViewport: { width: 1440, height: 900 },
    });
    const page = await browser.newPage();
    const mb = (fx.source_bytes + (fx.stub_bytes ?? 0)) / 1e6;
    const timeout = Math.min(1_800_000, Math.round(60_000 + mb * 4_000));
    await page.goto(`http://127.0.0.1:${PORT}/${SLUG}/${fx.entry}?ixvperf=phase`,
        { waitUntil: 'load', timeout });
    await page.waitForFunction(() => window.IXVPERF?.done === true, { timeout, polling: 250 });
    console.log(JSON.stringify({ slug: SLUG, ...await page.evaluate(probe) }, null, 1));
    await browser.close();
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
}
main().catch(e => { console.error(e); process.exit(1); });
