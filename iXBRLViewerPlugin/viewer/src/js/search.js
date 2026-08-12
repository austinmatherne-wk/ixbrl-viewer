// See COPYRIGHT.md for copyright information

import lunr from 'lunr'
import { ABLATE_SEARCH, perfAdd, perfCount, perfNow, perfSpan } from './perf.js';

export class ReportSearch {
    constructor(reportSet) {
        this._reportSet = reportSet;
        this.ready = false;
    }

    * buildSearchIndex() {
        /* Ticket 12's ceiling arms.  Returning here removes the whole inspector
         * half of the drain: no fact scan, no documents, no lunr, and no
         * onDone - so searchReady() never runs and the search box is never
         * enabled.  Unshippable by construction; see perf.js for why the ceiling
         * is what decides this ticket.  The volume counters are emitted as
         * explicit zeros rather than left missing, so a guard table can tell an
         * ablated arm from a broken run. */
        if (ABLATE_SEARCH === 'searchnoindex' || ABLATE_SEARCH === 'searchnoindexmsg') {
            perfCount('drain.search.factCount', 0);
            perfCount('drain.search.docsBuilt', 0);
            perfCount('drain.search.yields', 0);
            return;
        }
        const noLunr = ABLATE_SEARCH === 'searchnolunr';
        var docs = [];
        var dims = {};
        /* Uncached full scan over every report - ticket 10 counted the calls; this
         * prices the one the drain pays. */
        var facts = perfSpan('drain.search.facts', () => this._reportSet.facts());
        perfCount('drain.search.factCount', facts.length);
        this.periods = {};
        let acc = 0;
        /* Ticket 11: the drain's elapsed time exceeds the two passes' work by up
         * to half, and a yield is where that difference is spent - so the count is
         * the denominator the gap has to be divided by before it can be called a
         * per-slice scheduling cost rather than work. */
        let yields = 0;
        let t = perfNow();
        // Add hidden facts to index later, so that they appear later in the
        // default search
        for (const hidden of [false, true]) {
            for (var i = 0; i < facts.length; i++) {
                var f = facts[i];
                if (f.isHidden() !== hidden) {
                    continue;
                }
                var doc = { "id": f.vuid };
                var l = f.getLabel("std");
                doc.concept = f.conceptQName().localname;
                doc.doc = f.getLabel("doc");
                doc.date = f.periodTo();
                doc.startDate = f.periodFrom();
                var dims = f.dimensions();
                for (var d in dims) {
                    if (f.report.getConcept(d).isTypedDimension()) {
                        if (dims[d] !== null) {
                            l += " " + dims[d];
                        }
                    }
                    else {
                        l += " " + f.report.getLabel(dims[d], "std");
                    }
                }
                doc.label = l;
                doc.ref = f.concept().referenceValuesAsString();
                const wider = f.widerConcepts();
                if (wider.length > 0) {
                    doc.widerConcept = f.report.qname(wider[0]).localname;
                    doc.widerLabel = f.report.getLabel(wider[0], "std");
                    doc.widerDoc = f.report.getLabel(wider[0], "doc");
                }
                docs.push(doc);

                var p = f.period();
                if (p) {
                    this.periods[p.key()] = p.toString();
                }

                if (i % 100 === 0) {
                    acc += perfNow() - t;
                    yield;
                    yields++;
                    t = perfNow();
                }
            }
        }
        /* Term 1a: building the plain documents - label, dimension and reference
         * resolution per fact, before lunr sees anything. */
        perfAdd('drain.search.docs', acc + perfNow() - t);
        perfCount('drain.search.docsBuilt', docs.length);
        acc = 0;
        t = perfNow();
        /* Ticket 12's searchnolunr: the builder is never constructed, never fed
         * and never built.  Everything else in this loop - the iteration, the
         * yield every hundredth document - is the baseline's, because a cheaper
         * index structure would still have to walk the documents and would still
         * yield.  An arm that dropped the yield too would bill direction 3 for
         * scheduling it does not save. */
        let builder = null;
        if (!noLunr) {
            builder = new lunr.Builder();
            builder.pipeline.add(
              lunr.trimmer,
              lunr.stopWordFilter,
              lunr.stemmer
            )

            builder.searchPipeline.add(
              lunr.stemmer
            )

            builder.ref('id');
            builder.field('label');
            builder.field('concept');
            builder.field('startDate');
            builder.field('date');
            builder.field('doc');
            builder.field('ref');
            builder.field('widerLabel');
            builder.field('widerDoc');
            builder.field('widerConcept');
        }

        for (const [i, doc] of docs.entries()) {
            if (!noLunr) {
                builder.add(doc);
            }
            if (i % 100 === 0) {
                acc += perfNow() - t;
                yield;
                yields++;
                t = perfNow();
            }
        }
        /* Term 1b: tokenising and inverting.  Includes the builder's own setup
         * above, which is a fixed dozen field declarations. */
        perfAdd('drain.search.lunrAdd', acc + perfNow() - t);
        perfCount('drain.search.yields', yields);
        /* The stub answers every query with every document at score 0, which is
         * exactly what lunr 2.3.9 returns for the empty string - so doneCallback
         * still runs the startup query, still gets a non-empty result set and
         * still builds its SEARCH_PAGE_SIZE rows, and its span stays comparable
         * with the baseline's.  The ORDER is insertion order rather than lunr's,
         * which is why this arm is barred from the identity gate. */
        this._searchIndex = perfSpan('drain.search.lunrBuild', () => noLunr
            ? { search: () => docs.map(d => ({ ref: d.id, score: 0 })) }
            : builder.build());
        this.ready = true;
        /* searchReady / the startup query moved to runGenerator's onDone, so
         * they run after this generator completes — after the drained mark. */
    }

