// Which elements does deleting postProcess()'s pass 1 change?  THROWAWAY.
//
//   FIXTURE_ROOT=/path/to/.scratch/startup-slowness \
//     node perf-harness/diff-no-highlight.js <slug> <armA> <armB>
//
// The sweep says drain.viewer.noHighlight moves by +2 on aviva-2025 and +6 on
// fr-esef-both-huge when pass 1 is deleted, reproducibly at both tiers.  A count
// is not a decision: whether that is a defensible behaviour change or a bug
// depends on what those elements are.  This loads one fixture under two arms and
// prints the symmetric difference of the classed sets with their markup.
//
// Element identity is document-order index over the viewer document and every
// report iframe, the same scheme assert-wrapper-identity.js uses, so it is
// comparable across arms exactly as long as the documents are - which the
// containsAbsolute guard says they are.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.dirname(__dirname);
const FIXTURE_ROOT = process.env.FIXTURE_ROOT || path.join(REPO, '.scratch', 'startup-slowness');
const BUNDLE = path.join('iXBRLViewerPlugin', 'viewer', 'dist', 'ixbrlviewer.dev.js');
const PORT = Number(process.env.PORT || 8960);
const [SLUG, ARM_A = 'drainbatched', ARM_B = 'drainbatchednopass1'] = process.argv.slice(2);

const NODE_MODULES = [
    path.join(REPO, 'node_modules'),
    path.join(path.dirname(path.dirname(FIXTURE_ROOT)), 'node_modules'),
].find(d => fs.existsSync(path.join(d, 'puppeteer-core')));
const puppeteer = require(path.join(NODE_MODULES, 'puppeteer-core'));

/* Runs in-page.  Returns every container with its index, so the caller can diff
 * on index and then look up what changed. */
function containers() {
    const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => f.contentDocument)];
    const out = [];
    let next = 0;
    for (const doc of docs) {
        if (doc === null) {
            continue;
        }
        for (const el of doc.getElementsByTagName('*')) {
            const i = next++;
            if (!el.classList.contains('ixbrl-contains-absolute')) {
                continue;
            }
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            out.push({
                i,
                classed: el.classList.contains('ixbrl-no-highlight'),
                id: el.id || null,
                tag: el.tagName,
                display: cs.display,
                position: cs.position,
                /* Read now, long after the drain: if this is non-zero on an
                 * element the arm classed, the arm's read was the early one. */
                heightNow: Math.round(r.height * 100) / 100,
                widthNow: Math.round(r.width * 100) / 100,
                childPositions: [...el.children].map(c => getComputedStyle(c).position).join(','),
                textLen: (el.textContent ?? '').trim().length,
                outer: el.outerHTML.slice(0, 300),
            });
        }
    }
    return out;
}

async function run(browser, url, timeout) {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load', timeout });
    await page.waitForFunction(() => window.IXVPERF?.done === true, { timeout, polling: 250 });
    const r = await page.evaluate(containers);
    await page.close();
    return r;
}

async function main() {
    const fx = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, SLUG, 'fixture.json')));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ixv-diff-'));
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
    const mb = (fx.source_bytes + (fx.stub_bytes ?? 0)) / 1e6;
    const timeout = Math.min(1_800_000, Math.round(60_000 + mb * 4_000));
    const url = (arm) => `http://127.0.0.1:${PORT}/${SLUG}/${fx.entry}?ixvperf=phase`
        + (arm === 'none' ? '' : `&ixvablate=${arm}`);

    const a = await run(browser, url(ARM_A), timeout);
    const b = await run(browser, url(ARM_B), timeout);
    await browser.close();
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });

    const byIndex = (xs) => new Map(xs.map(x => [x.i, x]));
    const A = byIndex(a), B = byIndex(b);
    const sameSet = a.length === b.length && a.every((x, k) => x.i === b[k].i);
    const onlyB = b.filter(x => x.classed && !A.get(x.i)?.classed);
    const onlyA = a.filter(x => x.classed && !B.get(x.i)?.classed);
    console.log(JSON.stringify({
        slug: SLUG,
        armA: ARM_A,
        armB: ARM_B,
        containers: { [ARM_A]: a.length, [ARM_B]: b.length },
        /* If the container sets differ the index scheme is not comparable and the
         * diff below means nothing - so this is asserted, not assumed. */
        containerIndicesIdentical: sameSet,
        classed: { [ARM_A]: a.filter(x => x.classed).length, [ARM_B]: b.filter(x => x.classed).length },
        classedOnlyInB: onlyB,
        classedOnlyInA: onlyA,
    }, null, 1));
}
main().catch(e => { console.error(e); process.exit(1); });
