#!/bin/bash
# Throwaway (ticket 24): what the first Expand all costs once the test is deferred.
set -e
export FIXTURE_ROOT=/Users/austinmatherne/git/open-source/ixbrl-viewer/.scratch/startup-slowness
export ABLATE_ARMS=none,rowdefer
export RUNS=5
export OUT=perf-harness/out/t24-expand-all.json
node perf-harness/expand-all-cost.js
