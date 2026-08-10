// See COPYRIGHT.md for copyright information

import { ReportSet } from "./reportset.js";
import { TestInspector } from "./test-utils.js";

/* Text block values may arrive inline in the taxonomy data, as they always have,
 * or in a second script tag that the startup path never parses.  Both shapes are
 * supported permanently, so every behavioural assertion here is made twice - once
 * per shape - and the two are required to agree.
 */

const TEXT_BLOCK_VALUE = '<p>Some <b>escaped</b> markup</p><p>and a second block</p>';
const PLAIN_VALUE = "1000";

const CONCEPTS = {
    "eg:TextBlock": { "labels": { "std": { "en": "Text block concept" } }, "t": true },
    "eg:Plain": { "labels": { "std": { "en": "Plain concept" } } },
};

function inlineReportSet(facts) {
    const reportSet = new ReportSet({
        "prefixes": { "eg": "http://www.example.com" },
        "concepts": CONCEPTS,
        "facts": facts,
    });
    reportSet.setIXNodeMap(ixNodeMapFor(facts));
    return reportSet;
}

/*
 * The same report with every non-nil text block value moved into the sidecar,
 * which is what the generator emits.  The reader is a jest mock so that tests can
 * assert on when - and how often - the sidecar is read.
 */
function deferredReportSet(facts, reader) {
    const sidecar = {};
    const remaining = {};
    for (const [id, factData] of Object.entries(facts)) {
        const deferred = factData.a.c === "eg:TextBlock" && typeof factData.v === "string";
        remaining[id] = { ...factData };
        if (deferred) {
            sidecar[`0-${id}`] = factData.v;
            delete remaining[id].v;
        }
    }
    reader.mockReturnValue(JSON.stringify(sidecar));

    const reportSet = new ReportSet({
        "prefixes": { "eg": "http://www.example.com" },
        "concepts": CONCEPTS,
        "facts": remaining,
    });
    reportSet.setDeferredValueReader(reader);
    reportSet.setIXNodeMap(ixNodeMapFor(remaining));
    return reportSet;
}

function ixNodeMapFor(facts) {
    return Object.fromEntries(Object.keys(facts).map(id => [id, { "escaped": true }]));
}

const TEXT_BLOCK_FACTS = {
    "tb": { "a": { "c": "eg:TextBlock" }, "v": TEXT_BLOCK_VALUE },
    "plain": { "a": { "c": "eg:Plain" }, "v": PLAIN_VALUE },
    "nilTb": { "a": { "c": "eg:TextBlock" }, "v": null },
};

var insp = new TestInspector();
beforeAll(() => insp.i18nInit());

describe("Inline values (metadata as it has always been emitted)", () => {
    test("the sidecar is never consulted, even if a reader is present", () => {
        const reader = jest.fn();
        const reportSet = inlineReportSet(TEXT_BLOCK_FACTS);
        reportSet.setDeferredValueReader(reader);

        expect(reportSet.getItemById("0-tb").value()).toBe(TEXT_BLOCK_VALUE);
        expect(reportSet.getItemById("0-plain").value()).toBe(PLAIN_VALUE);
        expect(reader).not.toHaveBeenCalled();
    });
});

describe("Deferred values (values in a second script tag)", () => {
    test("a text block value resolves from the sidecar", () => {
        const reader = jest.fn();
        const reportSet = deferredReportSet(TEXT_BLOCK_FACTS, reader);

        expect(reportSet.getItemById("0-tb").value()).toBe(TEXT_BLOCK_VALUE);
    });

    test("nothing reads the sidecar until a deferred value is asked for", () => {
        const reader = jest.fn();
        const reportSet = deferredReportSet(TEXT_BLOCK_FACTS, reader);

        // Building every fact, and reading an inline value, must not touch it.
        expect(reportSet.getItemById("0-plain").value()).toBe(PLAIN_VALUE);
        expect(reader).not.toHaveBeenCalled();

        reportSet.getItemById("0-tb").value();
        expect(reader).toHaveBeenCalledTimes(1);
    });

    test("the sidecar is parsed once however many values are read", () => {
        const reader = jest.fn();
        const reportSet = deferredReportSet(TEXT_BLOCK_FACTS, reader);

        reportSet.getItemById("0-tb").value();
        reportSet.getItemById("0-tb").value();
        reportSet.getItemById("0-tb").readableValue();
        expect(reader).toHaveBeenCalledTimes(1);
    });

    test("a nil text block still reads as nil, and needs no sidecar", () => {
        const reader = jest.fn();
        const reportSet = deferredReportSet(TEXT_BLOCK_FACTS, reader);
        const fact = reportSet.getItemById("0-nilTb");

        expect(fact.isNil()).toBe(true);
        expect(fact.value()).toBeNull();
        expect(reader).not.toHaveBeenCalled();
    });

    test("an absent sidecar resolves to undefined rather than throwing", () => {
        const reportSet = deferredReportSet(TEXT_BLOCK_FACTS, jest.fn());
        reportSet.setDeferredValueReader(() => null);

        expect(reportSet.getItemById("0-tb").value()).toBeUndefined();
    });

    test("values are keyed by source report, so IDs may repeat across a document set", () => {
        const reportSet = new ReportSet({
            "prefixes": { "eg": "http://www.example.com" },
            "sourceReports": [
                { "targetReports": [ { "concepts": CONCEPTS, "facts": { "tb": { "a": { "c": "eg:TextBlock" } } } } ] },
                { "targetReports": [ { "concepts": CONCEPTS, "facts": { "tb": { "a": { "c": "eg:TextBlock" } } } } ] },
            ],
        });
        reportSet.setDeferredValueReader(() => JSON.stringify({
            "0-tb": "<p>first report</p>",
            "1-tb": "<p>second report</p>",
        }));
        reportSet.setIXNodeMap({ "0-tb": { "escaped": true }, "1-tb": { "escaped": true } });

        expect(reportSet.getItemById("0-tb").value()).toBe("<p>first report</p>");
        expect(reportSet.getItemById("1-tb").value()).toBe("<p>second report</p>");
    });
});

describe("The two shapes agree", () => {
    test.each([
        [ "value", f => f.value() ],
        [ "readableValue", f => f.readableValue() ],
        [ "readableValueHTML", f => f.readableValueHTML().outerHTML ],
        [ "isNil", f => f.isNil() ],
    ])("%s is identical for an inline and a deferred text block", (name, read) => {
        const inline = inlineReportSet(TEXT_BLOCK_FACTS).getItemById("0-tb");
        const deferred = deferredReportSet(TEXT_BLOCK_FACTS, jest.fn()).getItemById("0-tb");

        expect(read(deferred)).toEqual(read(inline));
    });

    test("readableValue renders the text block rather than its markup", () => {
        const deferred = deferredReportSet(TEXT_BLOCK_FACTS, jest.fn()).getItemById("0-tb");

        expect(deferred.readableValue()).toBe("Some escaped markup and a second block");
    });
});
