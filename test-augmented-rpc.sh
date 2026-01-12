#!/bin/bash

# Test script for Augmented RPC Proxy with comprehensive test cases
# Usage: ./test-augmented-rpc.sh [network]
# Example: ./test-augmented-rpc.sh base-mainnet
#          ./test-augmented-rpc.sh polygon-mainnet

BASE_URL="http://localhost:4500"

# Network selection: use argument if provided, otherwise use default endpoint
if [ -n "$1" ]; then
  NETWORK="$1"
  ENDPOINT="${BASE_URL}/${NETWORK}"
  echo "Testing Augmented RPC Proxy - Network: ${NETWORK}"
else
  NETWORK="default"
  ENDPOINT="${BASE_URL}"
  echo "Testing Augmented RPC Proxy - Default endpoint (uses RPC_URL or first network)"
fi

echo "=========================="
echo "Base URL: ${BASE_URL}"
echo "Endpoint: ${ENDPOINT}"
echo "Network: ${NETWORK}"
echo "=========================="
echo ""

# Test 1: Basic block number
echo "Test 1: Basic block number"
curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}' \
  | jq '.'

echo -e "\n"

# Test 2: Get logs with valid Ethereum address (USDC contract on Base)
echo "Test 2: Get logs (USDC contract) - historical query"
LOGS_COUNT=$(curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getLogs",
    "params": [{
      "fromBlock": "0x1000000",
      "toBlock": "0x1000001",
      "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    }],
    "id": 2
  }' | jq '.result | length')
echo "Logs found: $LOGS_COUNT"
if [ "$LOGS_COUNT" -gt 0 ]; then
  echo "✅ PASS: Got logs from historical query"
else
  echo "❌ FAIL: No logs returned - fallback might not be working!"
fi

echo -e "\n"

# Test 3: Get logs with Transfer event topic
echo "Test 3: Get logs with Transfer event topic"
curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getLogs",
    "params": [{
      "fromBlock": "0x1000000",
      "toBlock": "0x1000100",
      "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "topics": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
    }],
    "id": 3
  }' | jq '.result | length'

echo -e "\n"

# Test 4: Address case normalization test
echo "Test 4: Address case normalization (cache key test)"
echo "Request with UPPERCASE address:"
UPPER_COUNT=$(curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getLogs",
    "params": [{
      "fromBlock": "0x1000000",
      "toBlock": "0x1000001",
      "address": "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913"
    }],
    "id": 4
  }' | jq '.result | length')
echo "Logs with UPPERCASE: $UPPER_COUNT"

echo "Request with lowercase address (should be cache HIT with same count):"
LOWER_COUNT=$(curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getLogs",
    "params": [{
      "fromBlock": "0x1000000",
      "toBlock": "0x1000001",
      "address": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
    }],
    "id": 5
  }' | jq '.result | length')
echo "Logs with lowercase: $LOWER_COUNT"

if [ "$UPPER_COUNT" == "$LOWER_COUNT" ]; then
  echo "✅ PASS: Address case normalization working"
else
  echo "❌ FAIL: Different results for same address with different case"
fi

echo -e "\n"

# Test 5: Batch request
echo "Test 5: Batch request (parallel processing)"
curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -d '[
    {"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1},
    {"jsonrpc": "2.0", "method": "eth_chainId", "params": [], "id": 2},
    {"jsonrpc": "2.0", "method": "net_version", "params": [], "id": 3}
  ]' | jq '.'

echo -e "\n"

# Test 6: Cache performance test
echo "Test 6: Cache performance test"
echo "First request (cache miss):"
time curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 6}' \
  | jq '.'

echo "Second request (cache hit - should be faster):"
time curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 7}' \
  | jq '.'

echo -e "\n"

# Test 7: Chain ID verification
echo "Test 7: Chain ID verification"
curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "eth_chainId", "params": [], "id": 8}' \
  | jq '.'

echo -e "\n"

# Test 8: Call contract (get USDC total supply)
echo "Test 8: Call contract (USDC total supply)"
curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_call",
    "params": [{
      "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "data": "0x18160ddd"
    }, "latest"],
    "id": 9
  }' | jq '.'

echo -e "\n"

# Test 9: Historical eth_call (should be cached forever)
echo "Test 9: Historical eth_call (specific block - cached forever)"
curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_call",
    "params": [{
      "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "data": "0x18160ddd"
    }, "0x1000000"],
    "id": 10
  }' | jq '.'

echo -e "\n"

# Test 10: Get transaction receipt
echo "Test 10: Get transaction receipt (invalid hash - should return null)"
curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getTransactionReceipt",
    "params": ["0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"],
    "id": 11
  }' | jq '.'

echo -e "\n"

# Test 11: Metrics endpoint
echo "Test 11: Prometheus metrics (cache stats)"
curl -s $BASE_URL/metrics | grep -E "rpc_(cache|http)" | head -20

echo -e "\n"

# Test 12: Cache stats
echo "Test 12: Cache stats"
curl -s $BASE_URL/cache/stats | jq '.'

echo -e "\n"

# Test 13: Health check
echo "Test 13: Health check"
curl -s $BASE_URL/health | jq '.'

echo -e "\n"

# Test 14: Fallback test - Query very old block (tests archive fallback)
echo "Test 14: Fallback test - Query old historical data"
echo "Querying very old block range (should trigger fallback if primary lacks archive)..."
OLD_LOGS=$(curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getLogs",
    "params": [{
      "fromBlock": "0x100000",
      "toBlock": "0x100010",
      "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    }],
    "id": 14
  }' | jq '.result | length')
echo "Logs from old blocks: $OLD_LOGS"
echo "(Check server logs for 'trying fallback' messages)"

echo -e "\n=========================="
echo "Testing complete!"
echo "Network tested: ${NETWORK}"
echo ""
echo "Summary:"
echo "- If historical queries return 0 logs, check that fallback is configured"
echo "- Check server logs for 'fallback' messages to verify archive node usage"
echo "=========================="
