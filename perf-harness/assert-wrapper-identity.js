// Output-identity assertion for ticket 02's wrapper-loop change.  THROWAWAY.
//
//   ABLATE_ARMS=none,batchedordered \
//     FIXTURE_ROOT=/path/to/.scratch/startup-slowness \
//     node perf-harness/assert-wrapper-identity.js [slug ...]
//
// measure-phases.js proves an arm is fast and that its volume counters match.
// Neither is the same as proving the arm produced the same document, and ticket
// 02's correctness bar is "byte-identical output ... assert it, don't eyeball it".
//
// Two signatures per arm, both taken after IXVPERF.done so the post-load drain's
// own writes are included:
//
//   dom       every element in every report document that carries any of the four
//             classes the wrapper path and the drain apply, in document order, as
//             "<element index>:<sorted class list>".  Catches a class landing on a
//             different element, an element gaining or losing one, and any change
//             in the documents' element counts.
//   wrapper   each fact's wrapperNodes as an ordered list of element indices.
//             This is the one the DOM signature cannot see: the `batched` arm
//             classes exactly the same elements and still hands consumers a
//             differently ordered jQuery set where _wrapNode returned several
//             nodes.  Needs ?ixvexpose=1, which no timing run passes.
//
// Exit status is 1 if any arm's signature differs from the first arm's, so this
// is usable as a gate rather than something to read.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.dirname(__dirname);
const FIXTURE_ROOT = process.env.FIXTURE_ROOT || path.join(REPO, '.scratch', 'startup-slowness');
const BUNDLE = path.join('iXBRLViewerPlugin', 'viewer', 'dist', 'ixbrlviewer.dev.js');
const ARMS = (process.env.ABLATE_ARMS || 'none,batchedordered').split(',');
const PORT = Number(process.env.PORT || 8930);

const NODE_MODULES = [
    path.join(REPO, 'node_modules'),
    path.join(path.dirname(path.dirname(FIXTURE_ROOT)), 'node_modules'),
].find(d => fs.existsSync(path.join(d, 'puppeteer-core')));
const puppeteer = require(path.join(NODE_MODULES, 'puppeteer-core'));

function fixtures() {
    return fs.readdirSync(FIXTURE_ROOT)
        .filter(d => fs.existsSync(path.join(FIXTURE_ROOT, d, 'fixture.json')))
        .map(d => ({ slug: d, ...JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, d, 'fixture.json'))) }))
        .sort((a, b) => a.slug.localeCompare(b.slug));
}

function serveRoot(all) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ixv-ident-'));
    for (const fx of all) {
        const dir = path.join(root, fx.slug);
        fs.mkdirSync(dir);
        for (const entry of fs.readdirSync(path.join(FIXTURE_ROOT, fx.slug))) {
            if (entry !== 'ixbrlviewer.dev.js') {
                fs.symlinkSync(path.join(FIXTURE_ROOT, fx.slug, entry), path.join(dir, entry));
            }
        }
        fs.symlinkSync(path.join(REPO, BUNDLE), path.join(dir, 'ixbrlviewer.dev.js'));
    }
    return root;
}

/*
 * Runs in-page.  Indexes every element of the viewer document and of every report
 * iframe into one document-order sequence, so an element identity is a single
 * integer that both signatures can share and that is stable across arms as long as
 * the documents themselves are.
 */
