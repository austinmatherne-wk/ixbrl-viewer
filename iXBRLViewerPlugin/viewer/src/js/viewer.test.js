// See COPYRIGHT.md for copyright information

import $ from 'jquery'
import { Viewer } from "./viewer.js";

/*
 * postProcess() hides highlighting for iXBRL elements that turned out to have no
 * height once the report had been laid out.  It reads computed style and geometry
 * for every element marked as containing an absolutely positioned descendant, so
 * it is a standing candidate for having its reads batched away from its writes.
 * These tests pin what it classes, so that a reordering has to keep it.
 *
 * jsdom has no layout, so getBoundingClientRect() is all zeroes and every
 * non-inline container qualifies.  That is the branch under test; the inline test
 * covers the other one.
 *
 * Display is set inline on every element here rather than left to the tag, because
 * jsdom does not apply its default stylesheet when the viewer window's
 * getComputedStyle reads an element belonging to the iframe's document - which is
 * exactly the call the production code makes.  Inline styles it does resolve, and
 * a resolved display is all this loop reads.
 */

/* The production code reads the report document through the iframe, and calls the
 * viewer window's getComputedStyle on elements that live inside it. */
const reportDocument = (markup) => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    iframe.contentDocument.body.innerHTML = markup;
    return iframe;
};

const postProcess = (iframe) => {
    const viewer = new Viewer({}, $(iframe), {});
    /* A generator resumed by runGenerator in production; drained in one go here. */
    Array.from(viewer.postProcess());
    return iframe.contentDocument;
};

const noHighlight = (doc, selector) =>
    doc.querySelector(selector).classList.contains('ixbrl-no-highlight');

describe("Viewer.postProcess", () => {
    test("stops highlighting a zero-height container", () => {
        const doc = postProcess(reportDocument(
            '<div id="a" class="ixbrl-element ixbrl-contains-absolute" style="display: block">x</div>'));

        expect(noHighlight(doc, '#a')).toBe(true);
    });

    test("leaves an inline container alone", () => {
        const doc = postProcess(reportDocument(
            '<span id="a" class="ixbrl-element ixbrl-contains-absolute" style="display: inline">x</span>'));

        expect(noHighlight(doc, '#a')).toBe(false);
    });

    test("ignores elements not marked as containing an absolute descendant", () => {
        const doc = postProcess(reportDocument(
            '<div id="a" class="ixbrl-element" style="display: block">x</div>'));

        expect(noHighlight(doc, '#a')).toBe(false);
    });

    /*
     * The regression this change could introduce: collecting the elements to class
     * and then not classing all of them.  One container per element would pass the
     * first test above and still lose every container after the first.
     */
    test("classes every qualifying container, not only the first", () => {
        const doc = postProcess(reportDocument(
            Array.from({ length: 250 }, (_, i) =>
                `<div id="d${i}" class="ixbrl-element ixbrl-contains-absolute" `
                + `style="display: block">x</div>`).join('')));

        expect(doc.querySelectorAll('.ixbrl-no-highlight').length).toBe(250);
    });

    /*
     * The reads and the writes must agree about which elements qualify even when
     * the two are separated, so a mixed document is the case that catches a
     * collect-then-class pass writing to the wrong elements.
     */
    test("classes only the non-inline containers in a mixed document", () => {
        const doc = postProcess(reportDocument(
            '<div id="block1" class="ixbrl-contains-absolute" style="display: block">x</div>'
            + '<span id="inline1" class="ixbrl-contains-absolute" style="display: inline">x</span>'
            + '<div id="block2" class="ixbrl-contains-absolute" style="display: block">x</div>'
            + '<span id="inline2" class="ixbrl-contains-absolute" style="display: inline">x</span>'));

        expect([...doc.querySelectorAll('.ixbrl-no-highlight')].map(e => e.id))
            .toEqual(['block1', 'block2']);
    });
});
