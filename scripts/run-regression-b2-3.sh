#!/usr/bin/env bash
# scripts/run-regression-b2-1.sh — fix18-10-hotfix30-B5-R5.4-G1.5-B2.1
# 執行完整 Regression 清單（每支測試前清掉 data/pos.db 殘留，避免跨腳本汙染）。
set -uo pipefail
cd "$(dirname "$0")/.."

declare -a NAMES=()
declare -a CMDS=()
declare -a EXPECT=()

add() { NAMES+=("$1"); CMDS+=("$2"); EXPECT+=("$3"); }

add "B2.3 Smoke"            "node scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-3-ga4-endpoint-unification.js" ">=70"
add "B2.2 Smoke"            "node scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-2-ga4-layer-auth.js" "95/95"
add "B2.1 Smoke"            "node scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-1-ga4-settings-persistence.js" ">=72"
add "B2 Smoke"               "node scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-ga4-settings.js" "181/181"
add "B2 Static Audit"        "node scripts/static-audit-g1-5-b2.js" "82/82"
add "B2a Smoke"              "node scripts/smoke-hotfix30-b5-r5-4-g1-5-b2a-ga4-settings-ui.js" "106/106"
add "B1 Smoke"               "node scripts/smoke-hotfix30-b5-r5-4-g1-5-b1-ga4-frontend-choropleth.js" "168/168"
add "B1 Static Audit"        "node scripts/static-audit-g1-5-b1.js" "71/71"
add "G1.5-A Smoke"           "node scripts/smoke-hotfix30-b5-r5-4-g1-5-a-ga4-backend-correctness.js" "140/140"
add "G1.5-A Static Audit"    "node scripts/static-audit-g1-5-a.js" "77/77"
add "Geo Map Settings Smoke" "node scripts/smoke-hotfix30-b5-r5-2-b2-geo-map.js" "620/620"
add "Geo Settings UI Smoke"  "node scripts/smoke-hotfix30-b5-r5-2-b3-geo-settings-ui.js" "157/157"
add "G1 geo-live Smoke"      "node scripts/smoke-hotfix30-b5-r5-4-g1-live-geo.js" "212/212"
add "G1.4.1 Smoke"           "node scripts/smoke-hotfix30-b5-r5-4-g1-4-1-dark-card-metric-rendering.js" "149/149"
add "G1.4 Smoke"             "node scripts/smoke-hotfix30-b5-r5-4-g1-4-map-label-rendering.js" "148/148"
add "G1.3.2 Smoke"           "node scripts/smoke-hotfix30-b5-r5-4-g1-3-2-regression-guard.js" "148/148"
add "G1.2 Smoke"             "node scripts/smoke-hotfix30-b5-r5-4-g1-2-layer-switch.js" "83/83"
add "A2 Smoke"                "node scripts/smoke-hotfix30-b5-r5-3-a2-geo-event-engine.js" "229/229"
add "A1.2 Smoke"             "node scripts/smoke-hotfix30-b5-r5-3-a1-2-visitor-geo-sync.js" "189/189"
add "Static Audit G1.4.1"    "node scripts/static-audit-g1-4-1.js" "56/56"
add "Static Audit G1.4"      "node scripts/static-audit-g1-4.js" "52/52"
add "Static Audit G1.3.2"    "node scripts/static-audit-g1-3-2.js" "48/48"

ROUNDS="${1:-3}"
OVERALL_FAIL=0

for round in $(seq 1 "$ROUNDS"); do
  echo "########################################################################"
  echo "# ROUND $round / $ROUNDS"
  echo "########################################################################"
  for i in "${!NAMES[@]}"; do
    rm -f data/pos.db
    name="${NAMES[$i]}"
    cmd="${CMDS[$i]}"
    expect="${EXPECT[$i]}"
    out=$(timeout 90 bash -c "$cmd" 2>&1)
    code=$?
    line=$(echo "$out" | grep -E "PASS:|OK:|/ 82 OK|/ 71 OK|/ 77 OK|項，PASS|TOTAL:" | tail -3 | tr '\n' ' ')
    if [ $code -ne 0 ]; then
      echo "[ROUND $round][FAIL-EXIT] $name (expect $expect) — exit=$code — $line"
      OVERALL_FAIL=1
    else
      echo "[ROUND $round][OK] $name (expect $expect) — $line"
    fi
  done
  rm -f data/pos.db
done

echo "########################################################################"
if [ $OVERALL_FAIL -ne 0 ]; then
  echo "REGRESSION RESULT: FAIL (see above)"
  exit 1
else
  echo "REGRESSION RESULT: ALL PASS, $ROUNDS ROUNDS CONSISTENT"
  exit 0
fi
