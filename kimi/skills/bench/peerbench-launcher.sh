#!/bin/sh
set -eu

# This file is rendered by the installer, not by Kimi's SKILL.md placeholder engine.
exec node {{BENCH_RUNNER_SHELL}} "$@"
