// See COPYRIGHT.md for copyright information

import lunr from 'lunr'

function newSearchFieldCache() {
    return { concepts: new Map(), typed: new Map(), members: new Map() };
}

function cachedConceptSearchFields(fact, cache) {
    const name = fact.conceptName();
    let fields = cache.concepts.get(name);
    if (fields === undefined) {
        const wider = fact.widerConcepts();
        fields = {
            concept: fact.conceptQName().localname,
            doc: fact.getLabel("doc"),
            std: fact.getLabel("std"),
            ref: fact.concept().referenceValuesAsString(),
        };
        if (wider.length > 0) {
            fields.widerConcept = fact.report.qname(wider[0]).localname;
            fields.widerLabel = fact.report.getLabel(wider[0], "std");
            fields.widerDoc = fact.report.getLabel(wider[0], "doc");
        }
        cache.concepts.set(name, fields);
    }
    return fields;
}

function cachedIsTypedDimension(report, name, cache) {
    let typed = cache.typed.get(name);
    if (typed === undefined) {
        typed = report.getConcept(name).isTypedDimension();
        cache.typed.set(name, typed);
    }
    return typed;
}

function cachedMemberStdLabel(report, name, cache) {
    if (!cache.members.has(name)) {
        cache.members.set(name, report.getLabel(name, "std"));
    }
    return cache.members.get(name);
}

function labelWithDimensions(fact, stdLabel, cache) {
    let l = stdLabel;
    const dims = fact.dimensions();
    for (const d in dims) {
        if (cachedIsTypedDimension(fact.report, d, cache)) {
            if (dims[d] !== null) {
                l += " " + dims[d];
            }
        }
        else {
            l += " " + cachedMemberStdLabel(fact.report, dims[d], cache);
        }
    }
    return l;
}

export class ReportSearch {
    constructor(reportSet) {
        this._reportSet = reportSet;
        this.ready = false;
    }

    * buildSearchIndex(doneCallback) {
        var docs = [];
        var dims = {};
        var facts = this._reportSet.facts();
        this.periods = {};
        const cachesByReport = new WeakMap();
        // Add hidden facts to index later, so that they appear later in the
        // default search
        for (const hidden of [false, true]) {
            for (var i = 0; i < facts.length; i++) {
                var f = facts[i];
                if (f.isHidden() !== hidden) {
                    continue;
                }
                let cache = cachesByReport.get(f.report);
                if (cache === undefined) {
                    cache = newSearchFieldCache();
                    cachesByReport.set(f.report, cache);
                }
                const conceptDoc = cachedConceptSearchFields(f, cache);
                const p = f.period();
                var doc = { "id": f.vuid };
                doc.concept = conceptDoc.concept;
                doc.doc = conceptDoc.doc;
                doc.date = p.to();
                doc.startDate = p.from();
                doc.label = labelWithDimensions(f, conceptDoc.std, cache);
                doc.ref = conceptDoc.ref;
                if (conceptDoc.widerConcept !== undefined) {
                    doc.widerConcept = conceptDoc.widerConcept;
                    doc.widerLabel = conceptDoc.widerLabel;
                    doc.widerDoc = conceptDoc.widerDoc;
                }
                docs.push(doc);

                if (p) {
                    this.periods[p.key()] = p.toString();
                }

                if (i % 100 === 0) {
                    yield;
                }
            }
        }
        const builder = new lunr.Builder();
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


        for (const [i, doc] of docs.entries()) {
            builder.add(doc);
            if (i % 100 === 0) {
                yield;
            }
        }
        this._searchIndex = builder.build();
        this.ready = true;
        doneCallback();
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
