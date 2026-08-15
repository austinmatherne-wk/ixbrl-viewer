// Output-identity assertion for ticket 02's wrapper-loop change.  THROWAWAY.
//
//   ABLATE_ARMS=none,batchedordered \
//     FIXTURE_ROOT=/path/to/.scratch/startup-slowness \
//     node perf-harness/assert-wrapper-identity.js [slug ...]
//
//   ALL_ON=1 ABLATE_ARMS=none,none \
//     FIXTURE_ROOT=/path/to/fixtures \
//     node perf-harness/assert-wrapper-identity.js [slug ...]
//
//   ALL_ON=1 MUTANT_HIGHLIGHT=skip ABLATE_ARMS=none,none \
//     FIXTURE_ROOT=/path/to/fixtures \
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
//   classAttr the raw class attribute of each classed element, in attribute
//             order.  Added for ticket 03, whose arm's *only* output is a
//             classList.add: `dom` sorts the four classes into a canonical order
//             and so cannot see a write landing in a different position within
//             an element's own class list.  Ticket 02's lesson was that an
//             ordering control needs its output *order* checked and not just its
//             output, and for this arm the class attribute is that order.
//   continuationItems / continuationOf
//             the two complete maps built by _buildContinuationMaps, with keys
//             sorted but each item's continuation chain left in its produced
//             order.  Added for ticket 14: equal DOM is irrelevant if selector
//             narrowing silently drops a map entry.
//
// INSPECTOR_ROWS=1 adds a fourth, and it is a different kind of signature: all
// three above are taken over the *report* documents, so an arm whose only output
// is inspector DOM passes them no matter what it does.  Ticket 08 found that,
// and ticket 24 is the arm it found it for.
//
//   rows      every fact list row in the inspector, in document order, as its
//             ordered list of tag texts - taken AFTER expanding every outline
//             section and switching to the search pane, because ticket 24's arm
//             defers the concealed-fact tag to exactly those two events and the
//             signature would otherwise differ for the trivial reason that the
//             tags have not been built yet.  Off by default so that the three
//             report signatures other tickets use stay byte-identical runs.
//
// Read the `rows` result with ticket 08 §6 in hand: htmlHiddenTrue is 0 on all
// nine outline-bearing fixtures, so this signature matches because the tag fires
// nowhere, not because the tagging is right.  It can only catch a row that gains
// or loses a tag it should not have; the unit tests are the real verification.
//
// REVIEW=1 loads with ?review=1 so the untagged-numbers walk runs at all, and adds
// a fifth signature.  Ticket 09 §7: the three report signatures are built from the
// four ixbrl-* classes and the wrapperNodes map, so nothing above captures
// review-untagged-number/-date and NOTHING SEES TEXT-NODE STRUCTURE AT ALL.  A
// dropped span would move `elements` and shift every later element index, so that
// much is caught - but ticket 25's arm changes whether a text node is replaced by
// an identical copy of itself, and no signature above can see that.
//
//   review    every element carrying a review-untagged class, as
//             "<element index>:<class>", plus the full text-node shape of every
//             report document as "<parent index>.<child position>:<nodeValue>".
//             The second half is the one that matters: it is taken over node
//             positions and values rather than identities, because the change
//             under test replaces a node with an equal one and a signature over
//             identity would report a difference that is not observable.  Deleting
//             a text node, splitting one, or leaving a tail unappended all move it.
//
// ALL_ON=1 (alias CONFIG=all-on) is the campaign all-on config: the same three
// query params measure-phases.js pushes.  It also takes the review signature
// (review wrapping is on).  The highlight signature is always taken so a none
// run can prove those classes are absent (n=0).  Kept apart from signatures()
// so none-config `dom` / `wrapper` / `continuation*` hashes stay exactly what
// they were.  `dom` filters the four wrapper classes and is blind to
// `ixbrl-highlight*`.  `classAttr` is the raw attribute of those same
// elements, so once highlight-all has run it is a side channel — not a named
// check, and silent for a highlight class that landed off the four-class set.
//
//   highlight every element carrying `ixbrl-highlight` or `ixbrl-highlight-N`
//             (N a digit string), as "<element index>:<sorted highlight classes>".
//             Startup highlight-all writes both: the base class on every
//             `.ixbrl-element`, the numbered class on primary wrappers for a
//             namespace group.  A skipped highlight-all or a renamed class
//             moves this hash.  `MUTANT_HIGHLIGHT=skip` omits
//             `highlight_facts_on_startup` on arms after the first (review and
//             search stay on).  `MUTANT_HIGHLIGHT=rename` loads all-on fully,
//             then rewrites `ixbrl-highlight*` to `ixbrl-hl` on later arms
//             before signing.
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
const ALL_ON = process.env.ALL_ON === '1' || process.env.CONFIG === 'all-on';
const REVIEW = ALL_ON || process.env.REVIEW === '1';
const MUTANT_HIGHLIGHT = process.env.MUTANT_HIGHLIGHT || '';

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
    const classAttrParts = [];
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
                classAttrParts.push(`${i}:${el.getAttribute('class')}`);
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
    const continuations = window.IXVPERF?.continuationMaps ?? {};
    const itemParts = Object.keys(continuations.items ?? {}).sort()
        .map(id => `${id}=${continuations.items[id].join(',')}`);
    const continuationOfParts = Object.keys(continuations.continuationOf ?? {}).sort()
        .map(id => `${id}=${continuations.continuationOf[id]}`);
    return {
        docs: docs.length,
        elements,
        classedElements: domParts.length,
        facts,
        wrapperNodes,
        exposed: map !== undefined,
        domHash: await hash(domParts.join('|')),
        classAttrHash: await hash(classAttrParts.join('|')),
        wrapperHash: await hash(wrapperParts.join('|')),
        continuationItems: itemParts.length,
        continuationLinks: continuationOfParts.length,
        continuationItemsHash: await hash(itemParts.join('|')),
        continuationOfHash: await hash(continuationOfParts.join('|')),
        rows: document.querySelectorAll('#inspector .facts-by-group .fact-list-item').length,
        sections: document.querySelectorAll('#inspector .facts-by-group .collapsible-section').length,
    };
}

