// Does the loader's spinner keep spinning while the main thread is blocked?
// THROWAWAY - startup-slowness / startup-remediation investigation only.
//
//   FIXTURE_ROOT=... node perf-harness/spinner-liveness.js [slug]
//
// Ticket 10 argued that liveness during startup is the spinner's job rather than
// the progress text's: inspector.html ships <div class="loader loading"> and
// loader.less animates .loader.loading .text::after with `transform: rotate`,
// `4s steps(64)`, infinite.  A transform animation is normally COMPOSITED, so it
// should keep running on the compositor thread while the main thread is blocked -
// which would make the progress text a statement of which stage is running rather
// than the only sign the viewer has not hung.  Ticket 10 could not verify it and
// recorded it as a provisional; ticket 26 settles it.
//
// It cannot be settled by reading the DOM.  getComputedStyle runs on the main
// thread, so during the very block in question there is nothing there to ask, and
// Page.captureScreenshot needs the renderer to serve a request that is queued
// behind the block.  Page.startScreencast does not: it delivers whatever the
// compositor puts on screen, so frames arriving during a blocked window are
// themselves the evidence, and frames that DIFFER are the animation.
//
// The method, and why each half is needed:
//   - Frames arriving during the block prove the compositor is still producing.
//   - Consecutive frames DIFFERING proves the content is changing.  Chrome resends
//     unchanged frames, so arrival alone is not enough.
//   - Nothing else on screen moves during preProcess - the text is written before
//     the phase starts and the report is static behind the scrim - so a difference
//     is the spinner.
//
// The block window is taken from the instrumented build's own marks, read AFTER
// the load (they are recorded during it and read out at the end), and converted to
// wall clock through performance.timeOrigin so it can be compared with the
// screencast frames' own timestamps.

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
const SLUG = process.argv[2] ?? 'aviva-2025';
const PORT = Number(process.env.PORT ?? 8930);
/* The phase to watch.  preProcess is the multi-second block on aviva-2025 - about
 * 19s at 1x - and is the one the question is actually about. */
const PHASE = process.env.PHASE ?? 'preProcess';

function serveRoot(fx) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ixv-spin-'));
    const dir = path.join(root, fx.slug);
    fs.mkdirSync(dir);
    for (const entry of fs.readdirSync(path.join(FIXTURE_ROOT, fx.slug))) {
        if (entry !== 'ixbrlviewer.dev.js') {
            fs.symlinkSync(path.join(FIXTURE_ROOT, fx.slug, entry), path.join(dir, entry));
        }
    }
    fs.symlinkSync(path.join(REPO, BUNDLE), path.join(dir, 'ixbrlviewer.dev.js'));
    return root;
}

async function main() {
    const fxFile = path.join(FIXTURE_ROOT, SLUG, 'fixture.json');
    if (!fs.existsSync(fxFile)) {
        console.error(`no fixture.json for ${SLUG} under ${FIXTURE_ROOT}`);
        process.exit(1);
    }
    const fx = { slug: SLUG, ...JSON.parse(fs.readFileSync(fxFile)) };
    const root = serveRoot(fx);
    const server = spawn(path.join(NODE_MODULES, '.bin', 'http-server'),
        [root, '-p', String(PORT), '-a', '127.0.0.1', '--silent'], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 1500));

    /* channel: 'chrome' - the same installed Chrome measure-phases.js drives, not
     * puppeteer's bundled download.  The answer is a compositor behaviour, so it
     * has to come from the browser every other number in this map came from. */
    const browser = await puppeteer.launch({
        channel: 'chrome',
        headless: process.env.HEADFUL === '1' ? false : 'new',
        args: ['--window-size=1440,900'],
        defaultViewport: { width: 1440, height: 900 },
    });
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();

    /* Frames, with the wall clock at which each arrived.  metadata.timestamp is
     * seconds since the epoch and is the compositor's own time for the frame, so
     * it is preferred; Date.now() at receipt is kept as a fallback and as a check
     * that nothing is being buffered and delivered late in a burst. */
    const frames = [];
    cdp.on('Page.screencastFrame', async (f) => {
        frames.push({ t: f.metadata.timestamp * 1000, recv: Date.now(), data: f.data });
        try {
            await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId });
        }
        catch (e) { /* page gone */ }
    });

    const url = `http://127.0.0.1:${PORT}/${fx.slug}/${fx.entry}?ixvperf=phase`;
    await cdp.send('Page.startScreencast',
        { format: 'png', everyNthFrame: 1, maxWidth: 640, maxHeight: 450 });
    await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
    await page.waitForFunction(() => window.IXVPERF?.done === true,
        { timeout: 600_000, polling: 200 }).catch(() => console.error('WARN: never drained'));
    await cdp.send('Page.stopScreencast');

    const { marks, origin } = await page.evaluate(() => ({
        marks: window.IXVPERF.marks, origin: performance.timeOrigin }));
    await browser.close();
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });

    const start = marks[`phase.${PHASE}.start`];
    const end = marks[`phase.${PHASE}.end`];
    if (start === undefined || end === undefined) {
        console.error(`no phase.${PHASE} marks on this run`);
        process.exit(1);
    }
    const blockStart = origin + start;
    const blockEnd = origin + end;

    console.log(`# spinner liveness - ${fx.slug}, phase.${PHASE}`);
    console.log(`\nbuild: ${REPO}`);
    console.log(`block: phase.${PHASE} ${Math.round(start)} -> ${Math.round(end)} ms `
        + `since nav start (${((end - start) / 1000).toFixed(1)} s)`);
    console.log(`screencast: ${frames.length} frames over the whole load`);

    const inBlock = frames.filter(f => f.t >= blockStart && f.t <= blockEnd);
    /* Chrome resends unchanged frames, so the count that answers the question is
     * the number of DISTINCT images, not the number of frames. */
    let changes = 0;
    for (let i = 1; i < inBlock.length; i++) {
        if (inBlock[i].data !== inBlock[i - 1].data) {
            changes++;
        }
    }
    const distinct = new Set(inBlock.map(f => f.data)).size;
    console.log(`\n## during the block`);
    console.log(`frames delivered: ${inBlock.length}`);
    console.log(`distinct images:  ${distinct}`);
    console.log(`frame-to-frame changes: ${changes}`);
    if (inBlock.length > 1) {
        const gaps = [];
        for (let i = 1; i < inBlock.length; i++) {
            gaps.push(inBlock[i].t - inBlock[i - 1].t);
        }
        gaps.sort((a, b) => a - b);
        console.log(`inter-frame gap ms: min ${Math.round(gaps[0])} `
            + `median ${Math.round(gaps[Math.floor(gaps.length / 2)])} `
            + `max ${Math.round(gaps[gaps.length - 1])}`);
    }
    console.log(`\n## verdict`);
    if (changes > 1) {
        console.log(`COMPOSITED: the screen changed ${changes} times while the main thread was `
            + `blocked for ${((end - start) / 1000).toFixed(1)} s.  The spinner is animating `
            + `without the main thread.`);
    }
    else if (inBlock.length > 1) {
        console.log(`FROZEN: ${inBlock.length} frames arrived during the block but only `
            + `${distinct} distinct image(s).  The compositor is presenting, but nothing is `
            + `moving - the animation is NOT running independently of the main thread.`);
    }
    else {
        console.log(`INCONCLUSIVE: ${inBlock.length} frame(s) arrived during the block.  `
            + `Nothing was delivered to judge.`);
    }
}

main();
