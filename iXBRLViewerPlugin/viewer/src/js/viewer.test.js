// See COPYRIGHT.md for copyright information

import $ from 'jquery'
import { Viewer } from "./viewer.js";

/*
 * _wrapNode chooses the highlight wrapper for an iXBRL element: reuse a table
 * cell, reuse element children, or insert a span/div around mixed content.
 * These tests pin that choice so a cheaper insert still wraps the same nodes
 * with the same tag.
 */

const viewer = () => new Viewer({}, $(), {});

const html = (markup) => {
    const host = document.createElement('div');
    host.innerHTML = markup;
    document.body.appendChild(host);
    return host;
};

afterEach(() => {
    document.body.replaceChildren();
});

describe("Viewer._findOrCreateWrapperNode", () => {
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
