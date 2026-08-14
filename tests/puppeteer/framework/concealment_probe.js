/*
 * Observes htmlHidden()'s ':hidden' filter at the two moments the viewer asks
 * it: while the fact list is being built, and after the post-load drain.
 *
 * The two moments differ by one class.  .ixbrl-no-highlight is written by
 * postProcess(), which runs from viewer.postLoadAsync() after every fact list
 * row already exists, so a filter that excludes that class excludes nothing at
 * the row site and something at the selection site.  .ixbrl-contains-absolute
 * is written during the eager wrapper walk, so it excludes the same nodes at
 * both.  Nothing here reads viewer internals: the wrapper nodes of a fact are
 * recovered from the classes the walk leaves on the document, which is why each
 * case in the fixture is a single fact inside its own host element.
 */
export class ConcealmentProbe {
    #viewerPage;
    #caseIds;

    constructor(viewerPage, caseIds) {
        this.#viewerPage = viewerPage;
        this.#caseIds = caseIds;
    }

    /*
     * Installs the probe so it is present in the next document.  Must be
     * called before navigation: the stacked drain is fast enough that waiting
     * for the report iframe loses the ordering observation.
     */
    async install() {
        this.#viewerPage.log('Installing the concealment probe');
        await this.#viewerPage.page.evaluateOnNewDocument(
            installProbe, this.#caseIds);
    }

    /*
     * The filters as they stood when the first fact list row was appended.
     */
    async atFactListBuild() {
        return await this.#viewerPage.page.evaluate(
            () => window.ixvConcealmentProbe.atFactListBuild);
    }

    async now() {
        return await this.#viewerPage.page.evaluate(
            () => window.ixvConcealmentProbe.snapshot());
    }

    /*
     * performance.now() readings for the first fact list row and the first
     * .ixbrl-no-highlight write, so a test can show which came first rather
     * than assuming it.
     */
    async timings() {
        return await this.#viewerPage.page.evaluate(() => ({
            factListBuiltAt: window.ixvConcealmentProbe.factListBuiltAt,
            noHighlightWrittenAt: window.ixvConcealmentProbe.noHighlightWrittenAt,
        }));
    }
}

/* Runs in the page.  Kept in one function so it can be passed to evaluate(). */
function installProbe(caseIds) {
    const reportDocument = () => {
        const iframe = document.querySelector('iframe[title="iXBRL document view"]');
        return iframe?.contentDocument || iframe?.contentWindow.document;
    };

    /* jQuery's ':hidden', which is what htmlHidden() tests. */
    const hidden = e => !(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    /* util.js' isTransparent(), applied to the same property htmlHidden() reads. */
    const transparent = e => {
        const alpha = parseFloat(getComputedStyle(e).color.split(',')[3]);
        return !isNaN(alpha) && alpha < 0.1;
    };
    const has = (e, className) => e.classList.contains(className);

    const snapshot = () => {
        const doc = reportDocument();
        const cases = {};
        for (const id of caseIds) {
            const nodes = Array.from(doc.getElementById(id)
                .querySelectorAll('.ixbrl-element, .ixbrl-sub-element'));
            const concealed = tested =>
                tested.some(hidden) || nodes.some(transparent);
            cases[id] = {
                classes: nodes.map(e => e.className),
                noHighlight: nodes.filter(e => has(e, 'ixbrl-no-highlight')).length,
                containsAbsolute: nodes.filter(e => has(e, 'ixbrl-contains-absolute')).length,
                hiddenNodes: nodes.filter(hidden).length,
                oldFilter: concealed(nodes.filter(e => !has(e, 'ixbrl-no-highlight'))),
                riderFilter: concealed(nodes.filter(e => !has(e, 'ixbrl-contains-absolute'))),
            };
        }
        return cases;
    };

    const probe = {
        snapshot,
        atFactListBuild: null,
        factListBuiltAt: null,
        noHighlightWrittenAt: null,
    };
    window.ixvConcealmentProbe = probe;

    const captureFactList = () => {
        if (probe.factListBuiltAt === null
            && document.querySelector('#inspector .facts-by-group .fact-list-item')) {
            probe.factListBuiltAt = performance.now();
            probe.atFactListBuild = snapshot();
            return true;
        }
        return false;
    };

    const captureNoHighlight = () => {
        const doc = reportDocument();
        if (probe.noHighlightWrittenAt === null
            && doc?.querySelector('.ixbrl-no-highlight')) {
            probe.noHighlightWrittenAt = performance.now();
            return true;
        }
        return false;
    };

    let viewerRoot = null;
    let viewerObserver = null;
    let reportIframe = null;
    let reportObserver = null;

    const observeReport = () => {
        const root = reportDocument()?.documentElement;
        if (!root) {
            return;
        }
        reportObserver?.disconnect();
        reportObserver = new MutationObserver((records, observer) => {
            if (captureNoHighlight()) {
                observer.disconnect();
            }
        });
        reportObserver.observe(root, { attributeFilter: ['class'], subtree: true });
        captureNoHighlight();
    };

    const observeViewer = () => {
        const root = document.getElementById('ixv');
        if (root && root !== viewerRoot) {
            viewerObserver?.disconnect();
            viewerRoot = root;
            viewerObserver = new MutationObserver((records, observer) => {
                if (captureFactList()) {
                    observer.disconnect();
                }
            });
            viewerObserver.observe(root, { childList: true, subtree: true });
        }
        captureFactList();

        const iframe = document.querySelector('iframe[title="iXBRL document view"]');
        if (iframe && iframe !== reportIframe) {
            reportIframe = iframe;
            iframe.addEventListener('load', observeReport);
            observeReport();
        }
        captureNoHighlight();
    };

    new MutationObserver(observeViewer).observe(
        document, { childList: true, subtree: true });
    observeViewer();
}
