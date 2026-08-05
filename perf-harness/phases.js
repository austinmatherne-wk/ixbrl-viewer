// The startup timeline as a *complete partition* of nav start -> drained.
// THROWAWAY - for the startup-slowness investigation only.
//
// Extracted from report-phases.js so fit-model.js fits the same partition the
// tables report.  Two copies of this list would let ticket 07's model and ticket
// 04's spine table disagree about what a phase is, which is the one difference
// neither would show.
//
// The five phases the source already had (the setProgress boundaries) do not tile
// the window on their own: the browser's own parse of the host document sits
// before the first of them, and three gaps sit between them.  Each is named here
// rather than left in a residual, because on an inline filing the parse gap alone
// is the largest thing outside preProcess.
//
// `from`/`to` are mark names; `spans` are the perfSpan / perfOpen names nested
// inside.  Kept as data so a span added to perf.js becomes a row for free.
module.exports = [
    { key: 'parse', label: 'nav -> DOMContentLoaded (browser parses host doc, evals bundle)',
        from: null, to: 'marks.load.start',
        spans: [] },
    { key: 'config', label: 'runtime config fetch',
        from: 'marks.load.start', to: 'marks.runtimeConfig.loaded',
        spans: [] },
    { key: 'boot', label: 'boot (inspector HTML -> loader shown)',
        from: 'marks.runtimeConfig.loaded', to: 'marks.loaderShown',
        spans: ['loadInspectorHTML'] },
    { key: 'metadata', label: 'metadata (read, parse, ReportSet, reparent)',
        from: 'marks.loaderShown', to: 'marks.phase.loading.start',
        spans: ['taxonomyData.read', 'taxonomyData.parse', 'reportSet.construct', 'reparentDocument'] },
    { key: 'loading', label: 'phase.loading (iframe readyState poll)',
        from: 'marks.phase.loading.start', to: 'marks.phase.loading.end',
        spans: [] },
    { key: 'construct', label: 'Viewer construct + continuation maps',
        from: 'marks.phase.loading.end', to: 'marks.phase.preProcess.start',
        spans: ['viewer.construct', 'viewer.buildContinuationMaps'] },
    { key: 'preProcess', label: 'phase.preProcess (document walk)',
        from: 'marks.phase.preProcess.start', to: 'marks.phase.preProcess.end',
        spans: ['viewer.preProcessiXBRL', 'viewer.setContinuationMaps', 'viewer.findOrCreateWrapperNode'] },
    { key: 'toUntagged', label: 'preProcess.end -> untagged.start (review mode only)',
        from: 'marks.phase.preProcess.end', to: 'marks.phase.untagged.start',
        spans: [] },
    { key: 'untagged', label: 'phase.untagged (review mode only)',
        from: 'marks.phase.untagged.start', to: 'marks.phase.untagged.end',
        spans: ['viewer.untagged.hideChildren', 'viewer.wrapUntaggedNumbers', 'viewer.untagged.showChildren'] },
    /* The progress hop: setProgress resolves on a double rAF, so this is pure
     * waiting.  In review mode the untagged phase sits inside it, which is why the
     * start mark falls back through two candidates. */
    { key: 'toPrepare', label: 'progress hop -> prepare.start (setProgress double rAF)',
        from: ['marks.phase.untagged.end', 'marks.phase.preProcess.end'],
        to: 'marks.phase.prepare.start',
        spans: [] },
    { key: 'prepare', label: 'phase.prepare',
        from: 'marks.phase.prepare.start', to: 'marks.phase.prepare.end',
        spans: ['viewer.setIXNodeMap', 'viewer.applyStyles', 'viewer.bindHandlers', 'viewer.addDocumentSetTabs'] },
    { key: 'toInspector', label: 'prepare.end -> inspector.initialize.start',
        from: 'marks.phase.prepare.end', to: 'marks.inspector.initialize.start',
        spans: [] },
    { key: 'inspectorPre', label: 'inspector setup (before inspectorInit)',
        from: 'marks.inspector.initialize.start', to: 'marks.phase.inspectorInit.start',
        spans: ['inspector.bindStaticHandlers', 'inspector.initializeTooltips',
            'inspector.initializeReviewMode', 'inspector.buildMenus', 'inspector.buildLanguages',
            'inspector.localize', 'inspector.createSummary', 'inspector.buildOutline',
            'inspector.initializeZoom'] },
    { key: 'inspectorInit', label: 'phase.inspectorInit',
        from: 'marks.phase.inspectorInit.start', to: 'marks.phase.inspectorInit.end',
        spans: ['inspector.searchConstruct', 'inspector.rebuildViewer', 'inspector.initializeViewer',
            'inspector.buildFactListByGroup', 'inspector.factListRows', 'inspector.doInitialSelection'] },
    { key: 'toLoaderGone', label: 'inspectorInit.end -> loader removed (interact)',
        from: 'marks.phase.inspectorInit.end', to: 'marks.loaderRemoved',
        spans: ['interact.configure'] },
    { key: 'drain', label: 'post-load drain (loader gone -> drained)',
        from: 'marks.loaderRemoved', to: 'marks.drained',
        spans: [] },
];
