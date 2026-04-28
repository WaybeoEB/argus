#!/usr/bin/env bash
set -euo pipefail

API="${API_BASE:-http://localhost:5173}/api"
BACKEND="${BACKEND_BASE:-http://localhost:3001}/api"
FRONTEND="${FRONTEND_URL:-http://localhost:5173}"
PASS=0; FAIL=0

t() {
  local name="$1" cmd="$2"
  if eval "$cmd" > /dev/null 2>&1; then
    echo "  ✅ $name"; PASS=$((PASS+1))
  else
    echo "  ❌ $name"; FAIL=$((FAIL+1))
  fi
}

echo ""
echo "🧪 SQS Admin Panel — Integration Tests"
echo "========================================="

echo ""
echo "⏳ Waiting for services..."
for i in $(seq 1 30); do
  curl -sf "$BACKEND/queues" > /dev/null 2>&1 && break
  sleep 1
done

echo ""
echo "--- Infrastructure ---"
if [ -z "${SKIP_FRONTEND_TESTS:-}" ]; then
  t "Frontend serves HTML"       "curl -sf $FRONTEND/ | grep -q root"
fi
t "Backend responds"           "curl -sf $BACKEND/queues"
if [ -z "${SKIP_FRONTEND_TESTS:-}" ]; then
  t "Frontend proxy works"       "curl -sf $API/queues"
fi

echo ""
echo "--- Queue CRUD ---"
t "Create standard queue"      "curl -sf -X POST $API/queues -H 'Content-Type: application/json' -d '{\"name\":\"t-std\"}' | grep -q queueUrl"
t "Create FIFO queue"          "curl -sf -X POST $API/queues -H 'Content-Type: application/json' -d '{\"name\":\"t-fifo.fifo\"}' | grep -q queueUrl"
t "List includes created"      "curl -sf $API/queues | grep -q t-std"
t "Update attributes"          "curl -sf -X PUT $API/queues/t-std -H 'Content-Type: application/json' -d '{\"attributes\":{\"VisibilityTimeout\":\"60\"}}' | grep -q updated"
t "Verify updated attrs"       "curl -sf $API/queues | python3 -c \"import sys,json;q=[x for x in json.load(sys.stdin)['queues'] if x['name']=='t-std'][0];assert q['attributes']['VisibilityTimeout']=='60'\""

echo ""
echo "--- Send & Receive ---"
t "Send message"               "curl -sf -X POST $API/queues/t-std/messages -H 'Content-Type: application/json' -d '{\"messageBody\":\"hello\"}' | grep -q messageId"
t "Peek returns message"       "curl -sf '$API/queues/t-std/messages?maxMessages=5' | grep -q hello"
t "Still available after peek" "curl -sf '$API/queues/t-std/messages?maxMessages=5' | grep -q hello"
t "Batch send 3 msgs"          "curl -sf -X POST $API/queues/t-std/messages/batch -H 'Content-Type: application/json' -d '{\"messages\":[\"b1\",\"b2\",\"b3\"]}' | grep -q '\"sent\": 3'"
t "FIFO send with group"       "curl -sf -X POST $API/queues/t-fifo.fifo/messages -H 'Content-Type: application/json' -d '{\"messageBody\":\"fm\",\"messageGroupId\":\"g1\",\"messageDeduplicationId\":\"d1\"}' | grep -q messageId"

echo ""
echo "--- Delete Message ---"
RECEIPT=$(curl -sf "$API/queues/t-std/messages?maxMessages=1" 2>/dev/null | python3 -c "import sys,json;m=json.load(sys.stdin);print(m[0]['ReceiptHandle'])" 2>/dev/null || echo "")
if [ -n "$RECEIPT" ]; then
  t "Delete single message"    "curl -sf -X DELETE $API/queues/t-std/messages -H 'Content-Type: application/json' -d '{\"receiptHandle\":\"$RECEIPT\"}' | grep -q deleted"
else
  echo "  ⚠️  Skip delete (no receipt)"; FAIL=$((FAIL+1))
fi

