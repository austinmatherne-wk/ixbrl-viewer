// See COPYRIGHT.md for copyright information

import { perfCount, perfPush } from './perf.js';

export class ReportSetOutline {
    constructor(reportSet) {
        this._reportSet = reportSet;
        /* Ticket 10: one DocumentOutline per *target* report, so this is the
         * pass most likely to double on a two-target document.  Counted rather
         * than inferred - see each outline's own counters below for whether the
         * work is duplicated or merely partitioned. */
        perfCount('outline.documentOutlines', reportSet.reports.length);
        this.outlines = reportSet.reports.map(r => new DocumentOutline(r));
    }

    hasOutline() {
        return this.outlines.some(o => Object.keys(o.sectionFacts).length > 0);
    }

    sortedSections() {
        return this.outlines.flatMap(o => o.sortedSections());
    }

    groupsForFact(f) {
        return this.outlines.find(o => o.report == f.report).groupsForFact(f);
    }

}

// DocumentOutline chooses a fact for each presentation group (ELR) that
// represents the start of that ELR.  This is done by deciding which ELRs each
// fact participates in (see factInGroup()) and then finding the longest
// continuous run of facts in document order that participate in each ELR.
export class DocumentOutline {
    constructor(report) {
        this.report = report;
        this._elrsByConcept = Object.create(null);
        const facts = report.facts().sort((a, b) => a.ixNode.docOrderindex - b.ixNode.docOrderindex);
        const runFacts = {};
        const longestRunFacts = {};
        this._buildDimensionMap();
        const elrs = report.relationshipGroups("pres");
        /* Ticket 10: the outline's unit of work is one factInGroup() test, so
         * accumulate locally across the loop and emit once (perf.js's rule -
         * never call into the module from inside a per-item loop). */
        let tests = 0;
        let walked = 0;

        const closeRun = (elr) => {
            if (!(elr in longestRunFacts) || longestRunFacts[elr].length < runFacts[elr].length) {
                longestRunFacts[elr] = runFacts[elr];
            }
            delete runFacts[elr];
        };

        for (const f of facts) {
            if (f.isHidden()) {
                continue;
            }
            walked++;
            const matched = new Set();
            for (const elr of this._elrsForConcept(f.conceptName())) {
                tests++;
                if (this.factInGroup(f, elr)) {
                    matched.add(elr);
                }
            }
            for (const elr of Object.keys(runFacts)) {
                if (!matched.has(elr)) {
                    closeRun(elr);
                }
            }
            for (const elr of matched) {
                if (!(elr in runFacts)) {
                    runFacts[elr] = [];
                }
                runFacts[elr].push(f);
            }
        }

        // End of document, check if any current runs are the longest run for the
        // ELR.
        for (const elr of Object.keys(runFacts)) {
            closeRun(elr);
        }

        this.sectionFacts = longestRunFacts;

        perfCount('outline.buildFactInGroupTests', tests);
        perfCount('outline.buildFactsWalked', walked);
        perfCount('outline.buildElrs', elrs.length);
        /* Per-outline detail, so a two-target document shows whether its two
         * outlines each saw the whole document (duplicated work) or a disjoint
         * slice of it (partitioned work). */
        perfPush('outlines', {
            target: report._reportData?.target ?? null,
            facts: facts.length,
            factsWalked: walked,
            elrs: elrs.length,
            factInGroupTests: tests,
            sections: Object.keys(longestRunFacts).length,
        });
    }

    // Presentation ELRs in which this concept has a parent.  A fact cannot
    // participate in any other ELR, so the constructor tests only these instead
    // of every presentation group.  Intersected with the live group list so a
    // stale reverse-relationship cache cannot resurrect deleted presentation.
    _elrsForConcept(conceptName) {
        let elrs = this._elrsByConcept[conceptName];
        if (elrs === undefined) {
            const groups = new Set(this.report.relationshipGroups("pres"));
            elrs = Object.keys(this.report.getParentRelationships(conceptName, "pres"))
                .filter(elr => groups.has(elr));
            this._elrsByConcept[conceptName] = elrs;
        }
        return elrs;
    }

