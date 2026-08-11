import fs from 'fs';
import puppeteer from 'puppeteer-core';
import { DocFrame } from './page_objects/doc_frame.js';
import { FactDetailsPanel } from './page_objects/fact_details_panel.js';
import { PuppeteerScreenRecorder } from 'puppeteer-screen-recorder';
import { Search } from './page_objects/search_panel.js';
import { SectionList } from './page_objects/section_list.js';
import { TextBlockDialog } from './page_objects/text_block_dialog.js';
import { Toolbar } from './page_objects/toolbar.js';

export class ViewerPage {
    browser;
    page;
    docFrame;
    factDetailsPanel;
    search;
    sectionList;
    textBlockDialog;
    toolbar;

    #artifactDirectory = './tests/puppeteer/artifacts';
    #cleanedTestName = expect.getState()
        .currentTestName
        .replaceAll(/[^a-zA-Z0-9-]/g, '_');
    #isCi = process.env.CI === 'true';
    #logMsgs = [];
    #recorder;

    async buildPage() {
        // Launch the browser
        this.browser = await puppeteer.launch({
            channel: 'chrome',
            headless: this.#isCi ? 'new' : false,
            args: [`--window-size=1440,900`],
            defaultViewport: { width: 1440, height: 821 },
        });
        this.page = await this.browser.newPage();
        this.docFrame = new DocFrame(this);
        this.factDetailsPanel = new FactDetailsPanel(this);
        this.search = new Search(this);
        this.sectionList = new SectionList(this);
        this.textBlockDialog = new TextBlockDialog(this);
        this.toolbar = new Toolbar(this);
        this.#recorder = new PuppeteerScreenRecorder(this.page);

        // Set up the video recording
        const videoDir = `${this.#artifactDirectory}/video`;
        const videoPath = `${videoDir}/${this.#cleanedTestName}.mp4`;
        await this.#createDirectory(videoDir);
        await this.#recorder.start(videoPath);

        this.streamLogsToFile(
            `${this.#artifactDirectory}/${this.#cleanedTestName}_chrome_debug.log`);
    }

    log(message) {
        this.#logMsgs.push(message);
    }

    async navigateToViewer(filingZipName, args = '') {
        await this.navigateToGeneratedViewer(
            filingZipName.replace('.zip', ''), args);
    }

    // Navigates to a viewer by the name it was generated under, which is not
    // always the name of a test filing: a filing can be generated into more
    // than one viewer.
    async navigateToGeneratedViewer(viewerName, args = '') {
        const url = `http://localhost:8080/tests/puppeteer/artifacts/generated_output/${viewerName}.htm${args}`;
        this.log(`Navigating to ${url}`);
        await this.page.goto(url, { waitUntil: 'networkidle0' });
        await this.page.waitForSelector(
            'xpath/' + '//*[contains(@class, "loading")]',
            { visible: false, hidden: true });
    }

    async tearDown() {
        console.log(this.#logMsgs.join('\n'));
        await this.#recorder.stop();
        await this.browser.close();
    }

    async #createDirectory(path) {
        if (!fs.existsSync(path)) {
            fs.mkdirSync(path, { recursive: true });
        }
    }

    streamLogsToFile(filename) {
        const append = (content) => fs.appendFile(filename, `${content}\n`,
            function(err) {
                if (err) throw err;
            });

        // Delete the file if it already exists
        fs.rmSync(filename, { force: true });

        // Pipe the log messages to the file
        this.page.on('console', msg => append(
            `${msg.type().substr(0, 3).toUpperCase()} ${msg.text()}`))
            .on('pageerror', function(err) {
                let value = err.toString();
                append(value);
            })
            .on('response', response => append(
                `${response.status()} ${response.url()}`))
            .on('requestfailed', request => append(
                `${request.failure().errorText} ${request.url()}`));
    }

    async waitMilliseconds(milliseconds) {
        return new Promise(function(resolve) {
            setTimeout(resolve, milliseconds);
        });
    }
}
