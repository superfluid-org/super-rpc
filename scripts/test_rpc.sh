#!/bin/bash

# Base URL (default to localhost:4500)
BASE_URL="http://localhost:4500"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# Track failures
FAILURES=0

echo "Testing Super RPC at $BASE_URL"
echo "-----------------------------------"

make_rpc_call() {
    local NETWORK=$1
    local METHOD=$2
    local PARAMS=$3
    local ID=$4
    
    echo -n "  $METHOD: "
    RESPONSE=$(curl -s -X POST -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"$METHOD\",\"params\":$PARAMS,\"id\":$ID}" \
        "$BASE_URL/$NETWORK")
    
    # Simple check for error vs result
    # check for "error" property in JSON, or potential curl failures (empty response)
    if [[ -z "$RESPONSE" ]]; then
        echo -e "${RED}FAILED (No Response)${NC}"
        FAILURES=$((FAILURES+1))
    elif [[ $RESPONSE == *"\"error\""* ]]; then
        echo -e "${RED}ERROR${NC}"
        echo "    -> $RESPONSE"
        FAILURES=$((FAILURES+1))
    else
        echo -e "${GREEN}OK${NC}"
        # Print a snippet of the result to keep it clean, max 100 chars
        echo "    -> ${RESPONSE:0:100}..." 
    fi
}

test_network() {
    NETWORK=$1
    echo -e "\nTesting Network: ${BLUE}$NETWORK${NC}"
    
    # 1. Basic Static Calls
    make_rpc_call "$NETWORK" "net_version" "[]" 1
    make_rpc_call "$NETWORK" "eth_chainId" "[]" 2
    
    # 2. Volatile Calls
    make_rpc_call "$NETWORK" "eth_blockNumber" "[]" 3
    
    # 3. State Calls (Latest)
    make_rpc_call "$NETWORK" "eth_getBalance" "[\"0x0000000000000000000000000000000000000000\", \"latest\"]" 4
    
    # 4. Fallback / Archival Test (Block 15,000,000 -> 0xE4E1C0)
    # Note: Ensure this block exists on the network being tested!
    echo -e "  ${BLUE}[Archival Test]${NC} eth_getBalance (Block 15M): "
    make_rpc_call "$NETWORK" "eth_getBalance" "[\"0x0000000000000000000000000000000000000000\", \"0xE4E1C0\"]" 5

    # 5. eth_getLogs Test (Standard 10M range)
    echo -e "  ${BLUE}[GetLogs Test]${NC} eth_getLogs: "
    make_rpc_call "$NETWORK" "eth_getLogs" "[{\"fromBlock\":\"0x989680\",\"toBlock\":\"0x989681\", \"address\": \"0x0000000000000000000000000000000000000000\"}]" 6

    # 6. Immutable eth_call Test (Block 15M) - Simple call to 0x0...0
    # This checks our new caching logic for specific block tags
    echo -e "  ${BLUE}[eth_call Test]${NC} eth_call (Block 15M): "
    make_rpc_call "$NETWORK" "eth_call" "[{\"to\":\"0x0000000000000000000000000000000000000000\",\"data\":\"0x\"}, \"0xE4E1C0\"]" 8
}

# Configured Networks
test_network "base-mainnet"
test_network "optimism-sepolia"

echo -e "\n-----------------------------------"
if [ $FAILURES -eq 0 ]; then
    echo -e "${GREEN}All tests passed.${NC}"
    exit 0
else
    echo -e "${RED}$FAILURES tests failed.${NC}"
    exit 1
fi
