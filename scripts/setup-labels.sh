#!/usr/bin/env bash
# Creates or updates the repository's issue labels. Safe to re-run.
# Usage: scripts/setup-labels.sh [owner/repo]
set -euo pipefail

repo_args=()
if [[ $# -gt 0 ]]; then
  repo_args=(--repo "$1")
fi

label() {
  gh label create "$1" --color "$2" --description "$3" --force "${repo_args[@]}"
}

# State
label "agent:ready" "0e8a16" "Ready for an agent to pick up"
label "agent:in-progress" "fbca04" "An agent is working on this"
label "needs-human" "d93f0b" "Blocked on a human decision or input"
label "blocked" "b60205" "Blocked by another issue or external factor"

# Type
label "type:epic" "5319e7" "Spec-level work split into sub-issues"
label "type:task" "1d76db" "A single implementable unit of work"
label "type:bug" "d73a4a" "Something is not working"

# Area
label "area:ingest" "c5def5" "Fetching data from ODA"
label "area:transform" "c5def5" "Normalising and extracting data"
label "area:enrich" "c5def5" "LLM enrichment"
label "area:review" "c5def5" "Agentic review of enrichments"
label "area:events" "c5def5" "Detecting and recording events"
label "area:dashboard" "c5def5" "The web dashboard"
label "area:platform" "c5def5" "Tooling, CI, infrastructure code"
