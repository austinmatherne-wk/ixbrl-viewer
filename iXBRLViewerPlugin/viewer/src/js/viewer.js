// See COPYRIGHT.md for copyright information

import $ from 'jquery'
import { numberMatchSearch } from './number-matcher.js'
import { TableExport } from './tableExport.js'
import { IXNode } from './ixnode.js';
import { getIXHiddenLinkStyle, runGenerator, viewerUniqueId, HIGHLIGHT_COLORS } from './util.js';
import { DocOrderIndex } from './docOrderIndex.js';
import { MessageBox } from './messagebox.js';
import {
    ABLATE, ABLATE_PROGRESS, ABLATE_UNTAGGED, EXPOSE, PERF_DEEP, perfAdd, perfCount, perfDeepAdd,
    perfDeepCount, perfDeepNow, perfMark, perfMarkOnce, perfNow, perfSpan, perfWatchGenerator,
} from './perf.js';

export class DocumentTooLargeError extends Error {}

function localName(e) {
    if (e.indexOf(':') == -1) {
        return e
    }
    else {
        return e.substring(e.indexOf(':') + 1)
    }
}


/* Ticket 11's memo, and it exists only for the `bomemo` arm.  Nested facts scan
 * overlapping subtrees, so the baseline resolves style for the same descendant
 * once per enclosing fact: 178,059 reads over 143,748 distinct nodes on
 * aviva-2025, 247,548 over 73,214 on fr-esef-both-huge.  A WeakMap keyed on the
 * element holds the answer so the repeats cost a lookup instead of a forced
 * style resolution, and holds nothing alive that the document does not. */
const ABS_MEMO = new WeakMap();


export class Viewer {
    constructor(iv, iframes, reportSet) {
        this._iv = iv;
        this._reportSet = reportSet;
        this._iframes = iframes;
        this._contents = iframes.contents();
        this.onSelect = $.Callbacks();
        this.onMouseEnter = $.Callbacks();
        this.onMouseLeave = $.Callbacks();

        this._ixNodeMap = {};
        this.docOrderItemIndex = new DocOrderIndex();
        this._currentDocumentIndex = 0;
        /* Ticket 02's output-identity check needs the wrapperNodes *order* per
         * fact, which no DOM signature can see - two arms can class exactly the
         * same elements and still hand every downstream consumer a differently
         * ordered jQuery set (ixnode.js:44's .first(), for one).  Gated on a URL
         * parameter no timing run sets, so a measured arm never carries this
         * reference and can never have its detached-node estimate skewed by it. */
        if (EXPOSE) {
            (window.IXVPERF ??= {}).ixNodeMap = this._ixNodeMap;
        }
    }

    _checkContinuationCount() {
        const continuationCount = Object.keys(this.continuationOfMap).length
        if (continuationCount > this._iv.options.continuationElementLimit) {
            const contents = $('<div></div>')
                .append($('<p></p>').text(`This document contains a very large number of iXBRL elements (found ${continuationCount} ix:continuation elements).`))
                .append($('<p></p>').text('You may experience performance problems viewing this document, or the viewer may not load at all.'))
                .append($('<p></p>').text('Do you want to continue trying to load this document?'));

            const mb = new MessageBox("Large document warning", contents, "Continue", "Cancel");
            return mb.showAsync().then((result) => {
                if (!result) {
                    throw new DocumentTooLargeError("Too many continuations");
                }
            });
        }
        return Promise.resolve();
    }

    initialize() {
        return new Promise(async (resolve, reject) => {
            const viewer = this;
            perfSpan('viewer.buildContinuationMaps', () => viewer._buildContinuationMaps());
            viewer._checkContinuationCount()
                .catch(err => { throw err })
                .then(() => viewer._iv.setProgress("Pre-processing document"))
                .then(() => {
                    perfMark('phase.preProcess.start');

                    viewer._iframes.each(function (docIndex) {
                        $(this).data("selected", docIndex == viewer._currentDocumentIndex);
                        const reportIndex = $(this).data("report-index");
                        /* One span per document, never per node: _preProcessiXBRL
                         * recurses over every node in the report. */
                        perfSpan('viewer.preProcessiXBRL', () =>
                            viewer._preProcessiXBRL($(this).contents().find("body").get(0), reportIndex, docIndex, false));
                    });

                    perfSpan('viewer.setContinuationMaps', () => viewer._setContinuationMaps());
                    perfMark('phase.preProcess.end');

                    /* Call plugin promise for each document in turn */
                    (async function () {
                        for (const [docIndex, iframe] of viewer._iframes.toArray().entries()) {
                            const body = $(iframe).contents().find("body").get(0);
                            await viewer._iv.pluginPromise('preProcessiXBRL', body, docIndex);
                            if (viewer._iv.isReviewModeEnabled()) {
                                await new Promise((resolve, _) => {
                                    viewer._iv.setProgress("Finding untagged numbers and dates").then(() => {
                                        /* Once per *load*, not once per document.
                                         * These marks used to be last-write-wins
                                         * inside the per-iframe loop, so on a
                                         * multi-document set (clorox-2022) the
                                         * phase described only the final document
                                         * while the spans nested inside it
                                         * accumulated across all of them - 80.0ms
                                         * of phase against 138.4ms of span.  The
                                         * end mark is still last-write-wins, so
                                         * the pair now brackets the whole loop
                                         * and the two agree.  Ticket 12. */
                                        perfMarkOnce('phase.untagged.start');
                                        perfCount('viewer.untagged.docs');
                                        // Temporarily hide all children of "body" to avoid constant
                                        // re-layouts when wrapping untagged numbers
                                        const children = perfSpan('viewer.untagged.hideChildren', () => {
                                            const c = $(body).children(':visible');
                                            c.hide();
                                            return c;
                                        });
                                        $(body).addClass("review");
                                        perfSpan('viewer.wrapUntaggedNumbers', () =>
                                            viewer._wrapUntaggedNumbers($(body), docIndex, false));
                                        perfSpan('viewer.untagged.showChildren', () => children.show());
                                        perfMark('phase.untagged.end');
                                        resolve();
                                    });
                                });
                            }
                        }
                    })()
                        /* Ticket 26's candidate change, as an arm: the only label
                         * whose forced frame costs more than the phase it
                         * announces on every fixture (phase.prepare is 1.7-42.4ms
                         * corpus-wide, max share 1.0%).  The promise chain is kept
                         * intact so nothing downstream moves; only the hop goes.
                         * See ABLATE_PROGRESS in perf.js. */
                        .then(() => (ABLATE_PROGRESS === 'prognoprepare'
                            ? undefined
                            : viewer._iv.setProgress("Preparing document")))
                        .then(() => {
                            perfMark('phase.prepare.start');
                            perfSpan('viewer.setIXNodeMap', () => this._reportSet.setIXNodeMap(this._ixNodeMap));
                            perfSpan('viewer.applyStyles', () => this._applyStyles());
                            perfSpan('viewer.bindHandlers', () => this._bindHandlers());
                            this.scale = 1;
                            perfSpan('viewer.addDocumentSetTabs', () => this._addDocumentSetTabs());
                            perfMark('phase.prepare.end');
                            resolve();
                        });
                })
                .catch(err => reject(err));
        });
    }