/*
 * Runs in-page, after signatures().  The review-mode signature: the classes the
 * untagged walk applies, and the text-node structure it rewrites.  Kept apart from
 * signatures() so the three report signatures other tickets depend on stay exactly
 * what they were.
 *
 * The element index is rebuilt here rather than shared, because this runs as its
 * own page.evaluate and the two walks are identical: document order over the
 * viewer document and every report iframe, same as signatures().
 */
async function reviewSignature() {
    const REVIEW_CLASSES = ['review-untagged-number', 'review-untagged-date'];
    const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => f.contentDocument)];
    const classParts = [];
    const textParts = [];
    let next = 0;
    let reviewSpans = 0;
    let textNodes = 0;
    let textChars = 0;
    for (const doc of docs) {
        if (doc === null) {
            continue;
        }
        const index = new Map();
        for (const el of doc.getElementsByTagName('*')) {
            const i = next++;
            index.set(el, i);
            const on = REVIEW_CLASSES.filter(c => el.classList.contains(c));
            if (on.length) {
                reviewSpans++;
                classParts.push(`${i}:${on.join(',')}`);
            }
            /* Only the element's own text children, so a node's position is
             * relative to a parent whose index is already in the signature.  An
             * empty text node has no visible effect and is exactly what the change
             * under test still deletes, so it is included verbatim. */
            let pos = 0;
            for (const child of el.childNodes) {
                if (child.nodeType === 3) {
                    textNodes++;
                    textChars += child.nodeValue.length;
                    textParts.push(`${i}.${pos}:${child.nodeValue}`);
                }
                pos++;
            }
        }
    }
    const hash = async (s) => {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
        return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    };
    return {
        reviewSpans,
        reviewTextNodes: textNodes,
        reviewTextChars: textChars,
        reviewClassHash: await hash(classParts.join('|')),
        reviewTextHash: await hash(textParts.join(' ')),
    };
}

