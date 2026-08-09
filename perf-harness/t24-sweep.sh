#!/bin/bash
# Throwaway (ticket 24).  Usage: t24-sweep.sh <level> <tiers> <arms> <out>
# One session per invocation; every arm is paired inside it, and nothing is ever
# differenced across invocations.
set -e
export FIXTURE_ROOT=/Users/austinmatherne/git/open-source/ixbrl-viewer/.scratch/startup-slowness
export LEVEL="$1"
export TIERS="$2"
export ABLATE_ARMS="$3"
export OUT="$4"
export RUNS=5
node perf-harness/measure-phases.js
