#!/bin/bash
# Full-body solver smoke for the built bundle (or dev server). Usage: bundle-smoke-2026-10-12.sh <base-url>
# Submits an impulse-response job (explicit wall absorption) and a wave job (drywall walls, wood floor),
# polls both to completion with their capability tokens, and checks that a no-material wave body is rejected (400).
B=${1:-http://127.0.0.1:3100}
ROOM='"L":4,"W":4,"H":3,"wallMaterial":"drywall","floorMaterial":"wood_floor","ceilMaterial":"drywall","sources":[{"x":0.5,"y":0.5,"z":1.5}],"receivers":[{"x":0.25,"y":0.75,"z":1.5}]'
post(){ curl -s -H 'content-type: application/json' -X POST "$B/api/solver/$1" -d "$2"; }
poll(){ # poll <jobId> <token>
  for i in $(seq 1 40); do
    R=$(curl -s -H "Authorization: Bearer $2" "$B/api/jobs/$1")
    S=$(echo "$R" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("status"))
except Exception: print("parse-error")')
    if [ "$S" = completed ] || [ "$S" = failed ] || [ "$S" = error ]; then echo "$S"; echo "$R" | python3 -c 'import sys,json; d=json.load(sys.stdin); r=d.get("result") or {}; print({"type":d.get("type"),"status":d.get("status"),"success":r.get("success"),"meshSize":r.get("meshSize"),"gridDims":r.get("gridDims")})'; return; fi
    sleep 3
  done; echo "STILL $S"
}
IR=$(post impulse-response "{${ROOM},\"wallAbsorption\":0.1}"); echo "IR submit: $(echo "$IR" | cut -c1-120)"
sleep 4
WV=$(post wave "{${ROOM}}"); echo "wave submit: $(echo "$WV" | cut -c1-120)"
echo "IR poll:"; poll "$(echo "$IR" | python3 -c 'import sys,json;print(json.load(sys.stdin)["jobId"])')" "$(echo "$IR" | python3 -c 'import sys,json;print(json.load(sys.stdin)["capabilityToken"])')"
echo "wave poll:"; poll "$(echo "$WV" | python3 -c 'import sys,json;print(json.load(sys.stdin)["jobId"])')" "$(echo "$WV" | python3 -c 'import sys,json;print(json.load(sys.stdin)["capabilityToken"])')"
echo "negative (no wall material/absorption):"
curl -s -o /dev/stderr -w "HTTP %{http_code}\n" -H 'content-type: application/json' -X POST "$B/api/solver/wave" -d '{"L":4,"W":4,"H":3,"sources":[{"x":0.5,"y":0.5,"z":1.5}],"receivers":[{"x":0.25,"y":0.75,"z":1.5}]}' 2>/dev/null