    _addDocumentSetTabs() {
        if (this._reportSet.isMultiDocumentViewer()) {
            $('#ixv .ixds-tabs').show();
            for (const [i, doc] of this._reportSet.reportFiles().entries()) {
                $('<button class="tab"></button>')
                    .text(doc.file)
                    .prop('title', doc.file)
                    .data('ix-doc-id', i)
                    .on("click", () => this.selectDocument(i))
                    .appendTo($('#ixv #viewer-pane .ixds-tabs .tab-area'));
            }
            $('#ixv #viewer-pane .ixds-tabs .tab-area .tab').eq(0).addClass("active");
        }
    }

    // Choose or insert a node to use as the "wrapper" for the given ix node.
    // This node will be used for highlighting and selection styling.
    //
    // If, ignoring whitespace-only text nodes, the child only has element
    // children, use those nodes as the wrappers.
    //
    // Otherwise, insert a wrapper node around the element.  If the node or any
    // descendent has display: block, a div is used, otherwise a span.  
    //
    // We want to avoid adding wrapper nodes around inline-block children, as
    // wrapping in block or inline-block can interfere with layout (e.g. some
    // documents have used inline-block to create a multi-column layout).
    //
    // Returns an array of the chosen nodes as DOM nodes.
    //
    _wrapNode(n) {
        if (Array.from(n.childNodes).some(n => n.nodeType === Node.TEXT_NODE && !/^\s*$/.test(n.nodeValue) )) {
            let wrapper = "<span>";
            if (getComputedStyle(n).getPropertyValue("display") === "block") {
                wrapper = '<div>';
            }
            else {
                const nn = n.getElementsByTagName("*");
                let tests = 0;
                for (var i = 0; i < nn.length; i++) {
                    tests++;
                    if (getComputedStyle(nn[i]).getPropertyValue('display') === "block") {
                        wrapper = '<div>';
                        break;
                    }
                }
                /* Emitted once per call: the display test above is a forced style
                 * resolution per descendant, and it only breaks early if it finds a
                 * block. */
                perfDeepCount('wrapNode.displayTests', tests);
            }
            $(n).wrap(wrapper);
            perfDeepCount('wrapNode.wrapped');
            return [n.parentNode];
        }
        else {
            perfDeepCount('wrapNode.reusedChildren');
            return Array.from(n.childNodes).filter(n => n.nodeType === Node.ELEMENT_NODE);
        }
    }


    /*
     * INSTRUMENTED - ticket 12.  The recursion moved into
     * _wrapUntaggedNumbersInner so that this entry point, which runs once per
     * document, can reset an accumulator and emit one perfCount per counter
     * afterwards.  Nothing here calls into perf.js from inside the walk: the
     * counters are plain integers on a local object and the deep-level segment
     * clocks are inlined behind an already-loaded boolean, because this loop is
     * per *node* and a real filing has millions of them.
     */
    _wrapUntaggedNumbers(n, docIndex, ignoreFullMatch) {
        const acc = {
            elementNodes: 0, elementsRecursed: 0, textNodes: 0, textChars: 0,
            matches: 0, keptAsText: 0, wrapped: 0,
            contents: 0, elementTest: 0, match: 0, matchRewrite: 0, rewrite: 0,
        };
        this._wrapUntaggedNumbersInner(n, docIndex, ignoreFullMatch, acc);

        /* Volumes.  The first three are the arm guard: the walk is untouched by
         * every ticket 12 arm and replaceWith preserves text content, so all
         * three must read identical across arms or the delta is not the ablated
         * statement.  See ABLATE in perf.js. */
        perfCount('untagged.elementNodes', acc.elementNodes);
        perfCount('untagged.textNodes', acc.textNodes);
        perfCount('untagged.textChars', acc.textChars);
        perfCount('untagged.elementsRecursed', acc.elementsRecursed);
        perfCount('untagged.matches', acc.matches);
        perfCount('untagged.keptAsText', acc.keptAsText);
        perfCount('untagged.wrapped', acc.wrapped);

        /* The five segments, which tile the walk bar the loop's own overhead. */
        perfDeepAdd('untagged.contents', acc.contents);
        perfDeepAdd('untagged.elementTest', acc.elementTest);
        perfDeepAdd('untagged.match', acc.match);
        perfDeepAdd('untagged.matchRewrite', acc.matchRewrite);
        perfDeepAdd('untagged.rewrite', acc.rewrite);
    }

    _wrapUntaggedNumbersInner(n, docIndex, ignoreFullMatch, acc) {
        const viewer = this;
        const ixHiddenStyleRE = /(?:^|\s|;)-(?:sec|esef)-ix-hidden:\s*([^\s;]+)/;
        /* Hoisted so the per-node clocks below are a test of an already-loaded
         * boolean rather than a call into perf.js. */
        const deep = PERF_DEEP;
        const arm = ABLATE_UNTAGGED;

        let t = deep ? performance.now() : 0;
        const contents = n.contents();
        if (deep) {
            acc.contents += performance.now() - t;
        }

        contents.each(function () {
            if (this.nodeType === Node.ELEMENT_NODE) {
                acc.elementNodes++;
                t = deep ? performance.now() : 0;
                const name = localName(this.nodeName.toUpperCase());
                /*
                 * Content in text tags should not be considered tagged, so carry
                 * on searching if it's not:
                 *
                 *  1. nonFraction (a tagged number)
                 *  2. nonNumerics with a format (mostly dates, not a text block)
                 *  3. an element with a -sec-ix-hidden style.  This shouldn't be
                 *     used on a text block, so we assume it's a more specific tag.
                 *
                 *  When we continue searching, if the element is a nonNumeric tag
                 *  and it's entire contents match the number matcher, we consider
                 *  that tagged.
                 *
                 */
                const recurse = !(
                        name === 'NONFRACTION' ||
                        (name === 'NONNUMERIC' && this.getAttribute('format') !== null) ||
                        (this.hasAttribute('style') && this.getAttribute('style').match(ixHiddenStyleRE))
                );
                if (deep) {
                    acc.elementTest += performance.now() - t;
                }
                if (recurse) {
                    acc.elementsRecursed++;
                    viewer._wrapUntaggedNumbersInner($(this), docIndex, name === 'NONNUMERIC', acc);
                }
            }
            else if (this.nodeType === Node.TEXT_NODE) {
                acc.textNodes++;
                const input = this.nodeValue;
                acc.textChars += input.length;
                /* Arms are named explicitly, never reached by a bare else - an
                 * arm belonging to another code path must leave this walk
                 * byte-identical to master.  See ABLATE in perf.js. */
                if (arm === 'untaggedwalkonly') {
                    return;
                }
                const rewrite = arm !== 'untaggednorewrite';
                t = deep ? performance.now() : 0;
                const output = rewrite ? $("<div></div>") : null;
                if (deep) {
                    acc.rewrite += performance.now() - t;
                }
                let pos = 0;
                if (arm !== 'untaggednomatch') {
                    /* The callback's own time is subtracted from the matcher's, so
                     * `match` is the regex and `matchRewrite` is the span building
                     * its matches drive. */
                    let cb = 0;
                    const tm = deep ? performance.now() : 0;
                    numberMatchSearch(input, function (m, do_not_want, is_date) {
                        const tc = deep ? performance.now() : 0;
                        acc.matches++;
                        if (rewrite && m.index > pos) {
                            output.append(document.createTextNode(input.substring(pos, m.index)));
                        }
                        // If "ignoreFullMatch" is specified, we ignore a match which
                        // covers the whole of n's text content.
                        if (do_not_want ||
                                (ignoreFullMatch && m.index === 0 && m.index + m[0].length === input.length && input === n.text())) {
                            acc.keptAsText++;
                            if (rewrite) {
                                output.append(document.createTextNode(m[0]));
                            }
                        }
                        else {
                            acc.wrapped++;
                            if (rewrite) {
                                const c = is_date ? 'review-untagged-date' : 'review-untagged-number';
                                $('<span></span>')
                                        .text(m[0])
                                        .addClass(c)
                                        .appendTo(output);
                            }
                        }
                        pos = m.index + m[0].length;
                        if (deep) {
                            cb += performance.now() - tc;
                        }
                    });
                    if (deep) {
                        acc.match += performance.now() - tm - cb;
                        acc.matchRewrite += cb;
                    }
                }
                if (rewrite) {
                    t = deep ? performance.now() : 0;
                    if (pos < input.length) {
                        output.append(document.createTextNode(input.substring(pos, input.length)));
                    }
                    $(this).replaceWith(output.contents());
                    if (deep) {
                        acc.rewrite += performance.now() - t;
                    }
                }
            }
        });
    }

