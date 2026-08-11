import { ViewerPage } from '../framework/viewer_page.js';

jest.setTimeout(60000);

const VIEWER_DATA_SCRIPT_TYPE = 'application/x.ixbrl-viewer+json';
const TEXT_BLOCK_VALUES_SCRIPT_TYPE = 'application/x.ixbrl-viewer-textblocks+json';

// The fixture's text block, as the filer wrote it and as the viewer reduces it
// to plain text.  A missing value renders as an empty cell and logs nothing, so
// these have to be asserted rather than merely watched for errors.
const TEXT_BLOCK_HTML =
    '<p>Policies <b>alpha</b> &amp; beta</p><p>Second &lt;paragraph&gt;</p>';
const TEXT_BLOCK_TEXT = 'Policies alpha & beta Second <paragraph>';

// Where the loaded viewer holds the value of the text block fact.  Asserting
// this is what stops both cases below from silently testing the same shape.
async function metadataShape(viewerPage) {
    return await viewerPage.page.evaluate((dataType, sidecarType) => {
        const scripts = Array.from(document.body.children)
            .filter(e => e.tagName.toUpperCase() === 'SCRIPT');
        const taxonomyData = JSON.parse(scripts
            .find(e => e.getAttribute('type') === dataType)
            .innerHTML);
        const fact = taxonomyData
            .sourceReports[0].targetReports[0].facts['text-block-html'];
        return {
            sidecarScriptTags: scripts
                .filter(e => e.getAttribute('type') === sidecarType).length,
            valueHeldInline: fact.v !== undefined,
        };
    }, VIEWER_DATA_SCRIPT_TYPE, TEXT_BLOCK_VALUES_SCRIPT_TYPE);
}

async function assertTextBlocksRender(viewerPage, viewerName, expectedShape) {
    const detailsPanel = viewerPage.factDetailsPanel;
    const dialog = viewerPage.textBlockDialog;

    // The fixture's three facts are visited in document order, starting with
    // the nil text block, which is in the hidden section
    await viewerPage.navigateToGeneratedViewer(viewerName, '#f-text-block-nil');
    expect(await metadataShape(viewerPage)).toEqual(expectedShape);

    // A nil text block is the one the generator must leave inline: the viewer
    // reads nil-ness off the value the fact holds
    await detailsPanel.concept.assertText(
        'Commitments and Contingencies Disclosure [Text Block]');
    await detailsPanel.factValue.assertText('nil');

    // The value cell, which renders a text block as plain text
    await detailsPanel.nextFact.select();
    await detailsPanel.concept.assertText(
        'Significant Accounting Policies [Text Block]');
    await detailsPanel.factValue.assertText(TEXT_BLOCK_TEXT);

    // The text block dialog, in both of its views
    await detailsPanel.expandTextBlock.select();
    await dialog.assertHTML(TEXT_BLOCK_HTML);
    await dialog.showTextOnly.select();
    await dialog.assertText(TEXT_BLOCK_TEXT);
    await dialog.dismiss.select();

    // And a fact that is not a text block, which is never deferred
    await detailsPanel.nextFact.select();
    await detailsPanel.concept.assertText('Document Type');
    await detailsPanel.factValue.assertText('10-K');
}

describe('ixbrl-viewer', () => {
    let viewerPage;

    beforeEach(async () => {
        viewerPage = new ViewerPage();
        await viewerPage.buildPage();
    })

    afterEach(async () => {
        await viewerPage.tearDown();
    });

    test('Text Blocks - values in a second script tag', async () => {
        await assertTextBlocksRender(viewerPage, 'text_blocks', {
            sidecarScriptTags: 1,
            valueHeldInline: false,
        });
    });

    // Viewers generated before text block values moved out carry them inline,
    // and have to go on working.  Nothing else in either suite tells the two
    // shapes apart, so this is the only guard on that.
    test('Text Blocks - values inline in the metadata', async () => {
        await assertTextBlocksRender(viewerPage, 'text_blocks_inline', {
            sidecarScriptTags: 0,
            valueHeldInline: true,
        });
    });
});
