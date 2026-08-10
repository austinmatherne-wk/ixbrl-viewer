import { ConcealmentProbe } from '../framework/concealment_probe.js';
import { ViewerPage } from '../framework/viewer_page.js';

jest.setTimeout(60000);

/*
 * The concealed fact tag says the filer hid a fact's tagged text with CSS.  It
 * comes from IXNode.htmlHidden(), which asks whether any of the fact's wrapper
 * nodes is hidden, having first excluded the wrappers whose own box is empty
 * because their content is absolutely positioned.  Those wrappers are not
 * concealing anything: the content sits in .ixbrl-sub-element children, which
 * are wrapper nodes too and are tested in their place.
 *
 * The interesting cases are all in concealed_facts.zip, one fact per host
 * element, and none of them occurs in a real filing this project has to hand -
 * which is why the fixture is synthetic and the geometry has to be real.  Each
 * case's shape is given below, in the form the fixture tags it: a fact whose
 * only child is an element gets that element as its wrapper node, so the
 * fixture chooses the wrapper's display by choosing that element.
 */
const CASES = {
    // <span><span style="position:absolute">..</span></span>
    inlineAbsolute: {
        host: 'case-inline-absolute',
        label: 'Malpractice Insurance, Multiprovider Captive Insurer, Retrospectively Rated [Fixed List]',
        concealed: false,
    },
    // <span style="display:contents"><span style="position:absolute">..</span></span>
    contentsAbsolute: {
        host: 'case-contents-absolute',
        label: 'Former Fiscal Year End Date',
        concealed: false,
    },
    // <div><span style="position:absolute">..</span></div>
    blockAbsolute: {
        host: 'case-block-absolute',
        label: 'Document Fiscal Year Focus',
        concealed: false,
    },
    // a fact inside a <div style="display:none">
    displayNone: {
        host: 'case-display-none',
        label: 'Time Deposits',
        concealed: true,
    },
    // a fact with nothing done to it
    plain: {
        host: 'case-plain',
        label: 'Financing Receivable, Allowance for Credit Loss, Current',
        concealed: false,
    },
    // a fact inside a <div style="color:rgba(0,0,0,0)">
    transparent: {
        host: 'case-transparent',
        label: 'Malpractice Insurance, Annual Coverage Limit',
        concealed: true,
    },
};

const CONCEALED_TAG = 'Concealed fact';

describe('ixbrl-viewer:', () => {
    let viewerPage;
    let probe;

    beforeEach(async () => {
        viewerPage = new ViewerPage();
        await viewerPage.buildPage();
        probe = new ConcealmentProbe(viewerPage,
            Object.values(CASES).map(c => c.host));
    });

    afterEach(async () => {
        await viewerPage.tearDown();
    });

    test('Concealed Fact Test - both call sites agree', async () => {
        await viewerPage.navigateToViewer('concealed_facts.zip');
        await viewerPage.sectionList.expandAll.select();

        for (const [name, testCase] of Object.entries(CASES)) {
            viewerPage.log(`Case ${name}`);
            const row = viewerPage.factList.row(testCase.label);

            // The row's tag was decided while the fact list was built, before
            // postProcess() ran.
            await row.tags.assertTags(testCase.concealed ? [CONCEALED_TAG] : []);

            // Selecting the fact asks again, after the drain.  The two answers
            // have to match, or the same fact is described two ways.
            await row.doubleClick();
            if (testCase.concealed) {
                await viewerPage.factDetailsPanel.concealedFactTag.assertVisible();
            }
            else {
                await viewerPage.factDetailsPanel.concealedFactTag.assertNotVisible();
            }

            // Selecting a fact replaces the fact list with the fact's details.
            await viewerPage.sectionList.factsTab.select();
        }
    });

    test('Concealed Fact Test - the .ixbrl-no-highlight filter is ordering dependent', async () => {
        await viewerPage.beginNavigateToViewer('concealed_facts.zip');
        await probe.install();
        await viewerPage.waitForLoaderRemoved();

        const atBuild = await probe.atFactListBuild();
        const afterDrain = await probe.now();
        const timings = await probe.timings();

        // Everything below rests on the fact list being built before
        // postProcess() writes .ixbrl-no-highlight, so measure that first
        // rather than assuming it.
        viewerPage.log(`Fact list built at ${timings.factListBuiltAt} ms, ` +
            `.ixbrl-no-highlight written at ${timings.noHighlightWrittenAt} ms`);
        expect(timings.factListBuiltAt).not.toBeNull();
        expect(timings.noHighlightWrittenAt).not.toBeNull();
        expect(timings.factListBuiltAt)
            .toBeLessThan(timings.noHighlightWrittenAt);

        const contents = CASES.contentsAbsolute.host;
        const block = CASES.blockAbsolute.host;
        const inline = CASES.inlineAbsolute.host;

        // A wrapper with no box at all, whose visible content is an absolutely
        // positioned sub-element.  This is the case the rider exists for: the
        // old filter calls the fact concealed while the fact list is built and
        // not concealed once postProcess() has marked the wrapper, so the row
        // and the fact details panel disagree.
        expect(atBuild[contents].hiddenNodes).toEqual(1);
        expect(atBuild[contents].noHighlight).toEqual(0);
        expect(atBuild[contents].oldFilter).toBe(true);
        expect(afterDrain[contents].noHighlight).toEqual(1);
        expect(afterDrain[contents].oldFilter).toBe(false);
        // The rider reads the class the wrapper walk already set, so it gives
        // the same answer at both moments, and it is the correct one: the
        // fact's text is on the screen.
        expect(atBuild[contents].riderFilter).toBe(false);
        expect(afterDrain[contents].riderFilter).toBe(false);

        // A block wrapper of the same shape.  postProcess() marks this one too,
        // but a block box with zero height still has a client rect, so it was
        // never ':hidden' and the exclusion never changed an answer here.  This
        // is the case both filters were expected to agree on.
        expect(afterDrain[block].noHighlight).toEqual(1);
        expect(afterDrain[block].hiddenNodes).toEqual(0);
        expect(atBuild[block].oldFilter).toBe(false);
        expect(afterDrain[block].oldFilter).toBe(false);
        expect(atBuild[block].riderFilter).toBe(false);
        expect(afterDrain[block].riderFilter).toBe(false);

        // An inline wrapper of the same shape.  postProcess() skips inline
        // containers, so .ixbrl-no-highlight never reaches this one - but an
        // empty inline box still sits on a line box and has a client rect, so
        // it is not ':hidden' either, and the two filters agree after all.
        expect(afterDrain[inline].containsAbsolute).toEqual(1);
        expect(afterDrain[inline].noHighlight).toEqual(0);
        expect(afterDrain[inline].hiddenNodes).toEqual(0);
        expect(atBuild[inline].oldFilter).toBe(false);
        expect(afterDrain[inline].oldFilter).toBe(false);
        expect(atBuild[inline].riderFilter).toBe(false);
        expect(afterDrain[inline].riderFilter).toBe(false);

        // The rider excludes more wrappers than the old filter did, so the
        // cases that really are concealed have to survive it.
        for (const host of [CASES.displayNone.host, CASES.transparent.host]) {
            expect(atBuild[host].oldFilter).toBe(true);
            expect(atBuild[host].riderFilter).toBe(true);
            expect(afterDrain[host].oldFilter).toBe(true);
            expect(afterDrain[host].riderFilter).toBe(true);
        }
        expect(afterDrain[CASES.plain.host].riderFilter).toBe(false);
    });
});
