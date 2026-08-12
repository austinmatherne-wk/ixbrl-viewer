import { ViewerPage } from '../framework/viewer_page.js';

jest.setTimeout(60000);

const RECALC_STYLE_COUNT_CEILING = 616;

async function getRecalcStyleCount(client) {
    const { metrics } = await client.send('Performance.getMetrics');
    const metric = metrics.find(metric => metric.name === 'RecalcStyleCount');
    if (metric === undefined) {
        throw new Error('Chrome did not report RecalcStyleCount');
    }
    return metric.value;
}

async function armLoaderRemovalCapture(page, client) {
    let resolveCapture;
    let rejectCapture;
    let timeout;
    let onPaused;
    await client.send('Debugger.enable');

    const capture = new Promise((resolve, reject) => {
        resolveCapture = resolve;
        rejectCapture = reject;
    });
    capture.catch(() => {});

    const cleanup = async () => {
        clearTimeout(timeout);
        client.off('Debugger.paused', onPaused);
        await client.send('Debugger.disable').catch(() => {});
    };
    timeout = setTimeout(async () => {
        await cleanup();
        rejectCapture(new Error(
            'Loader removal was not observed within 30 seconds'));
    }, 30000);

    onPaused = async () => {
        try {
            const count = await getRecalcStyleCount(client);
            await client.send('Debugger.resume');
            await cleanup();
            resolveCapture(count);
        }
        catch (error) {
            await client.send('Debugger.resume').catch(() => {});
            await cleanup();
            rejectCapture(error);
        }
    };
    client.once('Debugger.paused', onPaused);

    try {
        await page.evaluateOnNewDocument(() => {
            if (window.top !== window) {
                return;
            }
            let loaderObserved = false;
            const observer = new MutationObserver(() => {
                if (document.querySelector('#ixv .loader') !== null) {
                    loaderObserved = true;
                }
                else if (loaderObserved) {
                    observer.disconnect();
                    // Pause before timer-scheduled post-load generators can start.
                    debugger;
                }
            });
            observer.observe(document, { childList: true, subtree: true });
        });
    }
    catch (error) {
        await cleanup();
        rejectCapture(error);
        throw error;
    }

    return { capture };
}

describe('absolute-position highlighting:', () => {
    let viewerPage;

    beforeEach(async () => {
        viewerPage = new ViewerPage();
        await viewerPage.buildPage();
    });

    afterEach(async () => {
        await viewerPage.tearDown();
    });

    test('verify absolute position wrappers are correctly classified', async () => {
        await viewerPage.navigateToViewer('absolute_position_highlighting.zip');
        await viewerPage.page.waitForSelector('#ixv.post-processing-complete');

        expect(await viewerPage.docFrame.countElements('.ixbrl-contains-absolute')).toEqual(100);
        expect(await viewerPage.docFrame.countElements('.ixbrl-no-highlight')).toEqual(100);
        expect(await viewerPage.docFrame.countElements('.ixbrl-sub-element')).toEqual(10000);
    });

    test('caps style recalculations while classifying wrappers', async () => {
        const client = await viewerPage.page.createCDPSession();
        await client.send('Performance.enable');
        const { capture: atLoaderRemoval } = await armLoaderRemovalCapture(
            viewerPage.page, client);

        await viewerPage.navigateToViewer('absolute_position_highlighting.zip');

        // On macOS 26 with Chrome 151.0.7922.110, five batched runs
        // measured 18-19 recalculations at loader removal and 120-121 after
        // startup completed. Interleaved controls measured 9,917-9,918 and
        // 10,019-10,020 respectively. The ceiling preserves the cross-platform
        // margin already exercised by the heavier predecessor fixture while
        // still detecting reinterleaving by more than an order of magnitude.
        expect(await atLoaderRemoval)
            .toBeLessThanOrEqual(RECALC_STYLE_COUNT_CEILING);

        // Include both independent post-load generators in the full-startup
        // measurement so a later recalculation burst cannot escape the guard.
        await viewerPage.page.waitForSelector(
            '#ixv.post-processing-complete #inspector.search-ready');

        expect(await getRecalcStyleCount(client))
            .toBeLessThanOrEqual(RECALC_STYLE_COUNT_CEILING);
    });
});
