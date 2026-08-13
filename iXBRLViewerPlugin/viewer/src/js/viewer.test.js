// See COPYRIGHT.md for copyright information

import $ from 'jquery'
import { Viewer } from "./viewer.js";

/*
 * _findOrCreateWrapperNode resolves computed style for every descendant of every
 * wrapper node it chooses, and classes the absolutely positioned ones.  Both
 * halves of what it returns are load-bearing and neither is obvious from the call
 * site: the classes drive highlighting, and the *order* of the returned set
 * becomes IXNode.wrapperNodes, whose first entry callers rely on being the
 * wrapper for the iXBRL element itself.
 *
 * The scan is also the hottest loop in the load, so it is a standing candidate
 * for reordering.  These tests pin the output so that a reordering has to keep
 * it.  The wrap-choice cases pin which node and tag _wrapNode selects, so a
 * cheaper insert still wraps the same nodes with the same tag.
 */

const viewer = () => new Viewer({}, $(), {});

/* jsdom resolves computed style from inline styles, which is all this loop reads. */
const absolute = (el) => {
    el.style.position = 'absolute';
    return el;
};

const html = (markup) => {
    const host = document.createElement('div');
    host.innerHTML = markup;
    document.body.appendChild(host);
    return host;
};

describe("Viewer._findOrCreateWrapperNode", () => {
    test("returns only the inserted wrapper when nothing below it is absolute", () => {
        const host = html('<span id="ix">1.0 <b id="child">x</b></span>');
        const nodes = viewer()._findOrCreateWrapperNode(host.querySelector('#ix'), false);

        /* Direct text content, so a wrapper is inserted around #ix rather than
         * #ix's children being used as the wrappers. */
        expect(nodes.get().length).toBe(1);
        expect(nodes.get(0)).toBe(host.querySelector('#ix').parentNode);
        expect(nodes.get(0).classList.contains('ixbrl-element')).toBe(true);
        expect(nodes.get(0).classList.contains('ixbrl-contains-absolute')).toBe(false);
        expect(host.querySelector('#child').classList.contains('ixbrl-sub-element')).toBe(false);
    });

    test("classes absolutely positioned descendants and returns them after their wrapper", () => {
        const host = html('<span id="ix">t<i id="a"></i><i id="plain"></i><i id="b"></i></span>');
        absolute(host.querySelector('#a'));
        absolute(host.querySelector('#b'));
        const nodes = viewer()._findOrCreateWrapperNode(host.querySelector('#ix'), false);

        /* The wrapper is a <span> inserted around #ix, so it has no id of its own. */
        expect(nodes.get().map(n => n.id)).toEqual(['', 'a', 'b']);
        expect(nodes.get(0).classList.contains('ixbrl-element')).toBe(true);
        expect(nodes.get(0).classList.contains('ixbrl-contains-absolute')).toBe(true);
        expect(nodes.get(1).classList.contains('ixbrl-sub-element')).toBe(true);
        expect(nodes.get(2).classList.contains('ixbrl-sub-element')).toBe(true);
        expect(host.querySelector('#plain').classList.contains('ixbrl-sub-element')).toBe(false);
    });

    /*
     * The case that separates "batch the reads" from "batch the reads and keep the
     * order".  An element whose children are all elements is wrapped by its
     * children rather than by an inserted span, so the returned set covers several
     * wrappers - and each one's sub-elements must follow that wrapper, not trail
     * after every wrapper in the set.
     */
    test("interleaves each wrapper with its own sub-elements when there are several wrappers", () => {
        const host = html(
            '<div id="ix"><p id="p1"><i id="a1"></i></p><p id="p2"><i id="a2"></i></p></div>');
        absolute(host.querySelector('#a1'));
        absolute(host.querySelector('#a2'));
        const nodes = viewer()._findOrCreateWrapperNode(host.querySelector('#ix'), false);

        expect(nodes.get().map(n => n.id)).toEqual(['p1', 'a1', 'p2', 'a2']);
        expect(nodes.get().map(n => n.classList.contains('ixbrl-element'))).toEqual(
            [true, false, true, false]);
        expect(nodes.get().map(n => n.classList.contains('ixbrl-sub-element'))).toEqual(
            [false, true, false, true]);
        expect(nodes.get().map(n => n.classList.contains('ixbrl-contains-absolute'))).toEqual(
            [true, false, true, false]);
    });

    test("marks only the wrappers that have sub-elements as containing them", () => {
        const host = html('<div id="ix"><p id="p1"><i id="a1"></i></p><p id="p2"><i id="x"></i></p></div>');
        absolute(host.querySelector('#a1'));
        const nodes = viewer()._findOrCreateWrapperNode(host.querySelector('#ix'), false);

        expect(nodes.get().map(n => n.id)).toEqual(['p1', 'a1', 'p2']);
        expect(host.querySelector('#p1').classList.contains('ixbrl-contains-absolute')).toBe(true);
        expect(host.querySelector('#p2').classList.contains('ixbrl-contains-absolute')).toBe(false);
    });

    test("returns the hidden element itself, unscanned, when it is in the hidden section", () => {
        const host = html('<span id="ix"><i id="a"></i></span>');
        absolute(host.querySelector('#a'));
        const nodes = viewer()._findOrCreateWrapperNode(host.querySelector('#ix'), true);

        expect(nodes.get().map(n => n.id)).toEqual(['ix']);
        expect(nodes.get(0).classList.contains('ixbrl-element-hidden')).toBe(true);
        expect(host.querySelector('#a').classList.contains('ixbrl-sub-element')).toBe(false);
    });

    test("inserts a span around an inline fact that has direct text", () => {
        const host = html('<span id="ix" style="display: inline">1.0</span>');
        const nodes = viewer()._findOrCreateWrapperNode(host.querySelector('#ix'), false);

        expect(nodes.get().length).toBe(1);
        expect(nodes.get(0).tagName).toBe('SPAN');
        expect(nodes.get(0)).toBe(host.querySelector('#ix').parentNode);
        expect(nodes.get(0).classList.contains('ixbrl-element')).toBe(true);
        expect(host.querySelector('#ix').parentNode.firstChild).toBe(host.querySelector('#ix'));
    });

    test("inserts a div around a block fact that has direct text", () => {
        const host = html('<div id="ix" style="display: block">1.0</div>');
        const nodes = viewer()._findOrCreateWrapperNode(host.querySelector('#ix'), false);

        expect(nodes.get().length).toBe(1);
        expect(nodes.get(0).tagName).toBe('DIV');
        expect(nodes.get(0)).toBe(host.querySelector('#ix').parentNode);
        expect(nodes.get(0).classList.contains('ixbrl-element')).toBe(true);
    });

    test("inserts a div when an inline fact contains a block descendant", () => {
        const host = html(
            '<span id="ix" style="display: inline">t<div id="block" style="display: block">x</div></span>');
        const nodes = viewer()._findOrCreateWrapperNode(host.querySelector('#ix'), false);

        expect(nodes.get(0).tagName).toBe('DIV');
        expect(nodes.get(0)).toBe(host.querySelector('#ix').parentNode);
    });

    test("reuses element children when the fact has no significant text", () => {
        const host = html('<span id="ix"> <b id="child">x</b> </span>');
        const nodes = viewer()._findOrCreateWrapperNode(host.querySelector('#ix'), false);

        expect(nodes.get().map(n => n.id)).toEqual(['child']);
        expect(host.querySelector('#ix').parentNode).toBe(host);
        expect(nodes.get(0).classList.contains('ixbrl-element')).toBe(true);
    });

    test("uses the enclosing table cell when the fact is its only significant content", () => {
        const host = html(
            '<table><tr><td id="cell" style="display: table-cell"> <span id="ix">1.0</span> </td></tr></table>');
        const nodes = viewer()._findOrCreateWrapperNode(host.querySelector('#ix'), false);

        expect(nodes.get().map(n => n.id)).toEqual(['cell']);
        expect(host.querySelector('#ix').parentNode.id).toBe('cell');
        expect(nodes.get(0).classList.contains('ixbrl-element')).toBe(true);
    });

    test("does not reuse a table cell that has other significant text", () => {
        const host = html(
            '<table><tr><td id="cell" style="display: table-cell">Total <span id="ix">1.0</span></td></tr></table>');
        const nodes = viewer()._findOrCreateWrapperNode(host.querySelector('#ix'), false);

        expect(nodes.get(0).id).not.toBe('cell');
        expect(nodes.get(0)).toBe(host.querySelector('#ix').parentNode);
        expect(nodes.get(0).classList.contains('ixbrl-element')).toBe(true);
    });
});

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
