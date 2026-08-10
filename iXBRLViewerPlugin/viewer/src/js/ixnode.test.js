// See COPYRIGHT.md for copyright information

import $ from 'jquery';
import { IXNode } from "./ixnode.js";

/*
 * jsdom gives every element a zero box and no client rects, so jQuery's
 * ':hidden' is true for anything it is asked about.  That is what makes these
 * tests possible at all - a real concealed fact is otherwise hard to build -
 * but it means the ':hidden' disjunct has to be steered by the *filter*, not by
 * the geometry.  A wrapper node that survives the filter reads as hidden; one
 * that does not leaves an empty set, and `$().is(':hidden')` is false.
 */
describe("IXNode.htmlHidden", () => {

    function node(html) {
        return new IXNode("f1", $(html));
    }

    test("a wrapper node with no box reads as concealed", () => {
        expect(node('<span></span>').htmlHidden()).toBe(true);
    });

    test("a wrapper whose content is all absolutely positioned is not itself tested", () => {
        // .ixbrl-contains-absolute marks a wrapper whose own box is empty by
        // construction: the content lives in .ixbrl-sub-element children, which
        // are separate entries in wrapperNodes.  Its emptiness is not the
        // filer concealing anything.
        expect(node('<span class="ixbrl-contains-absolute"></span>').htmlHidden()).toBe(false);
    });

    test("the sub-elements of such a wrapper are still tested", () => {
        const nodes = $('<span class="ixbrl-contains-absolute"></span>')
            .add($('<span class="ixbrl-sub-element"></span>'));
        expect(new IXNode("f1", nodes).htmlHidden()).toBe(true);
    });

    test("a zero-height wrapper is tested, so .ixbrl-no-highlight no longer exempts it", () => {
        // The previous filter was ':not(.ixbrl-no-highlight)'.  That class is
        // written by postProcess(), long after the fact list is built, so it
        // exempted nothing at the call site that mattered - and where it is
        // present it is a subset of .ixbrl-contains-absolute, whose sub-elements
        // are tested in its place.
        expect(node('<span class="ixbrl-no-highlight"></span>').htmlHidden()).toBe(true);
    });

    test("effectively transparent text reads as concealed even where the box test passes", () => {
        const n = node('<span class="ixbrl-contains-absolute" style="color: rgba(0, 0, 0, 0)"></span>');
        expect(n.htmlHidden()).toBe(true);
    });

    test("opaque text in a wrapper that is not tested for its box is not concealed", () => {
        const n = node('<span class="ixbrl-contains-absolute" style="color: rgba(0, 0, 0, 1)"></span>');
        expect(n.htmlHidden()).toBe(false);
    });
});
