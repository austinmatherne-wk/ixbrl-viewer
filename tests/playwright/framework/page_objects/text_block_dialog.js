import { expect } from '@playwright/test';
import { Button } from '../core_elements.js';

// Dialogs are cloned out of #dialog-templates into #dialog-container when they
// are shown, so every locator here is scoped to the container to avoid matching
// the hidden template instead.
const DIALOG = '//*[@id="dialog-container"]//*[contains(@class,"text-block-viewer")]';

export class TextBlockDialog {
    #viewerPage;

    constructor(viewerPage) {
        this.#viewerPage = viewerPage;

        // The checkbox itself is a zero-sized input behind a styled checkmark,
        // so the label is what a user (and Playwright) can click.
        this.showTextOnly = new Button(
                this.#viewerPage,
                `${DIALOG}//label[contains(@class,"checkbox")][.//input[@id="text-block-viewer-plain-text"]]`,
                'Show text only');
        this.dismiss = new Button(
                this.#viewerPage,
                `${DIALOG}//button[text()="Dismiss"]`,
                'Dismiss text block');
    }

    async #contentBody() {
        const iframe = this.#viewerPage.page.locator(
            '#dialog-container #text-block-viewer-iframe');
        await expect(iframe).toBeVisible();
        return iframe.contentFrame().locator('body');
    }

    // Asserts the markup the dialog rendered, which is the fact's value as the
    // filer wrote it.
    async assertHTML(expectedHTML) {
        this.#viewerPage.log(
            `Asserting text block dialog HTML equals "${expectedHTML}"`);
        await expect(await this.#contentBody())
            .toHaveJSProperty('innerHTML', expectedHTML);
    }

    async assertText(expectedText) {
        this.#viewerPage.log(
            `Asserting text block dialog text equals "${expectedText}"`);
        await expect(await this.#contentBody())
            .toHaveJSProperty('textContent', expectedText);
    }
}
