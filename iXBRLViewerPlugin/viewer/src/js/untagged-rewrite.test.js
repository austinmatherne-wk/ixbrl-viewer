// See COPYRIGHT.md for copyright information

import $ from 'jquery'
import { Viewer } from './viewer.js';

/*
 * The DOM that _wrapUntaggedNumbers() leaves behind.
 *
 * number-matcher-preprocess.test.js mocks numberMatchSearch, so it asserts which
 * strings get searched and never what the walk produces.  These tests use the real
 * matcher and assert the resulting nodes, because the walk now skips the rewrite on
 * a text node the matcher found nothing in and the claim being made is that the
 * result is identical either way.  Every assertion here holds against the
 * unconditional version too - that is the point of them.
 */

/* The child nodes of `el` as a comparable structure: text nodes as their value,
 * elements as tag, class list and text.  Node identity is deliberately not part of
 * it - the unconditional rewrite replaces a text node with an equal one, and the
 * whole finding is that this is not observable. */
function shape(el) {
    return [...el.childNodes].map(n => {
        if (n.nodeType === Node.TEXT_NODE) {
            return { text: n.nodeValue };
        }
        return {
            tag: n.nodeName.toLowerCase(),
            class: n.getAttribute('class'),
            text: n.textContent,
        };
    });
}

describe("Untagged number rewriting", () => {
    const viewer = new Viewer(null, $(this), null);

    /* ignoreFullMatch is false at the top-level entry point, matching the call in
     * Viewer.initialize(); the recursion turns it on for ix:nonNumeric. */
    function wrap(html, ignoreFullMatch = false) {
        const n = build(html);
        viewer._wrapUntaggedNumbers(n, 0, ignoreFullMatch);
        return n;
    }

    /* Built but not walked, for the two cases that need a node the HTML parser
     * will not produce. */
    function build(html) {
        return $("<div></div>").html(html);
    }

    test("a text node with no match is left exactly as it was", () => {
        const n = wrap("Consolidated statements of operations");
        expect(shape(n[0])).toEqual([
            { text: "Consolidated statements of operations" },
        ]);
    });

    test("a whitespace-only text node is left exactly as it was", () => {
        const n = wrap("   \n  ");
        expect(shape(n[0])).toEqual([
            { text: "   \n  " },
        ]);
    });

    /* The one case where the rewrite is not a no-op, and the reason the walk still
     * runs it when nothing matched: jQuery's replaceWith() on an empty set removes
     * the node outright.  A zero-length text node has no visible effect either way,
     * but dropping this case would make the change a behaviour change instead of an
     * identical-output one, so it is asserted rather than assumed. */
    test("a zero-length text node is removed", () => {
        const n = build("<b>kept</b>");
        n[0].insertBefore(document.createTextNode(""), n[0].firstChild);
        expect(n[0].childNodes.length).toBe(2);

        viewer._wrapUntaggedNumbers(n, 0, false);

        expect(shape(n[0])).toEqual([
            { tag: 'b', class: null, text: "kept" },
        ]);
    });

    test("a matching text node is split around a wrapped number", () => {
        const n = wrap("total of 1,234 units");
        expect(shape(n[0])).toEqual([
            { text: "total of " },
            { tag: 'span', class: 'review-untagged-number', text: "1,234" },
            { text: " units" },
        ]);
    });

    test("a matching text node is split around a wrapped date", () => {
        const n = wrap("as at 2001-01-01 and later");
        expect(shape(n[0])).toEqual([
            { text: "as at " },
            { tag: 'span', class: 'review-untagged-date', text: "2001-01-01" },
            { text: " and later" },
        ]);
    });

    /* The matcher treats the bare words "no" and "none" as untagged numbers
     * (number-matcher.js:115), so ordinary prose matches far more often than a
     * digit-only reading would suggest.  This is why the payoff had to be measured
     * rather than assumed: it is not safe to think most text nodes are
     * non-matching. */
    test("the bare word \"no\" matches, so prose is not automatically skipped", () => {
        const n = wrap("no numbers here at all");
        expect(shape(n[0])).toEqual([
            { tag: 'span', class: 'review-untagged-number', text: "no" },
            { text: " numbers here at all" },
        ]);
    });

    /* ignoreFullMatch: a match covering the whole of the parent's text is assumed
     * to be the tagged value itself, so it is put back as plain text rather than
     * wrapped.  It still goes through the rewrite, because the matcher matched. */
    test("a full match under ignoreFullMatch is kept as unwrapped text", () => {
        const n = wrap("2001-01-01", true);
        expect(shape(n[0])).toEqual([
            { text: "2001-01-01" },
        ]);
    });

    test("a full match is still wrapped when ignoreFullMatch is off", () => {
        const n = wrap("2001-01-01", false);
        expect(shape(n[0])).toEqual([
            { tag: 'span', class: 'review-untagged-date', text: "2001-01-01" },
        ]);
    });

    /* Two text nodes either side of an element, only one of which matches: the
     * conditional rewrite has to leave the non-matching sibling in place without
     * disturbing the position of the one it does rewrite. */
    test("a non-matching sibling does not move the node that is rewritten", () => {
        const n = wrap("no. of shares<b>x</b>held: 12 shares");
        expect(shape(n[0])).toEqual([
            { tag: 'span', class: 'review-untagged-number', text: "no" },
            { text: ". of shares" },
            { tag: 'b', class: null, text: "x" },
            { text: "held: " },
            { tag: 'span', class: 'review-untagged-number', text: "12" },
            { text: " shares" },
        ]);
    });
});