echo ""
echo "--- Export / Import ---"
t "Export messages"             "curl -sf -X POST $API/queues/t-std/export -H 'Content-Type: application/json' -d '{\"maxMessages\":10}' | python3 -c 'import sys,json;assert len(json.load(sys.stdin))>0'"
EXPORTED=$(curl -sf -X POST "$API/queues/t-std/export" -H 'Content-Type: application/json' -d '{"maxMessages":2}' 2>/dev/null || echo "[]")
t "Import messages"            "curl -sf -X POST $API/queues/t-std/import -H 'Content-Type: application/json' -d '{\"messages\":$(echo "$EXPORTED" | python3 -c "import sys;print(sys.stdin.read().strip())")}' | grep -q imported"

echo ""
echo "--- Move Messages ---"
curl -sf -X POST "$API/queues" -H 'Content-Type: application/json' -d '{"name":"t-target"}' > /dev/null 2>&1 || true
t "Move to target"             "curl -sf -X POST $API/queues/t-std/move -H 'Content-Type: application/json' -d '{\"targetQueue\":\"t-target\",\"maxMessages\":2}' | grep -q moved"
t "Target has messages"        "curl -sf $API/queues | python3 -c \"import sys,json;q=[x for x in json.load(sys.stdin)['queues'] if x['name']=='t-target'][0];assert int(q['attributes']['ApproximateNumberOfMessages'])>0\""

echo ""
echo "--- Edit Message ---"
# Send a message to edit
EDIT_ID=$(curl -sf -X POST "$API/queues/t-std/messages" -H 'Content-Type: application/json' -d '{"messageBody":"before-edit"}' 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['messageId'])" 2>/dev/null || echo "")
if [ -n "$EDIT_ID" ]; then
  sleep 1
  t "Edit message body"          "curl -sf -X PUT $API/queues/t-std/messages -H 'Content-Type: application/json' -d '{\"messageBody\":\"after-edit\",\"messageId\":\"$EDIT_ID\"}' | grep -q messageId"
  t "Edited body visible"        "curl -sf '$API/queues/t-std/messages?maxMessages=10' | grep -q after-edit"
else
  echo "  ⚠️  Skip edit (no messageId)"; FAIL=$((FAIL+1))
fi
t "Edit missing body → 400"    "curl -s -o /dev/null -w '%{http_code}' -X PUT $API/queues/t-std/messages -H 'Content-Type: application/json' -d '{\"messageId\":\"x\"}' | grep -q 400"
t "Edit missing msgId → 400"   "curl -s -o /dev/null -w '%{http_code}' -X PUT $API/queues/t-std/messages -H 'Content-Type: application/json' -d '{\"messageBody\":\"x\"}' | grep -q 400"

# FIFO edit
FIFO_EDIT_ID=$(curl -sf -X POST "$API/queues/t-fifo.fifo/messages" -H 'Content-Type: application/json' -d '{"messageBody":"fifo-before","messageGroupId":"g2","messageDeduplicationId":"dedup-edit-1"}' 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['messageId'])" 2>/dev/null || echo "")
if [ -n "$FIFO_EDIT_ID" ]; then
  sleep 1
  t "FIFO edit with groupId"     "curl -sf -X PUT $API/queues/t-fifo.fifo/messages -H 'Content-Type: application/json' -d '{\"messageBody\":\"fifo-after\",\"messageId\":\"$FIFO_EDIT_ID\",\"messageGroupId\":\"g2\",\"messageDeduplicationId\":\"dedup-edit-1\"}' | grep -q messageId"
else
  echo "  ⚠️  Skip FIFO edit (no messageId)"; FAIL=$((FAIL+1))
fi

