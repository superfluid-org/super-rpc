#!/bin/bash

# Test script for Augmented RPC Proxy with comprehensive test cases
BASE_URL="http://localhost:3000"

echo "Testing Augmented RPC Proxy"
echo "=========================="

# Test 1: Basic block number
echo "Test 1: Basic block number"
curl -s -X POST $BASE_URL/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}' \
  | jq '.'

echo -e "\n"

# Test 2: Get logs with valid Ethereum address (USDC contract on Base)
echo "Test 2: Get logs (USDC contract)"
curl -s -X POST $BASE_URL/ \
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
  }' | jq '.result | length' 2>/dev/null || echo "Response received (truncated)"

echo -e "\n"

# Test 3: Get logs with Transfer event topic
echo "Test 3: Get logs with Transfer event"
curl -s -X POST $BASE_URL/ \
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
  }' | jq '.'

echo -e "\n"

# Test 4: Batch request
echo "Test 4: Batch request (parallel processing)"
curl -s -X POST $BASE_URL/ \
  -H "Content-Type: application/json" \
  -d '[
    {"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1},
    {"jsonrpc": "2.0", "method": "eth_chainId", "params": [], "id": 2},
    {"jsonrpc": "2.0", "method": "net_version", "params": [], "id": 3}
  ]' | jq '.'

echo -e "\n"

# Test 5: Cache performance test
echo "Test 5: Cache performance test"
echo "First request (cache miss):"
time curl -s -X POST $BASE_URL/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 4}' \
  | jq '.'

echo "Second request (cache hit):"
time curl -s -X POST $BASE_URL/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 5}' \
  | jq '.'

echo -e "\n"

# Test 6: Multi-network request (Base)
echo "Test 6: Multi-network request (Base)"
curl -s -X POST $BASE_URL/base-mainnet \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 6}' \
  | jq '.'

echo -e "\n"

# Test 7: Call contract (get USDC total supply)
echo "Test 7: Call contract (USDC total supply)"
curl -s -X POST $BASE_URL/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_call",
    "params": [{
      "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "data": "0x18160ddd"
    }, "latest"],
    "id": 7
  }' | jq '.'

echo -e "\n"

# Test 8: Get transaction receipt (if you have a valid tx hash)
echo "Test 8: Get transaction receipt"
curl -s -X POST $BASE_URL/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getTransactionReceipt",
    "params": ["0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"],
    "id": 8
  }' | jq '.'

echo -e "\n"

# Test 9: Metrics endpoint
echo "Test 9: Prometheus metrics"
curl -s $BASE_URL/metrics | head -20

echo -e "\n"

# Test 10: Stats endpoint
echo "Test 10: Proxy stats"
curl -s $BASE_URL/stats | jq '.'

echo -e "\nTesting complete!"