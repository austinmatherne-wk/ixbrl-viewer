// What are the elements postProcess() classes .ixbrl-no-highlight?  THROWAWAY.
//
//   FIXTURE_ROOT=/path/to/.scratch/startup-slowness \
//     node perf-harness/probe-no-highlight.js <slug> [ablate-arm]
//
// Ticket 07 has to decide whether deleting postProcess()'s warming pass can
// change which elements get classed, and ticket 06 left two candidate
// preconditions - unloaded fonts, and an iframe not yet at its final height.
// Both are answerable by looking at what the classed elements actually are, and
// no table in the sweep shows that.  One page load, so it is cheap to run
// alongside a timing sweep without perturbing it much.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.dirname(__dirname);
const FIXTURE_ROOT = process.env.FIXTURE_ROOT || path.join(REPO, '.scratch', 'startup-slowness');
const BUNDLE = path.join('iXBRLViewerPlugin', 'viewer', 'dist', 'ixbrlviewer.dev.js');
const PORT = Number(process.env.PORT || 8950);
const [SLUG, ARM = 'none'] = process.argv.slice(2);

const NODE_MODULES = [
    path.join(REPO, 'node_modules'),
    path.join(path.dirname(path.dirname(FIXTURE_ROOT)), 'node_modules'),
].find(d => fs.existsSync(path.join(d, 'puppeteer-core')));
const puppeteer = require(path.join(NODE_MODULES, 'puppeteer-core'));

/* Runs in-page. */
function probe() {
    const out = { iframes: [], samples: [], histogram: {} };
    const frames = [...document.querySelectorAll('iframe')];
    for (const f of frames) {
        const r = f.getBoundingClientRect();
        out.iframes.push({
            selected: !!window.jQuery?.(f).data('selected'),
            frameHeight: Math.round(r.height),
            frameWidth: Math.round(r.width),
            inlineHeight: f.style.height,
            docReadyState: f.contentDocument?.readyState,
            fontsStatus: f.contentDocument?.fonts?.status,
            containers: f.contentDocument?.querySelectorAll('.ixbrl-contains-absolute').length ?? 0,
            noHighlight: f.contentDocument?.querySelectorAll('.ixbrl-no-highlight').length ?? 0,
        });
    }
    /* The viewer document's own font set matters too: getComputedStyle is called
     * on the *viewer* window, and a font still loading anywhere is ticket 06's
     * first candidate precondition. */
    out.viewerFonts = document.fonts?.status;
    for (const f of frames) {
        const doc = f.contentDocument;
        if (!doc) {
            continue;
        }
        const all = [...doc.querySelectorAll('.ixbrl-contains-absolute')];
        for (const e of all) {
            const cs = getComputedStyle(e);
            const h = e.getBoundingClientRect().height;
            /* Bucket every container, so "the classed ones are all X" is a claim
             * about the whole population and not about five samples. */
            const key = [
                e.classList.contains('ixbrl-no-highlight') ? 'classed' : 'kept',
                cs.display,
                h === 0 ? 'h=0' : 'h>0',
                cs.position,
            ].join(' | ');
            out.histogram[key] = (out.histogram[key] ?? 0) + 1;
        }
        for (const e of all.filter(e => e.classList.contains('ixbrl-no-highlight')).slice(0, 6)) {
            const cs = getComputedStyle(e);
            out.samples.push({
                tag: e.tagName,
                cls: e.getAttribute('class'),
                inlineStyle: e.getAttribute('style'),
                display: cs.display,
                position: cs.position,
                height: e.getBoundingClientRect().height,
                width: Math.round(e.getBoundingClientRect().width),
                childCount: e.children.length,
                textLen: (e.textContent ?? '').trim().length,
                /* Why it has no box: if every child is out of flow the parent
                 * legitimately collapses, which is not a stale read. */
                childPositions: [...e.children].map(c => getComputedStyle(c).position),
                outerStart: e.outerHTML.slice(0, 240),
                parentTag: e.parentElement?.tagName,
                parentStyle: e.parentElement?.getAttribute('style'),
            });
        }
    }
    return out;
}

async function main() {
    const fx = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, SLUG, 'fixture.json')));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ixv-probe-'));
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
        args: ['--window-size=1440,900'], defaultViewport: { width: 1440, height: 900 },
    });
    const page = await browser.newPage();
    const params = ['ixvperf=phase'];
    if (ARM !== 'none') {
        params.push(`ixvablate=${ARM}`);
    }
    const mb = (fx.source_bytes + (fx.stub_bytes ?? 0)) / 1e6;
    const timeout = Math.min(1_800_000, Math.round(60_000 + mb * 4_000));
    await page.goto(`http://127.0.0.1:${PORT}/${SLUG}/${fx.entry}?${params.join('&')}`,
        { waitUntil: 'load', timeout });
    await page.waitForFunction(() => window.IXVPERF?.done === true, { timeout, polling: 250 });
    console.log(JSON.stringify({ slug: SLUG, arm: ARM, ...await page.evaluate(probe) }, null, 1));
    await browser.close();
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
}
main().catch(e => { console.error(e); process.exit(1); });
