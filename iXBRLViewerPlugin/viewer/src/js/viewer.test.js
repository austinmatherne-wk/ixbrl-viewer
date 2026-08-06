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
 * it.
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
});
