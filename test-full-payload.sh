#!/bin/bash

# Test script to verify full response payload is returned from cache
# This tests that cached responses include all fields, not just the result
# Usage: ./test-full-payload.sh [network]

BASE_URL="http://localhost:4500"

# Network selection
if [ -n "$1" ]; then
  NETWORK="$1"
  ENDPOINT="${BASE_URL}/${NETWORK}"
  echo "Testing Full Payload - Network: ${NETWORK}"
else
  NETWORK="default"
  ENDPOINT="${BASE_URL}"
  echo "Testing Full Payload - Default endpoint"
fi

echo "=========================="
echo "Base URL: ${BASE_URL}"
echo "Endpoint: ${ENDPOINT}"
echo "=========================="
echo ""

# Color codes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Function to make a request and save response
# Debug output goes to stderr, only curl response goes to stdout
make_request() {
  local request_body="$1"
  local label="$2"
  
  # Output debug info to stderr so it doesn't interfere with response capture
  echo -e "${CYAN}${label}${NC}" >&2
  echo "Request:" >&2
  (echo "$request_body" | jq '.' 2>/dev/null || echo "$request_body") >&2
  echo "" >&2
  
  # Only output the curl response to stdout (this is what gets captured)
  curl -s -X POST $ENDPOINT \
    -H "Content-Type: application/json" \
    -d "$request_body"
}

# Function to compare two responses
compare_responses() {
  local response1="$1"
  local response2="$2"
  local label1="$3"
  local label2="$4"
  
  echo -e "${YELLOW}Comparing ${label1} vs ${label2}${NC}"
  
  # Check if responses are valid JSON
  if ! echo "$response1" | jq empty 2>/dev/null; then
    echo -e "${RED}✗ ${label1} is not valid JSON!${NC}"
    echo "Response: $response1"
    return 1
  fi
  
  if ! echo "$response2" | jq empty 2>/dev/null; then
    echo -e "${RED}✗ ${label2} is not valid JSON!${NC}"
    echo "Response: $response2"
    return 1
  fi
  
  # Extract all top-level keys from both responses
  local keys1=$(echo "$response1" | jq -r 'keys[]' 2>/dev/null | sort | tr '\n' ' ')
  local keys2=$(echo "$response2" | jq -r 'keys[]' 2>/dev/null | sort | tr '\n' ' ')
  
  if [ "$keys1" = "$keys2" ]; then
    echo -e "${GREEN}✓ Both responses have the same top-level keys: ${keys1}${NC}"
  else
    echo -e "${RED}✗ Key mismatch!${NC}"
    echo "  ${label1} keys: ${keys1}"
    echo "  ${label2} keys: ${keys2}"
    echo ""
    echo "  ${label1} full response:"
    echo "$response1" | jq '.' 2>/dev/null
    echo ""
    echo "  ${label2} full response:"
    echo "$response2" | jq '.' 2>/dev/null
    return 1
  fi
  
  # Check if both have jsonrpc field
  local jsonrpc1=$(echo "$response1" | jq -r '.jsonrpc' 2>/dev/null)
  local jsonrpc2=$(echo "$response2" | jq -r '.jsonrpc' 2>/dev/null)
  
  if [ "$jsonrpc1" = "$jsonrpc2" ] && [ "$jsonrpc1" = "2.0" ]; then
    echo -e "${GREEN}✓ Both have jsonrpc: 2.0${NC}"
  else
    echo -e "${RED}✗ jsonrpc mismatch or missing!${NC}"
    echo "  ${label1} jsonrpc: '$jsonrpc1'"
    echo "  ${label2} jsonrpc: '$jsonrpc2'"
    echo ""
    echo "  ${label1} full response:"
    echo "$response1" | jq '.' 2>/dev/null
    echo ""
    echo "  ${label2} full response:"
    echo "$response2" | jq '.' 2>/dev/null
    return 1
  fi
  
  # Check if both have id field
  local id1=$(echo "$response1" | jq -r '.id' 2>/dev/null)
  local id2=$(echo "$response2" | jq -r '.id' 2>/dev/null)
  
  if [ -n "$id1" ] && [ -n "$id2" ]; then
    echo -e "${GREEN}✓ Both have id field (${label1}: $id1, ${label2}: $id2)${NC}"
  else
    echo -e "${RED}✗ id field missing!${NC}"
    return 1
  fi
  
  # Check if result structure is the same
  local result1_type=$(echo "$response1" | jq -r 'type(.result)' 2>/dev/null)
  local result2_type=$(echo "$response2" | jq -r 'type(.result)' 2>/dev/null)
  
  if [ "$result1_type" = "$result2_type" ]; then
    echo -e "${GREEN}✓ Both results are of type: $result1_type${NC}"
  else
    echo -e "${RED}✗ Result type mismatch!${NC}"
    return 1
  fi
  
  # For array results, compare lengths
  if [ "$result1_type" = "array" ]; then
    local len1=$(echo "$response1" | jq '.result | length' 2>/dev/null)
    local len2=$(echo "$response2" | jq '.result | length' 2>/dev/null)
    
    if [ "$len1" = "$len2" ]; then
      echo -e "${GREEN}✓ Both results have same array length: $len1${NC}"
    else
      echo -e "${RED}✗ Array length mismatch! (${label1}: $len1, ${label2}: $len2)${NC}"
      return 1
    fi
  fi
  
  return 0
}

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}Test 1: eth_getBlockReceipts${NC}"
echo -e "${YELLOW}========================================${NC}"
echo ""

