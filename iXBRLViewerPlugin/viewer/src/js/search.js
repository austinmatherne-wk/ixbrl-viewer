// See COPYRIGHT.md for copyright information

import lunr from 'lunr'

/* The indexed fields.  lunr reports and scores fields in declaration order. */
export const SEARCH_FIELDS = [
    'label',
    'concept',
    'startDate',
    'date',
    'doc',
    'ref',
    'widerLabel',
    'widerDoc',
    'widerConcept',
];

const INDEX_PIPELINE = [lunr.trimmer, lunr.stopWordFilter, lunr.stemmer];

function isPopulated(value) {
    return value !== null && value !== undefined && value !== '';
}

/*
 * lunr runs the index pipeline once per (document, field), but field strings
 * repeat heavily: facts share concepts, and every fact in a period shares its
 * two date strings.  This runs the pipeline once per distinct string instead.
 *
 * lunr.Pipeline.run's semantics are reproduced exactly, including the part that
 * reads like a bug: a stage's result is discarded only when it is null,
 * undefined or the empty *string*, so a token trimmed down to "" survives and
 * still counts towards the field's length.  Dropping those rescores every term
 * query.
 *
 * Two assumptions, both pinned by tests: no index pipeline stage looks at a
 * token's metadata (the field it came from lives there, and this drops it), and
 * the builder's metadata whitelist is empty (token positions live there too).
 */
function memoisingTokenizer() {
    const cache = new Map();
    return function (obj) {
        if (obj === null || obj === undefined) {
            return [];
        }
        const str = obj.toString();
        let terms = cache.get(str);
        if (terms === undefined) {
            let tokens = lunr.tokenizer(str);
            for (const stage of INDEX_PIPELINE) {
                const staged = [];
                for (let i = 0; i < tokens.length; i++) {
                    const result = stage(tokens[i], i, tokens);
                    if (result === null || result === undefined || result === '') {
                        continue;
                    }
                    if (Array.isArray(result)) {
                        staged.push(...result);
                    }
                    else {
                        staged.push(result);
                    }
                }
                tokens = staged;
            }
            terms = tokens.map(t => t.toString());
            cache.set(str, terms);
        }
        return terms.map(t => new lunr.Token(t, {}));
    };
}

/*
 * A field that no fact populates has no postings, so no query can match it, but
 * lunr charges every document a tokenizer call, a term frequency map and a field
 * vector for it, and the empty query walks it too.  A US filing leaves four of
 * the nine empty; an ESEF filing populates all nine.
 */
export function createIndexBuilder(docs) {
    const builder = new lunr.Builder();
    builder.tokenizer = memoisingTokenizer();
    builder.searchPipeline.add(lunr.stemmer);
    builder.ref('id');
    for (const field of SEARCH_FIELDS) {
        if (docs.some(doc => isPopulated(doc[field]))) {
            builder.field(field);
        }
    }
    return builder;
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
                    yield;
                }
            }
        }
        const builder = createIndexBuilder(docs);

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
        let rr;
        try {
            rr = this._searchIndex.search(s.searchString);
        }
        catch (e) {
            if (!(e instanceof lunr.QueryParseError)) {
                throw e;
            }
            /* An unparseable query, or a field name this index does not carry.
             * Reported as no matches, which is the state the search pane already
             * has for a query that finds nothing. */
            return [];
        }
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