echo ""
echo "--- Move Single by messageId ---"
MOVE_MSG_ID=$(curl -sf -X POST "$API/queues/t-std/messages" -H 'Content-Type: application/json' -d '{"messageBody":"move-me-single"}' 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['messageId'])" 2>/dev/null || echo "")
if [ -n "$MOVE_MSG_ID" ]; then
  sleep 1
  t "Move single by messageId"  "curl -sf -X POST $API/queues/t-std/move -H 'Content-Type: application/json' -d '{\"targetQueue\":\"t-target\",\"messageId\":\"$MOVE_MSG_ID\"}' | python3 -c \"import sys,json;d=json.load(sys.stdin);assert d['moved']==1\""
  MOVE_MSG_ID2=$(curl -sf -X POST "$API/queues/t-std/messages" -H 'Content-Type: application/json' -d '{"messageBody":"move-me-single-2"}' 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['messageId'])" 2>/dev/null || echo "")
  if [ -n "$MOVE_MSG_ID2" ]; then
    sleep 1
    t "Move target=t-target"      "curl -sf -X POST $API/queues/t-std/move -H 'Content-Type: application/json' -d '{\"targetQueue\":\"t-target\",\"messageId\":\"$MOVE_MSG_ID2\"}' | python3 -c \"import sys,json;d=json.load(sys.stdin);assert d['moved']==1\"; curl -sf $API/queues | python3 -c \"import sys,json;q=[x for x in json.load(sys.stdin)['queues'] if x['name']=='t-target'][0];assert int(q['attributes']['ApproximateNumberOfMessages'])>0\""
  else
    echo "  ⚠️  Skip move-target (no messageId)"; FAIL=$((FAIL+1))
  fi
else
  echo "  ⚠️  Skip move-single (no messageId)"; FAIL=$((FAIL+1))
fi
t "Move missing target → 400"  "curl -s -o /dev/null -w '%{http_code}' -X POST $API/queues/t-std/move -H 'Content-Type: application/json' -d '{}' | grep -q 400"

echo ""
echo "--- DLQ & Redrive ---"
curl -sf -X POST "$API/queues" -H 'Content-Type: application/json' -d '{"name":"t-dlq"}' > /dev/null 2>&1 || true
DLQ_ARN=$(curl -sf "$API/queues" 2>/dev/null | python3 -c "import sys,json;print([q['attributes']['QueueArn'] for q in json.load(sys.stdin)['queues'] if q['name']=='t-dlq'][0])" 2>/dev/null || echo "")
SRC_BODY=$(python3 -c "import json;print(json.dumps({'name':'t-src','attributes':{'RedrivePolicy':json.dumps({'deadLetterTargetArn':'$DLQ_ARN','maxReceiveCount':'3'})}}))")
curl -sf -X POST "$API/queues" -H 'Content-Type: application/json' -d "$SRC_BODY" > /dev/null 2>&1 || true
t "DLQ detected"               "curl -sf $API/queues | python3 -c \"import sys,json;q=[x for x in json.load(sys.stdin)['queues'] if x['name']=='t-dlq'][0];assert q['isDeadLetterQueue']==True\""
t "Source shows dlqName"       "curl -sf $API/queues | python3 -c \"import sys,json;q=[x for x in json.load(sys.stdin)['queues'] if x['name']=='t-src'][0];assert q.get('dlqName')=='t-dlq'\""
curl -sf -X POST "$API/queues/t-dlq/messages" -H 'Content-Type: application/json' -d '{"messageBody":"dead"}' > /dev/null 2>&1 || true
t "Redrive DLQ→source"         "curl -sf -X POST $API/queues/t-dlq/redrive -H 'Content-Type: application/json' -d '{\"maxMessages\":10}' | grep -q t-src"

echo ""
echo "--- Pagination & Search ---"
t "Response has pagination"    "curl -sf '$API/queues?page=1&pageSize=2' | python3 -c \"import sys,json;d=json.load(sys.stdin);assert 'total' in d and 'queues' in d and len(d['queues'])<=2\""
t "Search filters by name"    "curl -sf '$API/queues?search=t-std' | python3 -c \"import sys,json;d=json.load(sys.stdin);assert all('t-std' in q['name'] for q in d['queues'])\""

echo ""
echo "--- Purge & Delete ---"
t "Purge queue"                "curl -sf -X POST $API/queues/t-target/purge -H 'Content-Type: application/json' -d '{}' | grep -q purged"
t "Delete queue"               "curl -sf -X DELETE $API/queues/t-target | grep -q deleted"
t "Deleted not in list"        "! curl -sf $API/queues | grep -q t-target"

echo ""
echo "--- Cleanup ---"
for q in t-std t-fifo.fifo t-dlq t-src t-target; do
  curl -s -X DELETE "$API/queues/$q" > /dev/null 2>&1 || true
done
echo "  🧹 Test queues cleaned up"

echo ""
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
echo ""
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
