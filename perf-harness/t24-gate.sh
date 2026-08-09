#!/bin/bash
# Throwaway (ticket 24): output identity across none and rowdefer, including the
# fourth, inspector-row signature taken after both clicks that can trigger the
# deferred tag.
set -e
export FIXTURE_ROOT=/Users/austinmatherne/git/open-source/ixbrl-viewer/.scratch/startup-slowness
export ABLATE_ARMS=none,rowdefer
export INSPECTOR_ROWS=1
export OUT=perf-harness/out/t24-identity.json
node perf-harness/assert-wrapper-identity.js
