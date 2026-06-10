#!/usr/bin/env bash
set -euo pipefail

API="${API_BASE:-http://localhost:5173}/api"
BACKEND="${BACKEND_BASE:-http://localhost:3001}/api"
FRONTEND="${FRONTEND_URL:-http://localhost:5173}"
PASS=0; FAIL=0
 
# Normalize deactivate flags to lowercase for case-insensitive checks
DEACTIVATE_DELETE_LC=$(echo "${DEACTIVATE_DELETE:-false}" | tr '[:upper:]' '[:lower:]')
DEACTIVATE_PURGE_LC=$(echo "${DEACTIVATE_PURGE:-false}" | tr '[:upper:]' '[:lower:]')
DEACTIVATE_DELETE_MESSAGES_LC=$(echo "${DEACTIVATE_DELETE_MESSAGES:-false}" | tr '[:upper:]' '[:lower:]')


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
sleep 1
t "Peek returns message"       "curl -sf '$API/queues/t-std/messages?maxMessages=10&waitTime=1' | grep -q hello"
t "Still available after peek" "curl -sf '$API/queues/t-std/messages?maxMessages=10&waitTime=1' | grep -q hello"
t "Batch send 3 msgs"          "curl -sf -X POST $API/queues/t-std/messages/batch -H 'Content-Type: application/json' -d '{\"messages\":[\"b1\",\"b2\",\"b3\"]}' | grep -q '\"sent\": 3'"
t "FIFO send with group"       "curl -sf -X POST $API/queues/t-fifo.fifo/messages -H 'Content-Type: application/json' -d '{\"messageBody\":\"fm\",\"messageGroupId\":\"g1\",\"messageDeduplicationId\":\"d1\"}' | grep -q messageId"

# Isolated test for message attributes
curl -sf -X POST $API/queues -H 'Content-Type: application/json' -d '{"name":"t-attrs"}' > /dev/null
T_ATTRS_URL=$(curl -sf "$API/queues" | python3 -c "import sys,json; print([q['url'] for q in json.load(sys.stdin)['queues'] if q['name']=='t-attrs'][0])")
if echo "$API" | grep -E -q "localhost|127\.0\.0\.1|::1"; then
  T_ATTRS_URL=$(echo "$T_ATTRS_URL" | sed -E 's/[^/:]+(:[0-9]+)?/localhost:4566/2')
else
  T_ATTRS_URL=$(echo "$T_ATTRS_URL" | sed -E 's/[^/:]+(:[0-9]+)?/localstack:4566/2')
fi
curl -sf -X POST "$T_ATTRS_URL" -d "Action=SendMessage&MessageBody=with-attrs&MessageAttribute.1.Name=testAttr&MessageAttribute.1.Value.DataType=String&MessageAttribute.1.Value.StringValue=testVal" > /dev/null
t "Attributes returned on peek"   "curl -sf '$API/queues/t-attrs/messages?maxMessages=10&waitTime=1' | python3 -c \"import sys,json; msgs=json.load(sys.stdin); m=[x for x in msgs if x['Body']=='with-attrs'][0]; assert m['MessageAttributes']['testAttr']['StringValue']=='testVal'\""


echo ""
echo "--- Delete Message ---"
curl -sf -X POST $API/queues -H 'Content-Type: application/json' -d '{"name":"t-del"}' > /dev/null
DEL_MSG_ID=$(curl -sf -X POST "$API/queues/t-del/messages" -H 'Content-Type: application/json' -d '{"messageBody":"delete-me"}' 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['messageId'])" 2>/dev/null || echo "")
if [ -n "$DEL_MSG_ID" ]; then
  sleep 1
  if [ "$DEACTIVATE_DELETE_MESSAGES_LC" = "true" ]; then
    t "Delete message blocked"   "curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/queues/t-del/messages -H 'Content-Type: application/json' -d '{\"messageId\":\"$DEL_MSG_ID\"}' | grep -q 403"
  else
    t "Delete single message"    "curl -sf -X DELETE $API/queues/t-del/messages -H 'Content-Type: application/json' -d '{\"messageId\":\"$DEL_MSG_ID\"}' | grep -q deleted"
  fi
else
  echo "  ⚠️  Skip delete (no messageId)"; FAIL=$((FAIL+1))
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
# Purge leftover messages from prior test runs (cleanup may have been blocked by DEACTIVATE_DELETE)
curl -sf -X POST "$API/queues/t-std/purge" -H 'Content-Type: application/json' -d '{}' > /dev/null 2>&1 || true
sleep 1
# Send a message to edit
EDIT_ID=$(curl -sf -X POST "$API/queues/t-std/messages" -H 'Content-Type: application/json' -d '{"messageBody":"before-edit"}' 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['messageId'])" 2>/dev/null || echo "")
if [ -n "$EDIT_ID" ]; then
  sleep 2
  t "Edit message body"          "curl -sf -X PUT $API/queues/t-std/messages -H 'Content-Type: application/json' -d '{\"messageBody\":\"after-edit\",\"messageId\":\"$EDIT_ID\"}' | grep -q messageId"
  t "Edited body visible"        "curl -sf '$API/queues/t-std/messages?maxMessages=10' | grep -q after-edit"