/*
 * Runs in-page, after signatures().  The all-on highlight signature: the classes
 * highlightAllTags writes onto the report documents.  Kept apart from
 * signatures() so none-config `dom` stays the four wrapper classes.
 *
 * The element index is rebuilt here rather than shared, same reason as
 * reviewSignature(): this is its own page.evaluate and the walk is identical.
 */
async function highlightSignature() {
    const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => f.contentDocument)];
    const classParts = [];
    let next = 0;
    let highlightElements = 0;
    let highlightBase = 0;
    let highlightColored = 0;
    for (const doc of docs) {
        if (doc === null) {
            continue;
        }
        for (const el of doc.getElementsByTagName('*')) {
            const i = next++;
            const on = [...el.classList]
                .filter(c => c === 'ixbrl-highlight' || /^ixbrl-highlight-\d+$/.test(c))
                .sort();
            if (on.length) {
                highlightElements++;
                if (on.includes('ixbrl-highlight')) {
                    highlightBase++;
                }
                highlightColored += on.filter(c => /^ixbrl-highlight-\d+$/.test(c)).length;
                classParts.push(`${i}:${on.join(',')}`);
            }
        }
    }
    const hash = async (s) => {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
        return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    };
    return {
        highlightElements,
        highlightBase,
        highlightColored,
        highlightHash: await hash(classParts.join('|')),
    };
}

function renameHighlightClassesInPage() {
    const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => f.contentDocument)];
    let renamed = 0;
    for (const doc of docs) {
        if (doc === null) {
            continue;
        }
        for (const el of doc.getElementsByTagName('*')) {
            const prev = [...el.classList];
            const next = prev.map(c => {
                if (c === 'ixbrl-highlight' || /^ixbrl-highlight-\d+$/.test(c)) {
                    renamed++;
                    return 'ixbrl-hl';
                }
                return c;
            });
            if (next.some((c, i) => c !== prev[i])) {
                el.className = next.join(' ');
            }
        }
    }
    return renamed;
}

/*
 * Runs in-page, after signatures().  Shows everything a deferred row tag could
 * be waiting on, then signs the rows.  Clicking the real controls rather than
 * calling the inspector directly keeps this a test of what a user's two clicks
 * produce.
 */
