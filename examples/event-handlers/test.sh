#!/bin/bash
# Quick smoke test — creates a session and verifies the handlers fire.
# Run this in a separate terminal while the example is running.

set -e

BASE="http://localhost:3001/api"

echo "=== Creating session ==="
SESSION=$(curl -s -X POST "$BASE/agents" \
  -H 'Content-Type: application/json' \
  -d '{"agentTemplateId": "example"}')

echo "$SESSION" | jq .
SESSION_ID=$(echo "$SESSION" | jq -r .id)

echo ""
echo "=== Session created: $SESSION_ID ==="
echo "=== Check the server terminal for handler output ==="
echo ""
echo "=== Getting session ==="
curl -s "$BASE/agents/$SESSION_ID" | jq '{id, status, agentName, websocketUrl}'

echo ""
echo "=== Waiting 5s for agent activity... ==="
sleep 5

echo ""
echo "=== Terminating session ==="
curl -s -X DELETE "$BASE/agents/$SESSION_ID" | jq .
echo ""
echo "=== Done — check server terminal for onSessionEnd output ==="
