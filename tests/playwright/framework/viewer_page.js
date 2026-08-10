import { expect } from '@playwright/test';
import { DocFrame } from './page_objects/doc_frame.js';
import { FactDetailsPanel } from './page_objects/fact_details_panel.js';
import { FactList } from './page_objects/fact_list.js';
import { Search } from './page_objects/search_panel.js';
import { SectionList } from './page_objects/section_list.js';
import { Toolbar } from './page_objects/toolbar.js';

export class ViewerPage {
    logs = [];

    constructor(page) {
        this.page = page;
        this.docFrame = new DocFrame(this);
        this.factDetailsPanel = new FactDetailsPanel(this);
        this.factList = new FactList(this);
        this.search = new Search(this);
        this.sectionList = new SectionList(this);
        this.toolbar = new Toolbar(this);

        page.on('console', msg => this.log(`${msg.type()} ${msg.text()}`))
            .on('pageerror', err => this.log(err.toString()))
            .on('response', response => this.log(`${response.status()} ${response.url()}`))
            .on('requestfailed', request => this.log(`${request.failure().errorText} ${request.url()}`));
    }

    log(message) {
        this.logs.push(message);
    }

    async navigateToViewer(filingZipName, args = '') {
        const url = this.#viewerUrl(filingZipName, args);
        this.log(`Navigating to ${url}`);
        await this.page.goto(url);
        await this.waitForViewerLoaded();
    }

    /*
     * Starts a navigation and resolves as soon as the document has been parsed,
     * before the viewer has finished loading.  Use this, followed by
     * waitForViewerLoaded(), when a test needs to observe the viewer part way
     * through startup.
     */
    async beginNavigateToViewer(filingZipName, args = '') {
        const url = this.#viewerUrl(filingZipName, args);
        this.log(`Navigating to ${url}`);
        await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    }

    async waitForViewerLoaded() {
        await expect(this.page.locator('#ixv')).toBeAttached();
        await expect(this.page.locator('#ixv .loader.loading')).toBeHidden();
        await expect(this.page.locator('#ixv')).toHaveClass(/post-processing-complete/);
        await expect(this.page.locator('#inspector')).toHaveClass(/search-ready/);
    }

    #viewerUrl(filingZipName, args) {
        const filingName = filingZipName.replace('.zip', '');
        return `/tests/playwright/artifacts/generated_output/${filingName}.htm${args}`;
    }
}
