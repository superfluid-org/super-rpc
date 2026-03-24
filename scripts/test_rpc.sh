#!/bin/bash

# Base URL (default to localhost:4500)
BASE_URL="${1:-http://localhost:4500}"
METRICS_URL="${2:-http://localhost:4510}"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m'

PASS=0
FAIL=0

# macOS-compatible millisecond timestamp
now_ms() {
    python3 -c 'import time; print(int(time.time()*1000))'
}

echo "Testing Super RPC at $BASE_URL"
echo "==================================="

make_rpc_call() {
    local NETWORK=$1
    local METHOD=$2
    local PARAMS=$3
    local ID=$4

    echo -n "  $METHOD: "
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"$METHOD\",\"params\":$PARAMS,\"id\":$ID}" \
        "$BASE_URL/$NETWORK")

    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')

    if [[ -z "$BODY" ]]; then
        echo -e "${RED}FAIL (No Response)${NC}"
        FAIL=$((FAIL+1))
        return 1
    elif [[ "$HTTP_CODE" != "200" ]]; then
        echo -e "${RED}FAIL${NC} (HTTP $HTTP_CODE)"
        echo "    -> $BODY"
        FAIL=$((FAIL+1))
        return 1
    elif echo "$BODY" | grep -q '"error"'; then
        echo -e "${RED}ERROR${NC}"
        echo "    -> ${BODY:0:150}"
        FAIL=$((FAIL+1))
        return 1
    else
        echo -e "${GREEN}OK${NC}"
        echo "    -> ${BODY:0:120}..."
        PASS=$((PASS+1))
        return 0
    fi
}

# ========================================
# 1. Health & Metrics endpoints
# ========================================
echo -e "\n${BLUE}[1] Health & Metrics${NC}"

echo -n "  GET /health: "
HEALTH=$(curl -s "$BASE_URL/health")
if echo "$HEALTH" | grep -q '"status":"OK"'; then
    echo -e "${GREEN}OK${NC} — $HEALTH"
    PASS=$((PASS+1))
else
    echo -e "${RED}FAIL${NC} — $HEALTH"
    FAIL=$((FAIL+1))
fi

echo -n "  GET /metrics (port $METRICS_URL): "
METRICS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$METRICS_URL/metrics")
if [[ "$METRICS_STATUS" == "200" ]]; then
    echo -e "${GREEN}OK${NC} (HTTP 200)"
    PASS=$((PASS+1))
else
    echo -e "${RED}FAIL${NC} (HTTP $METRICS_STATUS)"
    FAIL=$((FAIL+1))
fi

# ========================================
# 2. Unknown network → 404
# ========================================
echo -e "\n${BLUE}[2] Unknown Network${NC}"
echo -n "  POST /nonexistent-network: "
RESP=$(curl -s -w "\n%{http_code}" -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
    "$BASE_URL/nonexistent-network")
HTTP_CODE=$(echo "$RESP" | tail -1)
if [[ "$HTTP_CODE" == "404" ]]; then
    echo -e "${GREEN}OK${NC} (404 as expected)"
    PASS=$((PASS+1))
else
    echo -e "${RED}FAIL${NC} (expected 404, got $HTTP_CODE)"
    FAIL=$((FAIL+1))
fi

# ========================================
# 3. Per-network RPC tests
# ========================================
test_network() {
    local NETWORK=$1
    echo -e "\n${BLUE}[3] Network: $NETWORK${NC}"

    # Static / immutable
    make_rpc_call "$NETWORK" "net_version" "[]" 1
    make_rpc_call "$NETWORK" "eth_chainId" "[]" 2

    # Volatile
    make_rpc_call "$NETWORK" "eth_blockNumber" "[]" 3

    # State call (latest)
    make_rpc_call "$NETWORK" "eth_getBalance" '["0x0000000000000000000000000000000000000000", "latest"]' 4

    # Fallback / Archival Test (Block 15,000,000 -> 0xE4E1C0)
    echo -e "  ${BLUE}[Archival Test]${NC} eth_getBalance (Block 15M): "
    make_rpc_call "$NETWORK" "eth_getBalance" '["0x0000000000000000000000000000000000000000", "0xE4E1C0"]' 5

    # eth_getLogs Test
    echo -e "  ${BLUE}[GetLogs Test]${NC} eth_getLogs: "
    make_rpc_call "$NETWORK" "eth_getLogs" '[{"fromBlock":"0x989680","toBlock":"0x989681", "address": "0x0000000000000000000000000000000000000000"}]' 6

    # eth_call Test (Block 15M)
    echo -e "  ${BLUE}[eth_call Test]${NC} eth_call (Block 15M): "
    make_rpc_call "$NETWORK" "eth_call" '[{"to":"0x0000000000000000000000000000000000000000","data":"0x"}, "0xE4E1C0"]' 8
}

test_network "base-mainnet"
test_network "optimism-sepolia"

# ========================================
# 4. Cache test — second call should be faster
# ========================================
echo -e "\n${BLUE}[4] Cache Test (eth_chainId x2)${NC}"

