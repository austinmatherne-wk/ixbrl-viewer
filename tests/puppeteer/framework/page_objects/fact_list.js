import { Button, Element } from '../core_elements.js';

const CONTAINER_XPATH = '//*[@id="inspector"]//*[contains(@class,"facts-by-group")]';
const ROW_XPATH = `${CONTAINER_XPATH}//button[contains(@class,"fact-list-item")]`;

export class FactList {
    #viewerPage;

    constructor(viewerPage) {
        this.#viewerPage = viewerPage;
    }

    row(label) {
        return new FactListRow(this.#viewerPage, label);
    }

    async getRowLabels() {
        const rows = await this.#viewerPage.page.$$('xpath/' + ROW_XPATH);
        return await Promise.all(rows.map(
            row => row.$eval('.title', e => e.textContent)));
    }

    async assertRowLabels(expectedLabels) {
        this.#viewerPage.log(
            `Asserting the fact list holds ${expectedLabels.length} rows`);
        expect(await this.getRowLabels()).toEqual(expectedLabels);
    }
}

export class FactListRow extends Button {
    constructor(viewerPage, label) {
        const rowXPath = `${ROW_XPATH}[.//*[contains(@class,"title")]` +
            `[normalize-space()="${label}"]]`;
        super(viewerPage, rowXPath, `Fact list row "${label}"`);
        this.tags = new RowTags(viewerPage, rowXPath, label);
    }
}

export class RowTags {
    #viewerPage;
    #rowXPath;
    #label;

    constructor(viewerPage, rowXPath, label) {
        this.#viewerPage = viewerPage;
        this.#rowXPath = rowXPath;
        this.#label = label;
    }

    async getTags() {
        const row = await this.#viewerPage.page.waitForSelector(
            'xpath/' + this.#rowXPath);
        return await row.$$eval('.block-list-item-tags > div',
            tags => tags.map(t => t.textContent));
    }

    async assertTags(expectedTags) {
        this.#viewerPage.log(
            `Asserting the tags on fact list row "${this.#label}" are ` +
            `[${expectedTags}]`);
        expect(await this.getTags()).toEqual(expectedTags);
    }
}
