// See COPYRIGHT.md for copyright information

import lunr from 'lunr'
import { ABLATE_SEARCH, perfAdd, perfCount, perfNow, perfSpan } from './perf.js';

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
        const cachesByReport = new WeakMap();
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
            builder = createIndexBuilder(docs);
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