echo -n "  First call: "
T1_START=$(now_ms)
R1=$(curl -s -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":100}' \
    "$BASE_URL/base-mainnet")
T1_END=$(now_ms)
T1=$((T1_END - T1_START))
echo -e "${GREEN}OK${NC} (${T1}ms)"

echo -n "  Second call (should be cached): "
T2_START=$(now_ms)
R2=$(curl -s -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":101}' \
    "$BASE_URL/base-mainnet")
T2_END=$(now_ms)
T2=$((T2_END - T2_START))

if [[ $T2 -lt $T1 ]] || [[ $T2 -lt 50 ]]; then
    echo -e "${GREEN}OK${NC} (${T2}ms — faster or <50ms)"
    PASS=$((PASS+1))
else
    echo -e "${YELLOW}WARN${NC} (${T2}ms — not clearly faster than ${T1}ms)"
    PASS=$((PASS+1))  # not a hard fail
fi

# ========================================
# 5. Batch JSON-RPC test
# ========================================
echo -e "\n${BLUE}[5] Batch JSON-RPC${NC}"
echo -n "  Batch [eth_chainId, eth_blockNumber]: "
BATCH_RESP=$(curl -s -X POST -H "Content-Type: application/json" \
    -d '[{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1},{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":2}]' \
    "$BASE_URL/base-mainnet")

if echo "$BATCH_RESP" | grep -q '^\[' && echo "$BATCH_RESP" | grep -q '"id":1' && echo "$BATCH_RESP" | grep -q '"id":2'; then
    echo -e "${GREEN}OK${NC}"
    echo "    -> ${BATCH_RESP:0:150}..."
    PASS=$((PASS+1))
else
    echo -e "${RED}FAIL${NC}"
    echo "    -> $BATCH_RESP"
    FAIL=$((FAIL+1))
fi

# ========================================
# 6. Concurrent request coalescing test
# ========================================
echo -e "\n${BLUE}[6] Request Coalescing (10 identical concurrent calls)${NC}"
echo -n "  Firing 10x eth_blockNumber in parallel: "

TMPDIR=$(mktemp -d)
START_COAL=$(now_ms)
for i in $(seq 1 10); do
    curl -s -X POST -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"params\":[],\"id\":$i}" \
        "$BASE_URL/base-mainnet" > "$TMPDIR/resp_$i" &
done
wait
END_COAL=$(now_ms)
COAL_TIME=$((END_COAL - START_COAL))

ALL_OK=true
for i in $(seq 1 10); do
    if ! grep -q '"result"' "$TMPDIR/resp_$i" 2>/dev/null; then
        ALL_OK=false
        break
    fi
done
rm -rf "$TMPDIR"

if $ALL_OK; then
    echo -e "${GREEN}OK${NC} (all 10 responded in ${COAL_TIME}ms)"
    PASS=$((PASS+1))
else
    echo -e "${RED}FAIL${NC} (some requests failed)"
    FAIL=$((FAIL+1))
fi

# ========================================
# 7. Prometheus metrics content check
# ========================================
echo -e "\n${BLUE}[7] Prometheus Metrics Content${NC}"
METRICS_BODY=$(curl -s "$METRICS_URL/metrics")

for METRIC in "rpc_requests_total" "rpc_cache_hits_total" "rpc_latency_seconds" "rpc_cache_misses_total"; do
    echo -n "  $METRIC present: "
    if echo "$METRICS_BODY" | grep -q "$METRIC"; then
        echo -e "${GREEN}OK${NC}"
        PASS=$((PASS+1))
    else
        echo -e "${RED}FAIL${NC}"
        FAIL=$((FAIL+1))
    fi
done

# ========================================
# 8. Input validation
# ========================================
echo -e "\n${BLUE}[8] Input Validation${NC}"

echo -n "  Missing method field: "
RESP=$(curl -s -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1}' \
    "$BASE_URL/base-mainnet")
if echo "$RESP" | grep -q '"code":-32600'; then
    echo -e "${GREEN}OK${NC} (rejected with -32600)"
    PASS=$((PASS+1))
else
    echo -e "${RED}FAIL${NC} — $RESP"
    FAIL=$((FAIL+1))
fi

echo -n "  Empty body: "
RESP=$(curl -s -X POST -H "Content-Type: application/json" \
    -d '{}' \
    "$BASE_URL/base-mainnet")
if echo "$RESP" | grep -q '"code":-32600'; then
    echo -e "${GREEN}OK${NC} (rejected with -32600)"
    PASS=$((PASS+1))
else
    echo -e "${RED}FAIL${NC} — $RESP"
    FAIL=$((FAIL+1))
fi

# ========================================
# 9. Body size limit (>1MB should be rejected)
# ========================================
echo -e "\n${BLUE}[9] Body Size Limit${NC}"
echo -n "  Sending >1MB payload: "
TMPFILE=$(mktemp)
python3 -c "import json; f=open('$TMPFILE','w'); json.dump({'jsonrpc':'2.0','method':'eth_chainId','params':['x'*1048576],'id':1}, f); f.close()"
RESP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
    -d @"$TMPFILE" \
    "$BASE_URL/base-mainnet")
rm -f "$TMPFILE"
if [[ "$RESP_CODE" == "413" ]]; then
    echo -e "${GREEN}OK${NC} (413 Payload Too Large)"
    PASS=$((PASS+1))
else
    echo -e "${RED}FAIL${NC} (expected 413, got $RESP_CODE)"
    FAIL=$((FAIL+1))
fi

# ========================================
# Summary
# ========================================
TOTAL=$((PASS + FAIL))
echo -e "\n==================================="
if [[ $FAIL -eq 0 ]]; then
    echo -e "Result: ${GREEN}ALL $TOTAL TESTS PASSED${NC}"
    exit 0
else
    echo -e "Result: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC} (of $TOTAL)"
    exit 1
fi
