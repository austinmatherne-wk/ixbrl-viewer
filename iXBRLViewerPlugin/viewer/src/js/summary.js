// See COPYRIGHT.md for copyright information

export const DIMENSIONS_KEY = "dimensions";
export const MEMBERS_KEY = "members";
export const PRIMARY_ITEMS_KEY = "primaryItems";
export const TOTAL_KEY = "total";


class TagCounter {
    constructor() {
        this._dimensions = new Set();
        this._members = new Set();
        this._primaryItems = new Set();
    }

    addDimension(dimension) {
        this._dimensions.add(dimension);
    }

    addMember(member) {
        this._members.add(member);
    }

    addPrimaryItem(primaryItem) {
        this._primaryItems.add(primaryItem);
    }

    getCounts() {
        return {
            [DIMENSIONS_KEY]: this._dimensions.size,
            [MEMBERS_KEY]: this._members.size,
            [PRIMARY_ITEMS_KEY]: this._primaryItems.size,
            [TOTAL_KEY]: this._dimensions.size + this._members.size + this._primaryItems.size
        }
    }
}

class LocalDocuments {
    constructor() {
        this._documentsByType = {
            'inline': new Set(),
            'schema': new Set(),
            'calcLinkbase': new Set(),
            'defLinkbase': new Set(),
            'labelLinkbase': new Set(),
            'presLinkbase': new Set(),
            'refLinkbase': new Set(),
            'unrecognizedLinkbase': new Set(),
        };
    }

    addDocument(document, documentTypes) {
        for (const documentType of documentTypes) {
            if (!(documentType in this._documentsByType)) {
                throw new Error(`Document ${document} with unrecognized type ${documentType}.`);
            }
            this._documentsByType[documentType].add(document);
        }
    }

    getDocuments() {
        const sortedDocuments = {};
        for (const [documentType, documents] of Object.entries(this._documentsByType)) {
            sortedDocuments[documentType] = [...documents].sort();
        }
        return sortedDocuments;
    }
}

export class DocumentSummary {
    constructor(reportSet) {
        this._reportSet = reportSet;
    }

    _getTagCounter(tagCounts, element) {
        const colonIndex = element.indexOf(":");
        if (colonIndex === -1) {
            throw new Error(`Element ${element} is not a concept.`);
        }
        const prefix = element.substring(0, colonIndex);
        if (!tagCounts.has(prefix)) {
            tagCounts.set(prefix, new TagCounter());
        }
        return tagCounts.get(prefix);
    }

    _buildTagCounts() {
        const tagCounts = new Map();
        for (const fact of this._reportSet.facts()) {
            let counter = this._getTagCounter(tagCounts, fact.conceptName());
            counter.addPrimaryItem(fact.conceptName());
            for (const [dimension, member] of Object.entries(fact.dimensions())) {
                counter = this._getTagCounter(tagCounts, dimension);
                counter.addDimension(dimension);

                const dimensionConcept = fact.report.getConcept(dimension);
                if (!dimensionConcept.hasDefinition) {
                    console.log("Missing definition for dimension: " + dimension);
                }
                else if (dimensionConcept.isTypedDimension()) {
                    const typedDomainElement = dimensionConcept.typedDomainElement();
                    if (typedDomainElement) {
                        counter = this._getTagCounter(tagCounts, typedDomainElement);
                        counter.addMember(typedDomainElement);
                    }
                } 
                else {
                    counter = this._getTagCounter(tagCounts, member);
                    counter.addMember(member);
                }
            }
        }
        this._tagCounts = new Map(
            [...tagCounts].map(([k, v]) => [k, v.getCounts()])
        );
    }

    _buildLocalFileSummary() {
        this._localFileSummary = new LocalDocuments();
        for (const [document, documentTypes] of this._reportSet.reports.flatMap(r => Object.entries(r.localDocuments()))) {
            this._localFileSummary.addDocument(document, documentTypes);
        }
    }

    totalFacts() {
        if (this._totalFacts === undefined) {
            this._totalFacts = this._reportSet.facts().length;
        }
        return this._totalFacts;
    }

    hiddenFacts() {
        if (this._hiddenFacts === undefined) {
            this._hiddenFacts = this._reportSet.facts().filter(f => f.isHidden()).length;
        }
        return this._hiddenFacts;
    }

    mandatoryFacts() {
        if (this._mandatoryFacts === undefined) {
            this._mandatoryFacts = this._reportSet.facts().filter(f => f.isMandatory()).length;
        }
        return this._mandatoryFacts;
    }

    tagCounts() {
        if (this._tagCounts === undefined) {
            this._buildTagCounts();
        }
        return this._tagCounts;
    }

    getLocalDocuments() {
        if (this._localFileSummary === undefined) {
            this._buildLocalFileSummary();
        }
        return this._localFileSummary.getDocuments()
    }


    /**
     * @return {Array[String]} Report set's list of software credit text values.
     */
    getSoftwareCredits() {
        return this._reportSet.getSoftwareCredits();
    }
}