else
  echo "  ⚠️  Skip edit (no messageId)"; FAIL=$((FAIL+1))
fi
t "Edit missing body → 400"    "curl -s -o /dev/null -w '%{http_code}' -X PUT $API/queues/t-std/messages -H 'Content-Type: application/json' -d '{\"messageId\":\"x\"}' | grep -q 400"
t "Edit missing msgId → 400"   "curl -s -o /dev/null -w '%{http_code}' -X PUT $API/queues/t-std/messages -H 'Content-Type: application/json' -d '{\"messageBody\":\"x\"}' | grep -q 400"

# FIFO edit
FIFO_EDIT_ID=$(curl -sf -X POST "$API/queues/t-fifo.fifo/messages" -H 'Content-Type: application/json' -d "{\"messageBody\":\"fifo-before\",\"messageGroupId\":\"g2\",\"messageDeduplicationId\":\"dedup-edit-$RANDOM\"}" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['messageId'])" 2>/dev/null || echo "")
if [ -n "$FIFO_EDIT_ID" ]; then
  sleep 1
  t "FIFO edit with groupId"     "curl -sf -X PUT $API/queues/t-fifo.fifo/messages -H 'Content-Type: application/json' -d \"{\\\"messageBody\\\":\\\"fifo-after\\\",\\\"messageId\\\":\\\"$FIFO_EDIT_ID\\\",\\\"messageGroupId\\\":\\\"g2\\\",\\\"messageDeduplicationId\\\":\\\"dedup-edit-$RANDOM\\\"}\" | grep -q messageId"
else
  echo "  ⚠️  Skip FIFO edit (no messageId)"; FAIL=$((FAIL+1))
fi

echo ""
echo "--- Move Single by messageId ---"
MOVE_MSG_ID=$(curl -sf -X POST "$API/queues/t-std/messages" -H 'Content-Type: application/json' -d '{"messageBody":"move-me-single"}' 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['messageId'])" 2>/dev/null || echo "")
if [ -n "$MOVE_MSG_ID" ]; then
  sleep 3
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

# Push 15 messages into the DLQ to test batched redrive (bypasses the old 10-message default)
for i in $(seq 1 15); do
  curl -sf -X POST "$API/queues/t-dlq/messages" -H 'Content-Type: application/json' -d "{\"messageBody\":\"dead-$i\"}" > /dev/null 2>&1 || true
done
sleep 1
t "Redrive batch DLQ→source"   "curl -sf -X POST $API/queues/t-dlq/redrive -H 'Content-Type: application/json' -d '{\"maxMessages\":100}' | python3 -c \"import sys,json;d=json.load(sys.stdin);assert d['moved']>=15, f'expected >=15 moved, got {d[\\\"moved\\\"]}';assert 'sourceQueue' in d\""
t "DLQ empty after redrive"    "curl -sf $API/queues | python3 -c \"import sys,json;q=[x for x in json.load(sys.stdin)['queues'] if x['name']=='t-dlq'][0];assert int(q['attributes']['ApproximateNumberOfMessages'])==0, f'expected 0, got {q[\\\"attributes\\\"][\\\"ApproximateNumberOfMessages\\\"]}'\""

# Backwards-compat: maxMessages still caps the redrive
curl -sf -X POST "$API/queues/t-dlq/messages" -H 'Content-Type: application/json' -d '{"messageBody":"dead-limited"}' > /dev/null 2>&1 || true
sleep 1
t "Redrive with maxMessages"   "curl -sf -X POST $API/queues/t-dlq/redrive -H 'Content-Type: application/json' -d '{\"maxMessages\":10}' | python3 -c \"import sys,json;d=json.load(sys.stdin);assert d['moved']>=1, f'expected >=1, got {d[\\\"moved\\\"]}';assert d['sourceQueue']=='t-src', f'expected t-src, got {d[\\\"sourceQueue\\\"]}'\"" 

echo ""
echo "--- Pagination & Search ---"
t "Response has pagination"    "curl -sf '$API/queues?page=1&pageSize=2' | python3 -c \"import sys,json;d=json.load(sys.stdin);assert 'total' in d and 'queues' in d and len(d['queues'])<=2\""
t "Search filters by name"    "curl -sf '$API/queues?search=t-std' | python3 -c \"import sys,json;d=json.load(sys.stdin);assert all('t-std' in q['name'] for q in d['queues'])\""

echo ""
echo "--- Peek Message Pagination ---"
# Create a queue and populate with 15 messages
curl -sf -X POST "$API/queues" -H 'Content-Type: application/json' -d '{"name":"t-peek"}' > /dev/null 2>&1 || true
for i in $(seq 1 15); do
  curl -sf -X POST "$API/queues/t-peek/messages" -H 'Content-Type: application/json' -d "{\"messageBody\":\"peek-msg-$i\"}" > /dev/null 2>&1