async function signatures() {
    const CLASSES = ['ixbrl-element', 'ixbrl-sub-element', 'ixbrl-contains-absolute', 'ixbrl-no-highlight'];
    const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => f.contentDocument)];
    const index = new Map();
    const domParts = [];
    let next = 0;
    let elements = 0;
    for (const doc of docs) {
        if (doc === null) {
            continue;
        }
        for (const el of doc.getElementsByTagName('*')) {
            const i = next++;
            index.set(el, i);
            elements++;
            const on = CLASSES.filter(c => el.classList.contains(c));
            if (on.length) {
                domParts.push(`${i}:${on.join(',')}`);
            }
        }
    }
    const map = window.IXVPERF?.ixNodeMap;
    const wrapperParts = [];
    let facts = 0;
    let wrapperNodes = 0;
    /* Sorted so the signature depends on each fact's own node order and not on
     * the insertion order of the map, which is not what is under test. */
    for (const vuid of Object.keys(map ?? {}).sort()) {
        const nodes = map[vuid].wrapperNodes;
        const ids = [];
        /* A jQuery set; .get() avoids depending on jQuery's iteration protocol. */
        for (const el of (nodes?.get?.() ?? [])) {
            ids.push(index.has(el) ? index.get(el) : `detached-${el.tagName}`);
        }
        facts++;
        wrapperNodes += ids.length;
        wrapperParts.push(`${vuid}=${ids.join(',')}`);
    }
    const hash = async (s) => {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
        return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    };
    return {
        docs: docs.length,
        elements,
        classedElements: domParts.length,
        facts,
        wrapperNodes,
        exposed: map !== undefined,
        domHash: await hash(domParts.join('|')),
        wrapperHash: await hash(wrapperParts.join('|')),
        rows: document.querySelectorAll('#inspector .facts-by-group .fact-list-item').length,
        sections: document.querySelectorAll('#inspector .facts-by-group .collapsible-section').length,
    };
}

async function main() {
    const want = process.argv.slice(2);
    let all = fixtures();
    if (want.length) {
        all = all.filter(f => want.includes(f.slug));
    }
    const root = serveRoot(all);
    const server = spawn(path.join(NODE_MODULES, '.bin', 'http-server'),
        [root, '-p', String(PORT), '-a', '127.0.0.1', '--silent'], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 1500));
    const browser = await puppeteer.launch({
        channel: 'chrome', headless: 'new',
        args: ['--window-size=1440,900'], defaultViewport: { width: 1440, height: 900 },
    });

    let failures = 0;
    const report = [];
    for (const fx of all) {
        const mb = (fx.source_bytes + (fx.stub_bytes ?? 0)) / 1e6;
        const timeout = Math.min(1_800_000, Math.round(60_000 + mb * 4_000));
        const byArm = {};
        for (const armName of ARMS) {
            const params = ['ixvperf=phase', 'ixvexpose=1'];
            if (armName !== 'none') {
                params.push(`ixvablate=${armName}`);
            }
            const page = await browser.newPage();
            const url = `http://127.0.0.1:${PORT}/${fx.slug}/${fx.entry}?${params.join('&')}`;
            process.stderr.write(`${fx.slug} ${armName} ... `);
            await page.goto(url, { waitUntil: 'load', timeout });
            await page.waitForFunction(() => window.IXVPERF?.done === true, { timeout, polling: 250 });
            byArm[armName] = await page.evaluate(signatures);
            process.stderr.write(`dom=${byArm[armName].domHash} wrapper=${byArm[armName].wrapperHash}\n`);
            await page.close();
        }
        const base = byArm[ARMS[0]];
        for (const armName of ARMS.slice(1)) {
            const s = byArm[armName];
            const diffs = Object.keys(base).filter(k => JSON.stringify(base[k]) !== JSON.stringify(s[k]));
            if (diffs.length) {
                failures++;
                console.log(`FAIL ${fx.slug} ${ARMS[0]} vs ${armName}: ${diffs.map(
                    k => `${k} ${JSON.stringify(base[k])} != ${JSON.stringify(s[k])}`).join('; ')}`);
            }
            else {
                console.log(`ok   ${fx.slug} ${ARMS[0]} vs ${armName}  `
                    + `elements=${s.elements} classed=${s.classedElements} facts=${s.facts} `
                    + `wrapperNodes=${s.wrapperNodes} rows=${s.rows} sections=${s.sections}`);
            }
        }
        report.push({ slug: fx.slug, arms: byArm });
    }

    await browser.close();
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
    if (process.env.OUT) {
        fs.mkdirSync(path.dirname(process.env.OUT), { recursive: true });
        fs.writeFileSync(process.env.OUT, JSON.stringify({ arms: ARMS, report }, null, 1));
    }
    console.log(failures ? `\n${failures} MISMATCH(ES)` : `\nall ${all.length} fixtures identical across ${ARMS.join(', ')}`);
    process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
