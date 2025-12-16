#!/bin/bash

# Quick test script to verify cache key generation
# Usage: ./test-cache-key.sh [network]

BASE_URL="http://localhost:4500"

if [ -n "$1" ]; then
  NETWORK="$1"
  ENDPOINT="${BASE_URL}/${NETWORK}"
  echo "Testing cache key generation - Network: ${NETWORK}"
else
  NETWORK="default"
  ENDPOINT="${BASE_URL}"
  echo "Testing cache key generation - Default endpoint"
fi

echo "=========================="
echo "Endpoint: ${ENDPOINT}"
echo "=========================="
echo ""

# Test 1: eth_getBlockReceipts with string block number
echo "Test 1: eth_getBlockReceipts with string block number"
echo "Request:"
cat <<EOF | jq '.'
{
  "jsonrpc": "2.0",
  "method": "eth_getBlockReceipts",
  "params": ["0x1000000"],
  "id": 1
}
EOF

echo ""
echo "Response:"
RESPONSE1=$(curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getBlockReceipts",
    "params": ["0x1000000"],
    "id": 1
  }')

echo "$RESPONSE1" | jq '.result | length' 2>/dev/null || echo "$RESPONSE1"
echo ""

# Wait and make same request (should be cached)
sleep 1
echo "Making same request again (should hit cache)..."
RESPONSE2=$(curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getBlockReceipts",
    "params": ["0x1000000"],
    "id": 2
  }')

echo "Response:"
echo "$RESPONSE2" | jq '.result | length' 2>/dev/null || echo "$RESPONSE2"
echo ""

# Check if results match
LEN1=$(echo "$RESPONSE1" | jq '.result | length' 2>/dev/null)
LEN2=$(echo "$RESPONSE2" | jq '.result | length' 2>/dev/null)

if [ "$LEN1" = "$LEN2" ] && [ -n "$LEN1" ]; then
  echo "✓ Cache working correctly - both responses have same length: $LEN1"
else
  echo "✗ Cache may not be working - lengths differ or missing"
fi

echo ""
echo "=========================="
echo "Test 2: eth_getLogs"
echo "=========================="
echo ""

echo "Request:"
cat <<EOF | jq '.'
{
  "jsonrpc": "2.0",
  "method": "eth_getLogs",
  "params": [{
    "fromBlock": "0x0",
    "toBlock": "0x100000"
  }],
  "id": 3
}
EOF

echo ""
echo "Response:"
RESPONSE3=$(curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getLogs",
    "params": [{
      "fromBlock": "0x0",
      "toBlock": "0x100000"
    }],
    "id": 3
  }')

echo "$RESPONSE3" | jq '.result | length' 2>/dev/null || echo "$RESPONSE3"
echo ""

echo "Check server logs to verify cache keys are properly generated (not [object Object])"
echo ""