    /*
     * Select the document within the current document set identified docIndex, and
     * if specified, the element identified by fragment (via id or a.name
     * attribute)
     */
    _showDocumentAndElement(docIndex, fragment) {
        this.selectDocument(docIndex); 
        if (fragment !== undefined && fragment != "") {
            // As per HTML spec, try fragment, then try %-decoded fragment
            // https://html.spec.whatwg.org/multipage/browsing-the-web.html#the-indicated-part-of-the-document
            for (const fragment_option of [fragment, decodeURIComponent(fragment)]) {
                const f = $.escapeSelector(fragment_option);
                const ee = this._iframes.eq(docIndex).contents().find('#' + f + ', a[name="' + f + '"]');
                if (ee.length > 0) {
                    this.showElement(ee.eq(0));
                    return
                }
            }
        }
    }

    /*
     * Rewrite hyperlinks in the iXBRL.
     *
     * Relative links to other files in the same document set are handled by
     * JavaScript to switch tabs within the viewer
     *
     * All other links are forced to open in a new tab
     *
     */
    _updateLink(n) {
        const url = $(n).attr("href");
        if (url !== undefined) {
            const [file, fragment] = url.split('#', 2);
            const docIndex = this._reportSet.reportFiles().indexOf(file);
            if (!url.includes('/') && docIndex != -1) {
                $(n).on("click", (e) => { 
                    this._showDocumentAndElement(docIndex, fragment);
                    e.preventDefault(); 
                });
            }
            else if (file) {
                // Open target in a new browser tab.  Without this, links will
                // replace the contents of the current iframe in the viewer, which
                // leaves the viewer in a confusing state.
                $(n).attr("target", "_blank");
            }
        }
    }

    /*
     * INSTRUMENTATION (ticket 03).  A single CPU profile put 22.4s of 25.3s of
     * total self time here, but could not say which statement spends it, because
     * V8 folds frameless native calls into the caller's self time.  So the total
     * is accumulated here - once per fact, never per node - and the body is split
     * into three timed segments at ?ixvperf=deep.  The wrapper is a separate
     * function purely so the measured body stays byte-identical to master, which
     * ticket 05's ablation runs depend on.
     */
    _findOrCreateWrapperNode(domNode, inHidden) {
        const fcwnStart = performance.now();
        try {
            return this._findOrCreateWrapperNodeInner(domNode, inHidden);
        }
        finally {
            perfAdd('viewer.findOrCreateWrapperNode', performance.now() - fcwnStart);
        }
    }