    visibilityFilter(s, item) {
        return (
            s.visibilityFilter.length == 0 ||
            s.visibilityFilter.includes('visible') && !item.isHidden() ||
            s.visibilityFilter.includes('hidden') && item.isHidden()
        )
    }

    periodFilter(s, item) {
        return (
            s.periodFilter.length == 0 ||
            s.periodFilter.some(p => item.period().key() === p)
        );
    }

    conceptTypeFilter(s, item) {
        return (
            s.conceptTypeFilter.length == 0 ||
            s.conceptTypeFilter.includes("numeric") && item.isNumeric() ||
            s.conceptTypeFilter.includes("text") && !item.isNumeric()
        );
    }

    dimensionTypeFilter(s, item) {
        const typed = s.dimensionTypeFilter.includes('typed');
        const explicit = s.dimensionTypeFilter.includes('explicit');
        const none = s.dimensionTypeFilter.includes('none');
        return (
            s.dimensionTypeFilter.length == 0 ||
            (none && !item.hasTypedDimension() && !item.hasExplicitDimension()) ||
            (typed && item.hasTypedDimension()) ||
            (explicit && item.hasExplicitDimension())
        )
    }

    factValueFilter(s, item) {
        return (
            s.factValueFilter.length == 0 ||
            (s.factValueFilter.includes('positive') && item.isPositive()) ||
            (s.factValueFilter.includes('negative') && item.isNegative())
        );
    }

    calculationsFilter(s, item) {
        const summation = s.calculationsFilter.includes('summation');
        const contributor = s.calculationsFilter.includes('contributor');
        const none = s.calculationsFilter.includes('none');
        return (
            s.calculationsFilter.length == 0 ||
            (none && !item.isCalculationSummation() && !item.isCalculationContributor()) ||
            (summation && item.isCalculationSummation()) ||
            (contributor && item.isCalculationContributor())
        );
    }

    namespacesFilter(s, item) {
        return (
            s.namespacesFilter.length == 0 ||
            s.namespacesFilter.some(p => item.getConceptPrefix() === p)
        );
    }

    dataTypesFilter(s, item) {
        return (
            s.dataTypesFilter.length == 0 ||
            s.dataTypesFilter.some(p => item.concept().dataType()?.name === p)
        );
    }

    unitsFilter(s, item) {
        return (
            s.unitsFilter.length == 0 ||
            s.unitsFilter.some(u => item.unit()?.value() === u)
        );
    }

    scalesFilter(s, item) {
        return (
            s.scalesFilter.length == 0 ||
            s.scalesFilter.some(x => item.scale() === Number(x))
        );
    }

    targetDocumentFilter(s, item) {
        return (
            s.targetDocumentFilter.length == 0 ||
            s.targetDocumentFilter.some(t => (item.targetDocument() ?? ':default') === t)
        );
    }

    mandatoryFactFilter(s, item) {
        const includeMandatory = s.mandatoryFactsFilter.includes('mandatory');
        const includeOther = s.mandatoryFactsFilter.includes('other');
        return (
            s.mandatoryFactsFilter.length === 0 ||
            (item.isMandatory() && includeMandatory) ||
            (!item.isMandatory() && includeOther)
        );
    }

    search(s) {
        if (!this.ready) {
            return;
        }
        const rr = this._searchIndex.search(s.searchString);
        const results = []
        const searchIndex = this;

        const filters = [
            this.visibilityFilter,
            this.periodFilter,
            this.conceptTypeFilter,
            this.dimensionTypeFilter,
            this.factValueFilter,
            this.calculationsFilter,
            this.namespacesFilter,
            this.dataTypesFilter,
            this.unitsFilter,
            this.scalesFilter,
            this.targetDocumentFilter,
            this.mandatoryFactFilter
        ];

        rr.forEach((r,_) => {
                const item = searchIndex._reportSet.getItemById(r.ref);
                if (filters.every(f => f(s, item))) {
                    results.push({
                        "fact": item,
                        "score": r.score
                    });
                }
            }
        );
        return results;
    }
}
