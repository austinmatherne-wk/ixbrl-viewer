// See COPYRIGHT.md for copyright information

import lunr from 'lunr'
import { SEARCH_FIELDS, createIndexBuilder } from "./search.js"

/*
 * How the index was fed before the populated-field and memoised-tokenizer
 * changes.  Frozen here as the reference the new feed is asserted identical to.
 */
function baselineBuilder(docs) {
    const builder = new lunr.Builder();
    builder.pipeline.add(lunr.trimmer, lunr.stopWordFilter, lunr.stemmer);
    builder.searchPipeline.add(lunr.stemmer);
    builder.ref('id');
    for (const field of SEARCH_FIELDS) {
        builder.field(field);
    }
    return builder;
}

function build(builder, docs) {
    for (const doc of docs) {
        builder.add(doc);
    }
    return builder.build();
}

/*
 * Every query shape search() can issue.  The search box is passed to lunr raw,
 * so this is the whole of lunr's query language: terms, field scoping, presence,
 * wildcards, fuzziness and boosts.
 */
const QUERY_SHAPES = [
    '',
    'revenue',
    'cash equivalents',
    'label:revenue',
    'reven*',
    'revenue~1',
    '+cash -flow',
    'total^10 assets',
    '2019',
];

function results(index, queryString) {
    return index.search(queryString).map(r => ({
        ref: r.ref,
        score: Math.round(r.score * 1e6) / 1e6,
    }));
}

/*
 * A US filing: references and the three wider-concept fields are an ESEF
 * concern and no fact populates them, and these facts are all instants so no
 * fact has a start date.  Concepts and dates repeat, and the values carry
 * stop words and punctuation-only tokens.
 */
const usDocs = [
    {
        id: 'us1',
        label: 'Cash and Cash Equivalents',
        concept: 'CashAndCashEquivalentsAtCarryingValue',
        startDate: null,
        date: 'Tue Jan 01 2019 00:00:00 GMT-0500',
    },
    {
        id: 'us2',
        label: 'Cash and Cash Equivalents',
        concept: 'CashAndCashEquivalentsAtCarryingValue',
        startDate: null,
        date: 'Tue Jan 01 2019 00:00:00 GMT-0500',
    },
    {
        id: 'us3',
        label: 'Total Revenue $ *** (unaudited)',
        concept: 'Revenues',
        startDate: null,
        date: 'Tue Jan 01 2019 00:00:00 GMT-0500',
    },
    {
        id: 'us4',
        label: 'Total assets of the entity',
        concept: 'Assets',
        startDate: null,
        date: 'Mon Jan 01 2018 00:00:00 GMT-0500',
    },
    {
        id: 'us5',
        label: 'Net cash flow from operations',
        concept: 'NetCashProvidedByUsedInOperatingActivities',
        startDate: null,
        date: 'Mon Jan 01 2018 00:00:00 GMT-0500',
    },
];

/* An ESEF filing: all nine fields populated on every fact. */
const esefDocs = usDocs.map((doc, i) => ({
    ...doc,
    id: `esef${i + 1}`,
    startDate: 'Mon Jan 01 2018 00:00:00 GMT-0500',
    doc: `${doc.label} — documentation label`,
    ref: 'IFRS 7 Paragraph 25 Disclosure',
    widerConcept: 'Assets',
    widerLabel: 'Total assets',
    widerDoc: 'The total of all assets',
}));

/* One fact populating a field the rest leave empty is enough to declare it. */
const mixedDocs = [
    ...usDocs,
    { ...usDocs[0], id: 'mixed1', ref: 'IFRS 7 Paragraph 25 Disclosure' },
];

const CORPORA = [
    ['a US filing, four fields empty', usDocs],
    ['an ESEF filing, all fields populated', esefDocs],
    ['a filing where one fact populates references', mixedDocs],
];

describe.each(CORPORA)("Cheaper index feed on %s", (_label, docs) => {
    const baseline = build(baselineBuilder(docs), docs);
    const index = build(createIndexBuilder(docs), docs);

    test.each(QUERY_SHAPES)("Query %p returns identical refs and scores", (queryString) => {
        expect(results(index, queryString)).toEqual(results(baseline, queryString));
    });

    test("Empty query returns every document in insertion order", () => {
        expect(index.search('').map(r => r.ref)).toEqual(docs.map(d => d.id));
    });
});

describe("Indexed field declaration", () => {
    test("A field no document populates is not declared", () => {
        const index = build(createIndexBuilder(usDocs), usDocs);
        expect(index.fields).toEqual(['label', 'concept', 'date']);
    });

    test("A field one document populates is declared", () => {
        const index = build(createIndexBuilder(mixedDocs), mixedDocs);
        expect(index.fields).toContain('ref');
    });

    test("Every field is declared when every field is populated", () => {
        const index = build(createIndexBuilder(esefDocs), esefDocs);
        expect(index.fields).toEqual(SEARCH_FIELDS);
    });
});

describe("Memoised tokenization", () => {
    test("A punctuation-only token is kept as an empty term, as lunr's own pipeline keeps it", () => {
        const tokenizer = createIndexBuilder(esefDocs).tokenizer;
        expect(tokenizer('revenue $').map(t => t.toString())).toEqual(['revenu', '']);
    });

    test("A repeated string is tokenized to the same terms as a first occurrence", () => {
        const tokenizer = createIndexBuilder(esefDocs).tokenizer;
        const first = tokenizer('Cash and Cash Equivalents').map(t => t.toString());
        expect(tokenizer('Cash and Cash Equivalents').map(t => t.toString())).toEqual(first);
    });

    test("The index pipeline is empty, so no stage can be added that needs a token's field", () => {
        const builder = createIndexBuilder(esefDocs);
        expect(builder.pipeline._stack).toEqual([]);
        expect(builder.tokenizer('Cash and Cash Equivalents')
            .every(t => Object.keys(t.metadata).length === 0)).toBe(true);
    });

    test("No token metadata is whitelisted, so dropping it is unobservable", () => {
        expect(createIndexBuilder(esefDocs).metadataWhitelist).toEqual([]);
    });
});
