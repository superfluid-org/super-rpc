#!/bin/bash

# Base URL (default to localhost:4500)
BASE_URL="http://localhost:4500"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

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
    if [[ $RESPONSE == *"error"* ]]; then
        echo -e "${RED}ERROR${NC}"
        echo "    -> $RESPONSE"
    else
        echo -e "${GREEN}OK${NC}"
        # Print a snippet of the result to keep it clean
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
    # Checking zero address balance
    make_rpc_call "$NETWORK" "eth_getBalance" "[\"0x0000000000000000000000000000000000000000\", \"latest\"]" 4
    
    # 4. Fallback / Archival Test (Block 1)
    # This should trigger the fallback if the primary node is not archival
    echo -e "  ${BLUE}[Archival Test]${NC} eth_getBalance (Block 1): "
    RESPONSE=$(curl -s -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x0000000000000000000000000000000000000000", "0x1"],"id":5}' \
        "$BASE_URL/$NETWORK")
        
    if [[ $RESPONSE == *"error"* ]]; then
         echo -e "${RED}FAILED (Fallback didn't work or not archival)${NC}"
         echo "    -> $RESPONSE"
    else
         echo -e "${GREEN}OK (Archival Data Retrieved)${NC}"
         echo "    -> $RESPONSE"
    fi
}

# Configured Networks
test_network "base-mainnet"
test_network "optimism-sepolia"

echo -e "\n-----------------------------------"
echo "Done."