    _findOrCreateWrapperNodeInner(domNode, inHidden) {
        const v = this;

        if (inHidden) {
            perfDeepCount('fcwn.inHidden');
            return $(domNode).addClass("ixbrl-element-hidden");
        }
        perfDeepCount('fcwn.visible');

        /* Is the element the only significant content within a <td> or <th> ? If
         * so, use that as the wrapper element.
         * Check for 'display: table-cell' to avoid using hidden cells */
        const cellTestStart = perfDeepNow();
        const tableNode = domNode.closest("td,th");
        let nodes;
        const innerText = $(domNode).text();
        if (PERF_DEEP) {
            perfCount('fcwn.innerTextChars', innerText.length);
            /* A non-null tableNode is exactly the condition under which the
             * getComputedStyle below runs, so this is the forced style resolution
             * count for this segment. */
            if (tableNode !== null) {
                perfCount('fcwn.cellCandidates');
            }
        }
        if (tableNode !== null && getComputedStyle(tableNode).display === 'table-cell' && innerText.length > 0) {
            // Use indexOf rather than a single regex because innerText may
            // be too long for the regex engine
            const outerText = $(tableNode).text();
            perfDeepCount('fcwn.cellTextChars', outerText.length);
            const start = outerText.indexOf(innerText);
            const wrapper = outerText.substring(0, start) + outerText.substring(start + innerText.length);
            if (!/[0-9A-Za-z]/.test(wrapper)) {
                nodes = [ tableNode ];
                perfDeepCount('fcwn.cellWrapperUsed');
            }
        }
        perfDeepAdd('fcwn.cellTest', perfDeepNow() - cellTestStart);
        /* Otherwise, insert a <span> or <div> as wrapper */
        if (nodes === undefined) {
            const wrapStart = perfDeepNow();
            nodes = this._wrapNode(domNode);
            perfDeepAdd('fcwn.wrapNode', perfDeepNow() - wrapStart);
            perfDeepCount('fcwn.wrapNodeCalls');
        }
        const scanStart = perfDeepNow();
        const allNodes = [];
        let scanned = 0;
        let absolute = 0;
        /* Only the bomemo arm moves this: every other arm resolves style once
         * per scanned descendant, so its read count is fcwn.subNodesScanned. */
        let styleReads = 0;
        /* The ablation arm is tested once per fact, never per node, so the
         * unablated loop below stays byte-identical to master.  See ABLATE in
         * perf.js for what each arm removes; all of them CHANGE BEHAVIOUR.
         *
         * Every arm that is not one of *this* hot path's own runs the baseline
         * loop.  It must be spelled out: ticket 06 added arms on the fact-list row
         * path, and while the chain below ended in a bare `else` meaning noscan,
         * those arms silently ablated this scan as well - which took 19s off Aviva
         * and very nearly passed for a finding. */
        if (!['noscan', 'nostyle', 'styleonly', 'batched', 'batchedordered', 'bomemo'].includes(ABLATE)) {
            for (const node of nodes) {
                let hasSubNodes = false;
                allNodes.push(node);
                node.classList.add("ixbrl-element");
                for (const subNode of node.querySelectorAll("*")) {
                    /* Local integers only - this loop runs tens of thousands of times
                     * per document on the corpus's larger filings. */
                    scanned++;
                    if (getComputedStyle(subNode).getPropertyValue('position') === "absolute") {
                        subNode.classList.add("ixbrl-sub-element");
                        allNodes.push(subNode);
                        hasSubNodes = true;
                        absolute++;
                    }
                }
                if (hasSubNodes) {
                    node.classList.add("ixbrl-contains-absolute");
                }
            }
        }
        else if (ABLATE === 'styleonly') {
            /* Resolve style exactly as the baseline does, then throw the answer
             * away: same querySelectorAll, same getComputedStyle, same property
             * read and string compare, but nothing is classed or collected.  So
             * against nostyle this isolates forced style resolution, and against
             * the baseline it prices what the collected sub-elements cost the
             * rest of the load. */
            for (const node of nodes) {
                allNodes.push(node);
                node.classList.add("ixbrl-element");
                for (const subNode of node.querySelectorAll("*")) {
                    scanned++;
                    if (getComputedStyle(subNode).getPropertyValue('position') === "absolute") {
                        absolute++;
                    }
                }
            }
        }
        else if (ABLATE === 'batched') {
            /* Not an ablation but an ordering control, and the one arm that
             * distinguishes "this many getComputedStyle calls is inherently
             * expensive" from "these calls are expensive because a class is
             * written between them".  Every read and every write the baseline
             * performs still happens and allNodes ends up identical - only the
             * interleaving is gone: all style is resolved first, then the classes
             * are applied.  Sound only because no rule keyed on .ixbrl-element or
             * .ixbrl-sub-element affects 'position' (the position: absolute rules
             * in viewer.less all key on div.ixbrl-table-handle), so hoisting the
             * writes past the reads cannot change a single answer.
             *
             * One residual difference, which is why this stays a diagnostic and
             * not a proposed fix: where _wrapNode returns several nodes, allNodes
             * comes out grouped rather than interleaved.  Same members, different
             * order.  For the single-node case - which is every call whose wrapper
             * is one span, div or table cell - the order is identical too. */
            const subLists = [];
            for (const node of nodes) {
                allNodes.push(node);
                subLists.push(node.querySelectorAll("*"));
            }
            const absoluteNodes = [];
            const containers = [];
            for (let i = 0; i < nodes.length; i++) {
                let hasSubNodes = false;
                for (const subNode of subLists[i]) {
                    scanned++;
                    if (getComputedStyle(subNode).getPropertyValue('position') === "absolute") {
                        absoluteNodes.push(subNode);
                        hasSubNodes = true;
                        absolute++;
                    }
                }
                if (hasSubNodes) {
                    containers.push(nodes[i]);
                }
            }
            for (const node of nodes) {
                node.classList.add("ixbrl-element");
            }
            for (const subNode of absoluteNodes) {
                subNode.classList.add("ixbrl-sub-element");
                allNodes.push(subNode);
            }
            for (const node of containers) {
                node.classList.add("ixbrl-contains-absolute");
            }
        }
        else if (ABLATE === 'batchedordered') {
            /* Ticket 02's *proposed fix*, and the only arm here that is a merge
             * candidate rather than a diagnostic.  It costs what `batched` costs -
             * all style is resolved before any class is written - but it also
             * preserves the baseline's allNodes ORDER, which `batched` does not:
             * where _wrapNode returns several nodes, batched groups every
             * sub-element after every wrapper while the baseline interleaves them
             * per wrapper.  Same members, different order, and that difference is
             * the one thing standing between the ordering control and a shippable
             * change - so this arm carries the per-node sub-lists that let the
             * write pass rebuild the baseline's exact sequence.
             *
             * Sound for the same reason `batched` is: no rule in viewer.less keyed
             * on .ixbrl-element, .ixbrl-sub-element or .ixbrl-contains-absolute
             * touches 'position' (the only position: absolute there is
             * div.ixbrl-table-handle), so hoisting the writes past the reads cannot
             * change a single answer. */
            const subNodeLists = [];
            for (const node of nodes) {
                const absoluteSubNodes = [];
                for (const subNode of node.querySelectorAll("*")) {
                    scanned++;
                    if (getComputedStyle(subNode).getPropertyValue('position') === "absolute") {
                        absoluteSubNodes.push(subNode);
                        absolute++;
                    }
                }
                subNodeLists.push(absoluteSubNodes);
            }
            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
                const absoluteSubNodes = subNodeLists[i];
                allNodes.push(node);
                node.classList.add("ixbrl-element");
                for (const subNode of absoluteSubNodes) {
                    subNode.classList.add("ixbrl-sub-element");
                    allNodes.push(subNode);
                }
                if (absoluteSubNodes.length > 0) {
                    node.classList.add("ixbrl-contains-absolute");
                }
            }
        }
        else if (ABLATE === 'bomemo') {
            /* Ticket 11's candidate change: batchedordered, plus a memo so a
             * descendant's position is resolved once per document rather than
             * once per enclosing fact.  Everything else - the walk, the classes,
             * the collection, allNodes' order - is batchedordered's, so a paired
             * comparison against that arm isolates the repeated reads and
             * nothing else.
             *
             * Sound for the same reason batchedordered is, plus one more:
             * _preProcessiXBRL is depth-first, so a nested fact is scanned
             * before its ancestor and the memo is always written before it is
             * read.  What could still make a memoised answer stale is a WRITE
             * between the two reads that changes the descendant's computed
             * position - and the only writes the walk performs are the four
             * ixbrl-* classes, none of which any rule keyed on them gives a
             * position (viewer.less's only position:absolute is
             * div.ixbrl-table-handle), and _wrapNode's inserted wrapper, which
             * changes the tree a child-combinator selector could match on.
             * That last one is a real hazard and is not argued away here:
             * assert-wrapper-identity.js is the gate, and it sees exactly this
             * (a differing .ixbrl-sub-element set moves both the dom and
             * classAttr signatures). */
            const subNodeLists = [];
            for (const node of nodes) {
                const absoluteSubNodes = [];
                for (const subNode of node.querySelectorAll("*")) {
                    scanned++;
                    let isAbsolute = ABS_MEMO.get(subNode);
                    if (isAbsolute === undefined) {
                        isAbsolute = getComputedStyle(subNode).getPropertyValue('position') === "absolute";
                        ABS_MEMO.set(subNode, isAbsolute);
                        styleReads++;
                    }
                    if (isAbsolute) {
                        absoluteSubNodes.push(subNode);
                        absolute++;
                    }
                }
                subNodeLists.push(absoluteSubNodes);
            }
            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
                const absoluteSubNodes = subNodeLists[i];
                allNodes.push(node);
                node.classList.add("ixbrl-element");
                for (const subNode of absoluteSubNodes) {
                    subNode.classList.add("ixbrl-sub-element");
                    allNodes.push(subNode);
                }
                if (absoluteSubNodes.length > 0) {
                    node.classList.add("ixbrl-contains-absolute");
                }
            }
        }
        else if (ABLATE === 'nostyle') {
            /* Walk every descendant, resolve no style. */
            for (const node of nodes) {
                allNodes.push(node);
                node.classList.add("ixbrl-element");
                for (const subNode of node.querySelectorAll("*")) {
                    scanned++;
                }
            }
        }
        else {
            /* noscan, and only noscan: the descendant scan does not happen at all.
             * Named explicitly in the test above, so a typo or another path's arm
             * lands on the baseline rather than here. */
            for (const node of nodes) {
                allNodes.push(node);
                node.classList.add("ixbrl-element");
            }
        }
        if (PERF_DEEP) {
            perfAdd('fcwn.subNodeScan', perfDeepNow() - scanStart);
            /* One getComputedStyle per scanned descendant: the count that makes
             * forced style resolution a candidate cost centre in its own right. */
            perfCount('fcwn.subNodesScanned', scanned);
            perfCount('fcwn.absoluteSubNodes', absolute);
            /* Ticket 11's mechanism counter.  Zero on every arm but bomemo, where
             * it is the read count the memo actually achieved - so bomemo is the
             * change it claims to be only if this lands well under
             * fcwn.subNodesScanned while fcwn.absoluteSubNodes stays identical. */
            perfCount('fcwn.styleReads', styleReads);
        }
        return $(allNodes);
    }


    // Adds the specified ID to the "ivids" data list on the given node
    _addIdToNodes(nodes, id) {
        nodes.filter(".ixbrl-element").each((i, e) => {
            const ivids = $(e).data('ivids') || [];
            if (!ivids.includes(id)) {
                ivids.push(id);
            }
            $(e).data('ivids', ivids);
        });
    }

    _buildContinuationMaps() {
        // map of element id to next element id in continuation chain
        const nextContinuationMap = {};
        // map of items in default target document to all their continuations
        const itemContinuationMap = {};
        /* find("body *") materialises every element of the report - 203MB on the
         * largest corpus fixture - before any phase mark exists on master.  Counted
         * with a captured local, emitted once. */
        let walked = 0;
        this._iframes.each((n, iframe) => {
            const reportIndex = $(iframe).data("report-index");
            $(iframe).contents().find("body *").each((m, node) => {
                walked++;
                const name = localName(node.nodeName).toUpperCase();
                if (['NONNUMERIC', 'NONFRACTION', 'FOOTNOTE', 'CONTINUATION'].includes(name) && node.hasAttribute('id')) {
                    const nodeId = viewerUniqueId(reportIndex, node.getAttribute('id'));
                    const continuedAtId = viewerUniqueId(reportIndex, node.getAttribute("continuedAt"));
                    if (continuedAtId !== null) {
                        nextContinuationMap[nodeId] = continuedAtId;
                    }
                    if (name != 'CONTINUATION') {
                        itemContinuationMap[nodeId] = [];
                    }
                }
            });
        });

        perfCount('continuationMaps.elementsWalked', walked);

        // Map of continuation IDs to list of (default target doc) items that
        // they're continuations of
        this.continuationOfMap = {};
        for (const [itemId, itemContinuations] of Object.entries(itemContinuationMap)) {
            var id = itemId;
            while (nextContinuationMap[id] !== undefined) {
                id = nextContinuationMap[id];
                itemContinuations.push(id);
                if (this.continuationOfMap[id] !== undefined) {
                    console.log("Continuation '" + id + "' is a continuation of multiple items.");
                }
                this.continuationOfMap[id] = itemId;
            }
        }
        this.itemContinuationMap = itemContinuationMap;
    }

    _setContinuationMaps() {
        for (const [itemId, itemContinuations] of Object.entries(this.itemContinuationMap)) {
            this._ixNodeMap[itemId].continuations = itemContinuations.map(id => this._ixNodeMap[id]);
        }
    }

    _getOrCreateIXNode(vuid, nodes, docIndex, isHidden) {
        // We may have already created an IXNode for this ID from a -sec-ix-hidden
        // element 
        let ixn = this._ixNodeMap[vuid];
        if (!ixn) {
            ixn = new IXNode(vuid, nodes, docIndex);
            this._ixNodeMap[vuid] = ixn;
            ixn.isHidden = isHidden;
        }
        return ixn;
    }

    //
    // Traverse the DOM hierarchy to find IX elements, and build maps and add
    // wrapper nodes and classes.
    //
    // Primary classes, one of:
    //   .ixbrl-element        a wrapper for any ix: fact, footnote, or continuation
    //   .ixbrl-sub-element    an absolutely positioned element within an
    //                         ixbrl-element.  These require separate highlighting.
    //   .ixbrl-element-hidden an ix: element inside ix:hidden
    //
    // Additional classes:
    //   .ixbrl-no-highlight   a zero-height .ixbrl-element - no highlighting or 
    //                         borders applied
    //   .ixbrl-element-nonfraction,
    //   .ixbrl-element-nonnumeric,
    //   .ixbrl-continuation, 
    //   .ixbrl-element-footnote       
    //                         Indicates type of element being wrapped
    //
    // All ixbrl-elements have "ivids" data added, which is a list of the ID
    // attribute(s) of corresponding IX item(s).  Continuations have the IDs of
    // their head items (fact or footnotes).
    // "ivids" can be a mix of different types.
    //
    // Viewer._ixNodeMap is a map of these IDs to IXNode objects.
    //
    // Viewer.docOrderItemIndex is a DocOrderIndex object that maintains a list of
    // fact and footnotes in document order.
    //
    _preProcessiXBRL(n, reportIndex, docIndex, inHidden) {
        const name = localName(n.nodeName).toUpperCase();
        const isFootnote = name === 'FOOTNOTE';
        const isContinuation = name === 'CONTINUATION';
        const isNonNumeric = name === 'NONNUMERIC';
        const isNonFraction = name === 'NONFRACTION';
        const isFact = isNonNumeric || isNonFraction;

        if (n.nodeType === Node.ELEMENT_NODE && name == 'HIDDEN') {
            inHidden = true;
        }
        // Depth-first so we can re-use child wrapper nodes
        this._preProcessChildNodes(n, reportIndex, docIndex, inHidden);

        if (n.nodeType === Node.ELEMENT_NODE) {
            const vuid = viewerUniqueId(reportIndex, n.getAttribute("id"));
            if (isFact || isFootnote) {
                // If @id is not present, it must be for a target document that wasn't processed.
                if (n.hasAttribute("id")) {
                    let nodes = this._findOrCreateWrapperNode(n, inHidden);

                    this._addIdToNodes(nodes, vuid);
                    let ixn = this._getOrCreateIXNode(vuid, nodes, docIndex, inHidden);
                    this.docOrderItemIndex.addItem(vuid, docIndex);

                    if (isNonFraction) {
                        nodes.addClass("ixbrl-element-nonfraction");
                        if (n.hasAttribute('scale')) {
                            const scale = Number(n.getAttribute('scale'));
                            // Set scale if the value is a valid number and is not a redundant 0/"ones" scale.
                            if (!Number.isNaN(scale) && scale !== 0) {
                                ixn.scale = scale;
                            }
                        }
                    }
                    if (isNonNumeric) {
                        nodes.addClass("ixbrl-element-nonnumeric");
                        if (n.hasAttribute('escape') && n.getAttribute('escape').match(/^(true|1)$/)) {
                            ixn.escaped = true;
                        }
                    }
                    if (isFootnote) {
                        nodes.addClass("ixbrl-element-footnote");
                        ixn.footnote = true;
                    }
                }
            }
            else if (isContinuation) {
                if (n.hasAttribute("id") && this.continuationOfMap[vuid] !== undefined) {
                    let nodes = this._findOrCreateWrapperNode(n, inHidden);

                    // For a continuation, store the IX ID(s) of the item(s), not the continuation
                    this._addIdToNodes(nodes, this.continuationOfMap[vuid]);

                    this._getOrCreateIXNode(vuid, nodes, docIndex, inHidden);

                    nodes.addClass("ixbrl-continuation");
                }
            }
            else {
                // Handle SEC/ESEF links-to-hidden
                const vuid = viewerUniqueId(reportIndex, getIXHiddenLinkStyle(n));
                if (vuid !== null) {
                    let nodes = this._findOrCreateWrapperNode(n, inHidden);
                    nodes.addClass("ixbrl-element").data('ivids', [vuid]);
                    this.docOrderItemIndex.addItem(vuid, docIndex);
                    /* We may have already seen the corresponding ix element in the hidden
                     * section */
                    const ixn = this._ixNodeMap[vuid];
                    if (ixn) {
                        /* ... if so, update the node and docIndex so we can navigate to it */
                        ixn.wrapperNodes = nodes;
                        ixn.docIndex = docIndex;
                    }
                    else {
                        this._ixNodeMap[vuid] = new IXNode(vuid, nodes, docIndex);
                    }
                }
                if (name == 'A') {
                    this._updateLink(n);
                }
            }
        }
    }

    _preProcessChildNodes(domNode, reportIndex, docIndex, inHidden) {
        for (const childNode of domNode.childNodes) {
            this._preProcessiXBRL(childNode, reportIndex, docIndex, inHidden);
        }
    }

    _applyStyles() {
        const stlyeElts = $("<style>")
            .prop("type", "text/css")
            .text(require('../less/viewer.less').toString())
            .appendTo(this._iframes.contents().find("head"));
        this._iv.callPluginMethod("updateViewerStyleElements", stlyeElts);
    }

    contents() {
        return this._iframes.contents();
    }

    // Move by offset (+1 or -1) through the tags in the document in document
    // order.
    //
    // Each element may have one or more tags associated with it, so we need to
    // move through the list of tags associated with the current element before
    // moving to the next/prev element
    //
    _selectAdjacentTag(offset, currentItem) {
        var nextVuid;
        if (currentItem !== null) {
            nextVuid = this.docOrderItemIndex.getAdjacentItem(currentItem.vuid, offset);
            this.showDocumentForItemId(nextVuid);
        }
        // If no fact selected go to the first or last in the current document
        else if (offset > 0) {
            nextVuid = this.docOrderItemIndex.getFirstInDocument(this._currentDocumentIndex);
        } 
        else {
            nextVuid = this.docOrderItemIndex.getLastInDocument(this._currentDocumentIndex);
        }
        
        const nextElement = this.elementsForItemId(nextVuid);
        this.showElement(nextElement);
        // If this is a table cell with multiple nested tags pass all tags so that
        // all are shown in the inspector. 
        this.selectElement(nextVuid, this._ixIdsForElement(nextElement));
    }

    _bindHandlers() {
        const viewer = this;
        $('.ixbrl-element', this._contents)
            .on("click", function (e) {
                e.stopPropagation();
                viewer.selectElementByClick($(this));
            })
            .on("mouseenter", function (e) { viewer._mouseEnter($(this)) })
            .on("mouseleave", function (e) { viewer._mouseLeave($(this)) });
        $("body", this._contents)
            .on("click", () => viewer.selectElement(null));
        
        TableExport.addHandles(this._contents, this._reportSet);
    }

    selectNextTag(currentFact) {
        this._selectAdjacentTag(1, currentFact);
    }

    selectPrevTag(currentFact) {
        this._selectAdjacentTag(-1, currentFact);
    }

    /*
     * Calculate the intersection of two rectangles
     */
    intersect(r1, r2) {
        const r3 = {
            left: Math.max(r1.left, r2.left),
            top: Math.max(r1.top, r2.top),
            right: Math.min(r1.right, r2.right),
            bottom: Math.min(r1.bottom, r2.bottom)
        };
        r3.width = r3.right - r3.left;
        r3.height = r3.bottom - r3.top;
        return r3;
    }

    isScrollableElement(domNode) {
        const overflowy = $(domNode).css('overflow-y');
        if (domNode.clientHeight > 0 && domNode.clientHeight < domNode.scrollHeight
            && (overflowy == "auto" || overflowy == 'scroll')) {
            return true;
        }
        const overflowx = $(domNode).css('overflow-x');
        if (domNode.clientWidth > 0 && domNode.clientWidth < domNode.scrollWidth
            && (overflowx == "auto" || overflowx == 'scroll')) {
            return true;
        }
        return false;
    }

    /*
     * Determine if the element is fully visible within all scrollable ancestors
     */
    isFullyVisible(node) {
        var r1 = node.getBoundingClientRect();
        const r2 = node.getBoundingClientRect();
        var ancestor = $(node.parentElement);
        while (!ancestor.is('body')) {
            if (this.isScrollableElement(ancestor[0])) {
                r1 = this.intersect(r1, ancestor[0].getBoundingClientRect());
            }
            // If the width or height of the intersection is less than the original
            // element, then it's not fully visible.
            if (r1.width < r2.width || r1.height < r2.height) {
                return false;
            }
            ancestor = ancestor.parent();
        } 
        // In quirks mode, clientHeight of body is viewport height.  In standards
        // mode, clientHeight of html is viewport height.
        const quirksMode = node.ownerDocument.compatMode != 'CSS1Compat';
        const de = quirksMode ? ancestor : ancestor.closest("html").get(0);
        return r1.left > 0 && r1.top > 0 && r1.right < de.clientWidth && r1.bottom < de.clientHeight;
    }

    /* If the specified element is not fully visible, scroll it into the center of
     * the viewport */
    showElement(e) {
        const ee = e.filter(':not(.ixbrl-no-highlight)').get(0);
        if (!this.isFullyVisible(ee)) {
            ee.scrollIntoView({ block: "center", inline: "center" });
        }
    }

    clearHighlighting() {
        $("body", this._iframes.contents()).find(".ixbrl-element").removeClass("ixbrl-selected").removeClass("ixbrl-related").removeClass("ixbrl-linked-highlight");
    }

    _ixIdsForElement(e) {
        return e.data('ivids');
    }

    /*
     * Select the fact corresponding to the specified element.
     *
     * Takes an optional list of factIds corresponding to all facts that a click
     * falls within.  If omitted, it's treated as a click on a non-nested fact.
     *
     * byClick indicates that the element was clicked directly, and in this
     * case we never scroll to make it more visible.
     */
    selectElement(vuid, itemIdList, byClick) {
        if (vuid !== null) {
            this.onSelect.fire(vuid, itemIdList, byClick);
        }
        else {
            this.onSelect.fire(null);
        }
    }

    // Handle a mouse click to select.  This finds all tagged elements that the
    // mouse click is within, and returns a list of item IDs for the items that
    // they're tagging.  This is so the inspector can show all items that were
    // under the click.
    // The initially selected element is the highest ancestor which is tagging
    // exactly the same content as the clicked element.  This is so that when we
    // have double tagged elements, we select the first of the set, but where we
    // have nested elements, we select the innermost, as this gives the most
    // intuitive behaviour when clicking "next".
    selectElementByClick(e) {
        let itemIDList = [];
        const viewer = this;
        let sameContentAncestorVuid;
        // If the user clicked on a sub-element (and which is not also a proper
        // ixbrl-element) treat as if we clicked the first non-sub-element
        // ancestor in the DOM hierarchy - which would typically be
        // the corresponding ixbrl-element (or one of the corresponding
        // ixbrl-elements, in the case of nested tags)
        // This is important in order to guarantee that sameContentAncestorId gets
        // assigned below.
        // We can't just ignore clicks on sub elements altogether because they are
        // likely to be rendered outside the "enclosing" ixbrl-element.
        if (!e.hasClass(".ixbrl-element")) {
            e = e.closest(".ixbrl-element");
        }
        // Now find all iXBRL IDs on all ancestors in document order, making a note
        // of the first one (sameContentAncestorId) that has exactly the same
        // content as "e"
        e.parents(".ixbrl-element").addBack().each(function () { 
            const vuids = viewer._ixIdsForElement($(this));
            itemIDList = itemIDList.concat(vuids);
            if ($(this).text() == e.text() && sameContentAncestorVuid === undefined) {
                sameContentAncestorVuid = vuids[0];
            }
        });
        this.selectElement(sameContentAncestorVuid, itemIDList, true);
    }

    _mouseEnter(e) {
        const id = e.data('ivids')[0];
        this.onMouseEnter.fire(id);
    }

    _mouseLeave(e) {
        const id = e.data('ivids')[0];
        this.onMouseLeave.fire(id);
    }

    highlightRelatedFact(f) {
        this.changeItemClass(f.vuid, "ixbrl-related");
    }

    highlightRelatedFacts(facts) {
        for (const f of facts) {
            this.changeItemClass(f.vuid, "ixbrl-related");
        }
    }

    clearRelatedHighlighting(f) {
        $(".ixbrl-related", this._contents).removeClass("ixbrl-related");
    }

    // Return a jQuery node list for wrapper elements corresponding to 
    // the factId.  May contain more than one node if the IX node contains
    // absolutely positioned elements.
    elementsForItemId(vuid) {
        if (!(vuid in this._ixNodeMap)){
            throw new Error(`Attempting to retrieve IXNode with missing key: ${vuid}`);
        }
        return this._ixNodeMap[vuid].wrapperNodes;
    }

    // Returns a jQuery node list containing the primary wrapper node for each
    // vuid provided
    primaryElementsForItemIds(vuids) {
        return $(vuids.map(vuid => this.elementsForItemId(vuid).filter(".ixbrl-element").toArray()).flat());
    }

    /*
     * Add or remove a class to an item (fact or footnote) and any continuation elements
     */
    changeItemClass(vuid, highlightClass, removeClass) {
        const elements = this.primaryElementsForItemIds([vuid].concat(this.itemContinuationMap[vuid]))
        if (removeClass) {
            elements.removeClass(highlightClass);
        }
        else {
            elements.addClass(highlightClass);
        }
    }

    /*
     * Change the currently highlighted item
     */
    highlightItem(vuid) {
        this.clearHighlighting();
        this.changeItemClass(vuid, "ixbrl-selected");
    }

    showItemById(vuid) {
        if (vuid !== null) {
            let elts = this.elementsForItemId(vuid);
            this.showDocumentForItemId(vuid);
            /* Hidden elements will return an empty node list */
            if (elts.length > 0) {
                this.showElement(elts);
            }
        }
    }

    highlightAllTags(on, namespaceGroups) {
        const groups = {};
        $.each(namespaceGroups, function (i, ns) {
            groups[ns] = i % HIGHLIGHT_COLORS;
        });
        const reportSet = this._reportSet;
        const viewer = this;
        if (on) {
            $(".ixbrl-element", this._contents)
                .addClass("ixbrl-highlight")
                .each(function () {
                    // Find the first ixn for this element that isn't a footnote.
                    // Choosing the first means that we're arbitrarily choosing a
                    // highlight color for an element that is double tagged in a
                    // table cell.
                    const ixn = $(this).data('ivids').map(id => viewer._ixNodeMap[id]).filter(ixn => !ixn.footnote)[0];
                    if (ixn !== undefined ) {
                        const item = reportSet.getItemById(ixn.id);
                        if (item !== undefined) {
                            const elements = viewer.primaryElementsForItemIds(ixn.chainIXIds());
                            const i = groups[item.conceptQName().prefix];
                            if (i !== undefined) {
                                elements.addClass("ixbrl-highlight-" + i);
                            }
                        }
                    }
            });
        }
        else {
            $(".ixbrl-element", this._contents).removeClass(
                (i, className) => (className.match (/(^|\s)ixbrl-highlight\S*/g) || []).join(' ')
            );
        }
    }

    zoom(pct) {
        this.scale = pct/100;
        const viewTop = this._contents.scrollTop();
        const height = $("html", this._contents).height();
        $('body', this._contents).css('zoom', this.scale);

        const newHeight = $("html", this._contents).height();
        this._contents.scrollTop(newHeight * (viewTop)/height );
    }

    factsInSameTable(fact) {
        var facts = [];
        const e = this.elementsForItemId(fact.vuid);
        e.closest("table").find(".ixbrl-element").each(function () {
            facts = facts.concat($(this).data('ivids'));
        });
        return facts;
    }

    linkedHighlightFact(f) {
        this.changeItemClass(f.vuid, "ixbrl-linked-highlight");
    }

    clearLinkedHighlightFact(f) {
        this.changeItemClass(f.vuid, "ixbrl-linked-highlight", true);
    }

    getTitle(docIndex) {
        return $('head title', this._iframes.eq(docIndex).contents()).text();
    }

    showDocumentForItemId(vuid) {
        this.selectDocument(this._ixNodeMap[vuid].docIndex);
    }

    currentDocument() {
        return this._iframes.eq(this._currentDocumentIndex);
    }

    documentCount() {
        return this._iframes.length;
    }

    selectDocument(docIndex) {
        this._currentDocumentIndex = docIndex;
        $('#ixv #viewer-pane .ixds-tabs .tab')
            .removeClass("active")
            .eq(docIndex)
            .addClass("active");
        /* Show/hide documents using height rather than display property to avoid a
         * delay when switching tabs on large, slow-to-render documents. */
        this._iframes
            .height(0)
            .data("selected", false)
            .eq(docIndex)
            .height("100%")
            .data("selected", true);
    }

    /*
     * Ticket 11 instrumentation.  The two passes are accumulated across yields
     * rather than wrapped in one span: runGenerator resumes on setTimeout(0), so
     * the generator's *elapsed* time includes the search index's slices and
     * whatever layout and paint the browser interleaves.  The spans are work; the
     * marks give elapsed; the difference between them is the finding.
     *
     * The counters are local integers emitted once per iframe, and perfNow() is
     * called once per hundred nodes at a yield, never once per node.
     */
    * postProcess() {
        for (const iframe of this._iframes.get()) {
            const elts = perfSpan('drain.viewer.select',
                () => $(iframe).contents().get(0).querySelectorAll(".ixbrl-contains-absolute"));
            /* Ticket 07 named this as the counter the viewer's drain pass scales
             * with - containers, not the fcwn.absoluteSubNodes descendants.  It is
             * emitted before the arm dispatch, so it is also the guard that an arm
             * has not silently ablated something it has no business touching. */
            perfCount('drain.viewer.containsAbsolute', elts.length);
            if (ABLATE === 'drainnopass') {
                /* Named explicitly, and the only arm that skips the passes: no
                 * bare else here, because ticket 06 found one meant another code
                 * path's arms silently ablated this one too. */
                continue;
            }
            /* Ticket 07's own arms.  drainnopass above removes BOTH passes, so it
             * cannot price the change ticket 07 actually proposes: with pass 1
             * gone, pass 2 becomes the *first* reader of this document's layout
             * and inherits the flush pass 1 used to pay for.  These two arms keep
             * pass 2 byte-identical and vary only what precedes it.
             *
             * drainbatchednopass1 is the one arm that combines two tickets': it is
             * ticket 03's batched pass 2 with pass 1 deleted, because ABLATE holds
             * one arm at a time and the question ticket 07 actually has to answer
             * is what deleting pass 1 is worth in the world where ticket 03 ships.
             *
             * Named explicitly, never a bare else, for the reason above. */
            const skipPass1 = ABLATE === 'drainnopass1' || ABLATE === 'drainnopass1fonts'
                || ABLATE === 'drainbatchednopass1' || ABLATE === 'drainwarmonce'
                || ABLATE === 'drainyieldonly';
            const batchedPass2 = ABLATE === 'drainbatched' || ABLATE === 'drainbatchednopass1'
                || ABLATE === 'drainwarmonce' || ABLATE === 'drainyieldonly';
            if (ABLATE === 'drainyieldonly') {
                /* drainwarmonce showed a single forced layout does not substitute
                 * for pass 1, so what pass 1 buys is elapsed time and event-loop
                 * turns rather than "a layout has happened" - which is what ticket
                 * 06 inferred from the source.  This arm keeps pass 1's yield
                 * cadence exactly and drops only its reads.  If noHighlight comes
                 * back to the baseline's count, the settling is bought by the
                 * waiting and the 5,339 style reads are the removable part. */
                const ty = perfNow();
                let yieldOnly = 0;
                for (let i = 0; i < elts.length; i++) {
                    if (i % 100 === 0) {
                        yield;
                        yieldOnly++;
                    }
                }
                perfAdd('drain.viewer.yieldOnly', perfNow() - ty);
                perfCount('drain.viewer.yieldOnlyYields', yieldOnly);
            }
            if (ABLATE === 'drainwarmonce') {
                /* The narrower guard ticket 06 predicted, made concrete by ticket
                 * 07's measurement.  Deleting pass 1 outright stops highlighting 6
                 * visibly non-zero elements on fr-esef-both-huge and 2 on
                 * aviva-2025, so the pass is load-bearing - but its 310 ms is
                 * 5,339 per-element getComputedStyle calls on a cold tree, and
                 * what pass 2 may actually need is only that a full layout has
                 * been performed at all.  One read of the document's own border
                 * box forces exactly that, for one layout instead of thousands.
                 *
                 * If drain.viewer.noHighlight comes back to the baseline's count,
                 * this is pass 1's correctness at pass 2's price. */
                const tw = perfNow();
                $(iframe).contents().get(0).body.getBoundingClientRect().height;
                perfAdd('drain.viewer.warmOnce', perfNow() - tw);
            }
            if (ABLATE === 'drainnopass1fonts') {
                /* Ticket 06's first candidate precondition: text has no boxes
                 * until its font has loaded, and the viewer never waits on
                 * document.fonts.ready.  The elements read below live in the
                 * report iframe, so it is that document's font set that governs
                 * their boxes.  Spin on a resolved flag rather than awaiting -
                 * this is a generator, and runGenerator resumes it on a macrotask
                 * - and count the wait so a null can be stated as a null. */
                const doc = $(iframe).contents().get(0);
                let fontsReady = false;
                doc.fonts.ready.then(() => { fontsReady = true; });
                const tf = perfNow();
                let fontYields = 0;
                while (!fontsReady) {
                    yield;
                    fontYields++;
                }
                perfAdd('drain.viewer.fontsWait', perfNow() - tf);
                perfCount('drain.viewer.fontsWaitYields', fontYields);
            }
            // In some cases, getBoundingClientRect().height returns 0, and
            // immediately repeating the call returns > 0, so do this in two passes.
            let acc = 0;
            let layout = 0;
            let yields = 0;
            let t = perfNow();
            if (!skipPass1) {
                for (const [i, e] of elts.entries()) {
                    if (getComputedStyle(e).getPropertyValue("display") !== 'inline') {
                        e.getBoundingClientRect().height
                        layout++;
                    }
                    if (i % 100 === 0) {
                        acc += perfNow() - t;
                        yield;
                        yields++;
                        t = perfNow();
                    }
                }
            }
            /* Emitted on every arm, including the two that skip the pass, so the
             * ablation reads as a measured zero rather than as a missing key. */
            perfAdd('drain.viewer.pass1', acc + perfNow() - t);
            perfCount('drain.viewer.pass1Layout', layout);
            perfCount('drain.viewer.yields', yields);
            if (batchedPass2) {
                /* Ordering control, not an ablation - see ABLATE in perf.js for
                 * why hoisting the writes cannot change a read's answer. */
                const hide = [];
                acc = 0;
                yields = 0;
                t = perfNow();
                for (const [i, e] of elts.entries()) {
                    if (getComputedStyle(e).getPropertyValue("display") !== 'inline' && e.getBoundingClientRect().height == 0) {
                        hide.push(e);
                    }
                    if (i % 100 === 0) {
                        acc += perfNow() - t;
                        yield;
                        yields++;
                        t = perfNow();
                    }
                }
                perfCount('drain.viewer.yields', yields);
                for (const e of hide) {
                    e.classList.add("ixbrl-no-highlight");
                }
                perfAdd('drain.viewer.pass2', acc + perfNow() - t);
                perfCount('drain.viewer.noHighlight', hide.length);
            }
            else {
                acc = 0;
                yields = 0;
                let hidden = 0;
                t = perfNow();
                for (const [i, e] of elts.entries()) {
                    if (getComputedStyle(e).getPropertyValue("display") !== 'inline' && e.getBoundingClientRect().height == 0) {
                        e.classList.add("ixbrl-no-highlight");
                        hidden++;
                    }
                    if (i % 100 === 0) {
                        acc += perfNow() - t;
                        yield;
                        yields++;
                        t = perfNow();
                    }
                }
                perfCount('drain.viewer.yields', yields);
                perfAdd('drain.viewer.pass2', acc + perfNow() - t);
                perfCount('drain.viewer.noHighlight', hidden);
            }
        }
    }

    postLoadAsync() {
        perfMark('viewer.postLoadAsync.start');
        runGenerator(perfWatchGenerator(this.postProcess(), 'viewer.postLoadAsync.end'), 'viewer');
    }

}