    // Returns true if a fact participates in the given presentation group.
    factInGroup(fact, elr) {
        // Roots are abstract so no need to check for concepts with outgoing
        // relationships only.

        if (this.report.getParentRelationshipsInGroup(fact.conceptName(), "pres", elr).length === 0) {
            return false;
        }
        const fd = fact.dimensions();
        const dm = this.dimensionMap[elr];
        if (dm === undefined) {
            return false;
        }
        // Check all dimensions specified in this ELR
        for (const [dim, spec] of Object.entries(dm)) {
            // If a fact has a dimension, it must be in the list of permitted
            // members, otherwise, the default member must be allowed
            if (spec.typed) {
                if (!(dim in fd)) {
                    return false;
                }
            }
            else if ((dim in fd) ? !(fd[dim] in spec.members) : !spec.allowDefault) {
                return false;
            }
        }
        return true;
    }

    // Build a map of ELRs to dimensional information:
    //   { elr: 
    //      { dimensionQName: 
    //          { 
    //              allowDefault: true, 
    //              members: { 
    //                  memberQName: true
    //              } 
    //          } 
    //      } 
    //   } 
    //
    //   Note that all dimensional information (other than dimension defaults) is
    //   inferred from the presentation tree, rather than definitional/dimensional
    //   relationships.  This assumes that the presentation follows SEC/EFM rules.
    //   Using dimensional relationships would require assuming a correspondence
    //   between presentation and dimensional ELRs.
    //
    _buildDimensionMap() {
        const groups = this.report.relationshipGroups("pres");
        this.dimensionMap = {};
        for (const elr of groups) {
            this.dimensionMap[elr] = {};
            for (const root of this.report.relationshipGroupRoots("pres", elr)) {
                this.buildDimensionMapFromSubTree("pres", elr, null, root);
            }
        }
    }

    buildDimensionMapFromSubTree(arcrole, elr, dimension, conceptName) {
        const c = this.report.getConcept(conceptName);
        if (c.isTypedDimension()) {
            this.dimensionMap[elr][conceptName] = { typed: true };
            return
        }
        else if (c.isExplicitDimension()) {
            dimension = conceptName;
            this.dimensionMap[elr][dimension] = { members: {}, allowDefault: false};
        }
        var children = this.report.getChildRelationships(conceptName, arcrole);
        if (!(elr in children)) {
            return
        }
        for (var rel of children[elr]) {
            if (dimension) {
                if (this.report.dimensionDefault(dimension) == rel.t) {
                    this.dimensionMap[elr][dimension].allowDefault = true;
                }
                else {
                    this.dimensionMap[elr][dimension].members[rel.t] = true;
                }
            }
            this.buildDimensionMapFromSubTree(arcrole, elr, dimension, rel.t);
        }
    }

    // Returns a list of presentation groups that this fact participates in
    groupsForFact(fact) {
        const factGroups = [];
        for (const group of this._elrsForConcept(fact.conceptName())) {
            if (this.factInGroup(fact, group)) {
                factGroups.push({ elr: group, fact: this.sectionFacts[group][0], report: this.report});
            }
        }
        return factGroups;
    }

    hasOutline() {
        return Object.keys(this.sectionFacts).length > 0;
    }

    sortedSections() {
        const sections = Object.keys(this.sectionFacts);
        const re = /\(parenthetical\)\s*$/i;
        const filteredSections = sections.filter(s => !re.test(this.report.getRoleLabelOrURI(s)));
        return filteredSections
            .sort((a, b) => this.report.getRoleLabelOrURI(a).localeCompare(this.report.getRoleLabelOrURI(b)))
            .map(elr => ({ report: this.report, firstFact: this.sectionFacts[elr][0], facts: this.sectionFacts[elr], elr }));
    }
}
