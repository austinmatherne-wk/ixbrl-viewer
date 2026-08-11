#!/bin/bash

set -e

testFilingDir=tests/puppeteer/test_filings
genDir=tests/puppeteer/artifacts/generated_output
mkdir -p $genDir

for file in "$testFilingDir"/*.zip; do
    echo "Generating ixbrl-viewer for: $file"
    outputFilename=$(basename -- "$file")
    viewerName=${outputFilename%.zip}.htm
    arelleCmdLine --plugins ixbrl-viewer -f $file --save-viewer $genDir/$viewerName --viewer-url ../../../../iXBRLViewerPlugin/viewer/dist/ixbrlviewer.js --viewer-no-copy-script
done

# Text block values are emitted into a second script tag, and viewers generated
# before that have to keep working, so the text block filing is served in both
# shapes and the suite asserts they render the same text.
node tests/puppeteer/tools/inline_text_block_values.mjs $genDir/text_blocks.htm $genDir/text_blocks_inline.htm

echo "iXBRL-Viewer Generation Complete"
