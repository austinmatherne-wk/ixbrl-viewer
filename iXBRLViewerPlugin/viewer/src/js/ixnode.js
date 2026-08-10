// See COPYRIGHT.md for copyright information

import $ from 'jquery';
import { isTransparent } from './util.js';

/*
 * Object to hold information related to iXBRL nodes in the HTML document.
 * May correspond to either a nonNumeric/nonFraction element, or a continuation
 * element.
 * 
 * The wrapperNodes property is a jQuery object for the "containing" elements
 * which will be a node list containng an inserted div or span wrapper, any
 * absolutely positioned elements or the nearest enclosing td or th.
 */

var docOrderindex = 0;

export class IXNode {
    constructor(id, wrapperNodes, docIndex) {
        this.wrapperNodes = wrapperNodes;
        this.escaped = false;
        this.continuations = [];
        this.docIndex = docIndex;
        this.footnote = false;
        this.id = id;
        this.isHidden = false;
        this.docOrderindex = docOrderindex++;
    }

    continuationIds() {
        return this.continuations.map(n => n.id);
    }

    // Return IX IDs for all IX elements in the continuation chain, including the
    // head.
    chainIXIds() { 
        return [this.id].concat(this.continuationIds());
    }

    textContent() { 
        return [this].concat(this.continuations)
            // The first wrapperNode is always the wrapper for the actual IX node,
            // so will give the full text content.
            .map(n => n.wrapperNodes.first().text())
            .join(" ");
    }

    /*
     * True if the filer has concealed this fact's tagged text with CSS: a
     * wrapper with no box, or text that is effectively transparent.
     *
     * A wrapper whose only content is absolutely positioned is excluded from
     * the ':hidden' test.  Its own box is empty by construction - the content
     * sits in the .ixbrl-sub-element children, which are tested in its place -
     * so its invisibility says nothing about the filer's intent.
     * .ixbrl-contains-absolute marks exactly that case and is set during the
     * eager wrapper walk, so it is available whenever this is called;
     * .ixbrl-no-highlight, which was tested here before, is written only by
     * postProcess() and only where the wrapper is not display:inline, so it was
     * absent from every row built at startup and never reached an inline
     * wrapper at all.
     */
    htmlHidden() {
        return this.wrapperNodes.filter(':not(.ixbrl-contains-absolute)').is(':hidden') || this.wrapperNodes.is((i,e) => isTransparent($(e).css('color')));
    }
}
