#!/bin/bash
# usage: tests/contrast/run-all.sh http://localhost:8766   (serve the repo root first, e.g. python3 -m http.server 8766)
set -u; B=${1:-http://localhost:8766}; D=$(cd "$(dirname "$0")" && pwd); O=${OUT:-/tmp/contrast}; mkdir -p "$O"; rc=0
while IFS='|' read -r label path action sess; do
  node "$D/contrast.mjs" "$O/$label.json" "$label" "$B$path" "$action" "$sess" </dev/null | tail -1 | tee -a "$O/summary.txt"
  tail -1 "$O/summary.txt" | grep -q "TOTAL_FAILS=0$" || rc=1
done <<'LIST'
sa-index|/index.html|0|1
sa-editor|/index.html|switchTab('editor')|1
sa-campaigns|/index.html|switchTab('campaigns')|1
sa-loop|/index.html|switchTab('loop')|1
sa-drill|/index.html|openDrilldown('sent')|1
sa-authgate|/index.html|0|0
dash-index|/dashboard/index.html|0|1
dash-editor|/dashboard/index.html|switchTab('editor')|1
dash-loop|/dashboard/index.html|switchTab('loop')|1
dash-drill|/dashboard/index.html|openDrilldown('sent')|1
agent-default|/agent.html|0|0
agent-dark|/agent.html?slug=dark-demo|0|0
agent-mid|/agent.html?slug=mid-demo|0|0
LIST
exit $rc
