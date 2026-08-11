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
        // so the label is what a user - and puppeteer - can click.
        this.showTextOnly = new Button(
                this.#viewerPage,
                `${DIALOG}//label[contains(@class,"checkbox")][.//input[@id="text-block-viewer-plain-text"]]`,
                'Show text only');
        this.dismiss = new Button(
                this.#viewerPage,
                `${DIALOG}//button[text()="Dismiss"]`,
                'Dismiss text block');
    }

    async #contentFrame() {
        const iframe = await this.#viewerPage.page.waitForSelector(
            '#dialog-container #text-block-viewer-iframe', { visible: true });
        return await iframe.contentFrame();
    }

    // Asserts the markup the dialog rendered, which is the fact's value as the
    // filer wrote it.
    async assertHTML(expectedHTML) {
        this.#viewerPage.log(
            `Asserting text block dialog HTML equals "${expectedHTML}"`);
        const frame = await this.#contentFrame();
        expect(await frame.evaluate(() => document.body.innerHTML))
            .toEqual(expectedHTML);
    }

    async assertText(expectedText) {
        this.#viewerPage.log(
            `Asserting text block dialog text equals "${expectedText}"`);
        const frame = await this.#contentFrame();
        expect(await frame.evaluate(() => document.body.textContent))
            .toEqual(expectedText);
    }
}
