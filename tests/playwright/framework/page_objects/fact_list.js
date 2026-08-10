import { expect } from '@playwright/test';
import { Button } from '../core_elements.js';

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

    #rowTitles() {
        return this.#viewerPage.page.locator('xpath=' + ROW_XPATH).locator('.title');
    }

    async getRowLabels() {
        return this.#rowTitles().allTextContents();
    }

    async assertRowLabels(expectedLabels) {
        this.#viewerPage.log(
            `Asserting the fact list holds ${expectedLabels.length} rows`);
        await expect(this.#rowTitles()).toHaveText(expectedLabels);
    }
}

export class FactListRow extends Button {
    constructor(viewerPage, label) {
        const rowXPath = `${ROW_XPATH}[.//*[contains(@class,"title")]` +
            `[normalize-space()="${label}"]]`;
        super(viewerPage, rowXPath, `Fact list row "${label}"`);
        this.tags = new RowTags(viewerPage, this.locator, label);
    }
}

export class RowTags {
    #viewerPage;
    #row;
    #label;

    constructor(viewerPage, row, label) {
        this.#viewerPage = viewerPage;
        this.#row = row;
        this.#label = label;
    }

    #tags() {
        return this.#row.locator('.block-list-item-tags > div');
    }

    async getTags() {
        await expect(this.#row).toBeAttached();
        return this.#tags().allTextContents();
    }

    async assertTags(expectedTags) {
        this.#viewerPage.log(
            `Asserting the tags on fact list row "${this.#label}" are ` +
            `[${expectedTags}]`);
        // An empty list would also match a row that has not been built yet.
        await expect(this.#row).toBeAttached();
        await expect(this.#tags()).toHaveText(expectedTags);
    }
}