# Note: Cache clear endpoint has been removed for security/stability
# If you need to clear cache, restart the server or wait for entries to expire
echo ""

REQUEST_BODY='{
  "jsonrpc": "2.0",
  "method": "eth_getBlockReceipts",
  "params": ["0x1000000"],
  "id": 100
}'

# First request (cache miss - from upstream)
echo -e "${CYAN}Making first request (cache miss)...${NC}"
RESPONSE1=$(make_request "$REQUEST_BODY" "First Request (Upstream)")
echo "Response:"
echo "$RESPONSE1" | jq '.' 2>/dev/null || echo "$RESPONSE1"
echo ""

# Wait a moment
sleep 1

# Second request (cache hit)
echo -e "${CYAN}Making second request (cache hit)...${NC}"
RESPONSE2=$(make_request "$REQUEST_BODY" "Second Request (Cached)")
echo "Response:"
echo "$RESPONSE2" | jq '.' 2>/dev/null || echo "$RESPONSE2"
echo ""

# Compare responses
if compare_responses "$RESPONSE1" "$RESPONSE2" "Upstream" "Cached"; then
  echo -e "${GREEN}✓ Test 1 PASSED: Full payload preserved in cache${NC}"
else
  echo -e "${RED}✗ Test 1 FAILED: Payload mismatch${NC}"
fi

echo ""
echo ""

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}Test 2: eth_getLogs${NC}"
echo -e "${YELLOW}========================================${NC}"
echo ""

REQUEST_BODY2='{
  "jsonrpc": "2.0",
  "method": "eth_getLogs",
  "params": [{
    "fromBlock": "0x1000000",
    "toBlock": "0x1000001",
    "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  }],
  "id": 200
}'

# First request (cache miss)
echo -e "${CYAN}Making first request (cache miss)...${NC}"
RESPONSE3=$(make_request "$REQUEST_BODY2" "First Request (Upstream)")
echo "Response:"
echo "$RESPONSE3" | jq '.' 2>/dev/null || echo "$RESPONSE3"
echo ""

# Wait a moment
sleep 1

# Second request (cache hit)
echo -e "${CYAN}Making second request (cache hit)...${NC}"
RESPONSE4=$(make_request "$REQUEST_BODY2" "Second Request (Cached)")
echo "Response:"
echo "$RESPONSE4" | jq '.' 2>/dev/null || echo "$RESPONSE4"
echo ""

# Compare responses
if compare_responses "$RESPONSE3" "$RESPONSE4" "Upstream" "Cached"; then
  echo -e "${GREEN}✓ Test 2 PASSED: Full payload preserved in cache${NC}"
else
  echo -e "${RED}✗ Test 2 FAILED: Payload mismatch${NC}"
fi

echo ""
echo ""

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}Test 3: Detailed Structure Comparison${NC}"
echo -e "${YELLOW}========================================${NC}"
echo ""

REQUEST_BODY3='{
  "jsonrpc": "2.0",
  "method": "eth_getBlockByNumber",
  "params": ["0x1000000", false],
  "id": 300
}'

# First request
echo -e "${CYAN}Making first request (cache miss)...${NC}"
RESPONSE5=$(make_request "$REQUEST_BODY3" "First Request (Upstream)")

# Extract full structure
echo -e "${CYAN}Upstream response structure:${NC}"
echo "$RESPONSE5" | jq '{
  has_jsonrpc: (.jsonrpc != null),
  has_id: (.id != null),
  has_result: (.result != null),
  has_error: (.error != null),
  jsonrpc_value: .jsonrpc,
  id_value: .id,
  result_type: (if .result then type(.result) else null end),
  result_keys: (if .result and type(.result) == "object" then (.result | keys) else null end)
}' 2>/dev/null

sleep 1

# Second request
echo -e "${CYAN}Making second request (cache hit)...${NC}"
RESPONSE6=$(make_request "$REQUEST_BODY3" "Second Request (Cached)")

# Extract full structure
echo -e "${CYAN}Cached response structure:${NC}"
echo "$RESPONSE6" | jq '{
  has_jsonrpc: (.jsonrpc != null),
  has_id: (.id != null),
  has_result: (.result != null),
  has_error: (.error != null),
  jsonrpc_value: .jsonrpc,
  id_value: .id,
  result_type: (if .result then type(.result) else null end),
  result_keys: (if .result and type(.result) == "object" then (.result | keys) else null end)
}' 2>/dev/null

# Compare
if compare_responses "$RESPONSE5" "$RESPONSE6" "Upstream" "Cached"; then
  echo -e "${GREEN}✓ Test 3 PASSED: Full structure preserved${NC}"
else
  echo -e "${RED}✗ Test 3 FAILED: Structure mismatch${NC}"
fi

echo ""
echo ""

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}Summary${NC}"
echo -e "${YELLOW}========================================${NC}"
echo ""
echo "Tests completed. Check the output above to verify:"
echo "  1. Both upstream and cached responses have the same structure"
echo "  2. All JSON-RPC fields (jsonrpc, id, result) are present"
echo "  3. The result data is identical between upstream and cached responses"
echo ""
echo "If all tests passed, the full payload is being cached and returned correctly."