async function inspectorRowSignature() {
    const click = (selectors) => {
        for (const sel of selectors) {
            const e = document.querySelector(sel);
            if (e !== null) {
                e.click();
                return sel;
            }
        }
        return null;
    };
    const expanded = click(['#inspector .fact-inspector .expand-all-sections',
        '#expand-all-sections']);
    const searched = click(['#inspector-tabs button[data-mode="search-mode"]',
        '#inspector-tabs [data-mode="search-mode"]']);
    /* One frame, so anything a click scheduled has run before the read. */
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const rows = [...document.querySelectorAll('#inspector .fact-list-item')];
    const parts = rows.map((row, i) => {
        const tags = [...row.querySelectorAll('.block-list-item-tags > div')]
            .map(t => t.textContent);
        return `${i}:${tags.join('/')}`;
    });
    const hash = async (s) => {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
        return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    };
    return {
        expandedVia: expanded,
        searchedVia: searched,
        inspectorRows: rows.length,
        inspectorTags: parts.reduce((n, p) => n + (p.split(':')[1] === '' ? 0 : p.split(':')[1].split('/').length), 0),
        /* Must be 0: a row still marked pending after both clicks is a row the
         * deferral has stranded, which is the failure mode this arm risks. */
        pendingRows: document.querySelectorAll('#inspector .concealed-tag-pending').length,
        rowsHash: await hash(parts.join('|')),
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
        const armKeys = ARMS.map((name, i) => (
            ARMS.filter(a => a === name).length > 1 ? `${i}:${name}` : name
        ));
        for (const [i, armName] of ARMS.entries()) {
            const armKey = armKeys[i];
            const isMutantArm = Boolean(MUTANT_HIGHLIGHT) && i > 0;
            const params = ['ixvperf=phase', 'ixvexpose=1'];
            if (ALL_ON) {
                params.push('review=1', 'search_on_startup=1');
                if (!(isMutantArm && MUTANT_HIGHLIGHT === 'skip')) {
                    params.push('highlight_facts_on_startup=1');
                }
            }
            else if (REVIEW) {
                params.push('review=1');
            }
            if (armName !== 'none') {
                params.push(`ixvablate=${armName}`);
            }
            const page = await browser.newPage();
            const url = `http://127.0.0.1:${PORT}/${fx.slug}/${fx.entry}?${params.join('&')}`;
            process.stderr.write(`${fx.slug} ${armKey} ... `);
            await page.goto(url, { waitUntil: 'load', timeout });
            await page.waitForFunction(() => window.IXVPERF?.done === true, { timeout, polling: 250 });
            if (isMutantArm && MUTANT_HIGHLIGHT === 'rename') {
                await page.evaluate(renameHighlightClassesInPage);
            }
            byArm[armKey] = await page.evaluate(signatures);
            Object.assign(byArm[armKey], await page.evaluate(highlightSignature));
            if (REVIEW) {
                Object.assign(byArm[armKey], await page.evaluate(reviewSignature));
            }
            if (process.env.INSPECTOR_ROWS === '1') {
                Object.assign(byArm[armKey], await page.evaluate(inspectorRowSignature));
            }
            process.stderr.write(`dom=${byArm[armKey].domHash} classAttr=${byArm[armKey].classAttrHash} `
                + `wrapper=${byArm[armKey].wrapperHash} `
                + `continuations=${byArm[armKey].continuationItemsHash}/${byArm[armKey].continuationOfHash}`
                + (byArm[armKey].highlightHash
                    ? ` highlight=${byArm[armKey].highlightHash} n=${byArm[armKey].highlightElements}` : '')
                + (byArm[armKey].reviewTextHash
                    ? ` review=${byArm[armKey].reviewClassHash} text=${byArm[armKey].reviewTextHash}` : '')
                + (byArm[armKey].rowsHash ? ` rows=${byArm[armKey].rowsHash}` : '') + `\n`);
            await page.close();
        }
        const base = byArm[armKeys[0]];
        for (const armKey of armKeys.slice(1)) {
            const s = byArm[armKey];
            const diffs = Object.keys(base).filter(k => JSON.stringify(base[k]) !== JSON.stringify(s[k]));
            if (diffs.length) {
                failures++;
                console.log(`FAIL ${fx.slug} ${armKeys[0]} vs ${armKey}: ${diffs.map(
                    k => `${k} ${JSON.stringify(base[k])} != ${JSON.stringify(s[k])}`).join('; ')}`);
            }
            else {
                console.log(`ok   ${fx.slug} ${armKeys[0]} vs ${armKey}  `
                    + `elements=${s.elements} classed=${s.classedElements} facts=${s.facts} `
                    + `wrapperNodes=${s.wrapperNodes} rows=${s.rows} sections=${s.sections}`
                    + (s.highlightElements !== undefined ? ` highlight=${s.highlightElements}` : ''));
            }
        }
        report.push({ slug: fx.slug, arms: byArm });
    }

    await browser.close();
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
    if (process.env.OUT) {
        fs.mkdirSync(path.dirname(process.env.OUT), { recursive: true });
        fs.writeFileSync(process.env.OUT, JSON.stringify({
            arms: ARMS, allOn: ALL_ON, mutant: MUTANT_HIGHLIGHT || null, report,
        }, null, 1));
    }
    console.log(failures ? `\n${failures} MISMATCH(ES)` : `\nall ${all.length} fixtures identical across ${ARMS.join(', ')}`);
    process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