done
sleep 1
t "First peek returns ≤10"    "curl -sf '$API/queues/t-peek/messages?maxMessages=10' | python3 -c \"import sys,json;msgs=json.load(sys.stdin);assert len(msgs)<=10, f'expected <=10, got {len(msgs)}'\""
t "Peek returns list"          "curl -sf '$API/queues/t-peek/messages?maxMessages=10' | python3 -c \"import sys,json;msgs=json.load(sys.stdin);assert isinstance(msgs, list)\""
t "maxPolls=3 gets more"      "curl -sf '$API/queues/t-peek/messages?maxMessages=50&maxPolls=3' | python3 -c \"import sys,json;msgs=json.load(sys.stdin);ids=set(m['MessageId'] for m in msgs);assert len(ids)>=10, f'expected >=10 unique, got {len(ids)}'\""
t "Messages still available"  "curl -sf '$API/queues/t-peek/messages?maxMessages=5' | python3 -c \"import sys,json;msgs=json.load(sys.stdin);assert len(msgs)>0, 'expected messages still visible after peek'\""
# Cleanup
curl -sf -X POST "$API/queues/t-peek/purge" -H 'Content-Type: application/json' -d '{}' > /dev/null 2>&1 || true
curl -s -X DELETE "$API/queues/t-peek" > /dev/null 2>&1 || true

echo ""
echo "--- FIFO Peek Message Pagination ---"
# Create a FIFO queue and populate with 15 messages in the same message group
curl -sf -X POST "$API/queues" -H 'Content-Type: application/json' -d '{"name":"t-peek-fifo.fifo"}' > /dev/null 2>&1 || true
for i in $(seq 1 15); do
  curl -sf -X POST "$API/queues/t-peek-fifo.fifo/messages" -H 'Content-Type: application/json' -d "{\"messageBody\":\"peek-fifo-msg-$i\",\"messageGroupId\":\"g1\",\"messageDeduplicationId\":\"dedup-$i\"}" > /dev/null 2>&1
done
sleep 1
t "FIFO first peek returns ≤10"  "curl -sf '$API/queues/t-peek-fifo.fifo/messages?maxMessages=10' | python3 -c \"import sys,json;msgs=json.load(sys.stdin);assert len(msgs)<=10, f'expected <=10, got {len(msgs)}'\""
t "FIFO maxPolls=5 gets >=10"    "curl -sf '$API/queues/t-peek-fifo.fifo/messages?maxMessages=50&maxPolls=5' | python3 -c \"import sys,json;msgs=json.load(sys.stdin);assert len(msgs)>=10, f'expected >=10, got {len(msgs)}'; bodies=[m['Body'] for m in msgs]; seqs=[int(b.split('-')[-1]) for b in bodies]; assert all(seqs[i] < seqs[i+1] for i in range(len(seqs)-1)), f'expected strictly increasing sequence, got {seqs}'\""
t "FIFO messages still available" "curl -sf '$API/queues/t-peek-fifo.fifo/messages?maxMessages=5' | python3 -c \"import sys,json;msgs=json.load(sys.stdin);assert len(msgs)>0, 'expected messages still visible after peek'\""
# Cleanup
curl -sf -X POST "$API/queues/t-peek-fifo.fifo/purge" -H 'Content-Type: application/json' -d '{}' > /dev/null 2>&1 || true
curl -s -X DELETE "$API/queues/t-peek-fifo.fifo" > /dev/null 2>&1 || true


echo ""
echo "--- Purge & Delete ---"
if [ "$DEACTIVATE_PURGE_LC" = "true" ]; then
  t "Purge queue blocked"      "curl -s -o /dev/null -w '%{http_code}' -X POST $API/queues/t-target/purge -H 'Content-Type: application/json' -d '{}' | grep -q 403"
else
  t "Purge queue"              "curl -sf -X POST $API/queues/t-target/purge -H 'Content-Type: application/json' -d '{}' | grep -q purged"
fi

if [ "$DEACTIVATE_DELETE_LC" = "true" ]; then
  t "Delete queue blocked"     "curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/queues/t-target | grep -q 403"
else
  t "Delete queue"             "curl -sf -X DELETE $API/queues/t-target | grep -q deleted"
  t "Deleted not in list"      "curl -sf $API/queues | python3 -c \"import sys,json;assert 't-target' not in [q['name'] for q in json.load(sys.stdin)['queues']]\""
fi

echo ""
echo "--- Cleanup ---"
for q in t-std t-fifo.fifo t-dlq t-src t-target t-peek t-peek-fifo.fifo t-attrs t-del; do
  curl -s -X DELETE "$API/queues/$q" > /dev/null 2>&1 || true
done
echo "  🧹 Test queues cleaned up"

echo ""
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
echo ""
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
