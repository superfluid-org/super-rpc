#!/usr/bin/env node

/**
 * Test script for improved sequential failover logic
 * This script simulates various failure scenarios to verify the enhanced failover works correctly
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

async function testFailover() {
  console.log('🧪 Testing Enhanced Sequential Failover Logic\n');

  const testCases = [
    {
      name: 'Basic Request - Should work',
      request: {
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
        id: 1
      },
      expected: 'success'
    },
    {
      name: 'Historical Request - Should trigger smart fallback',
      request: {
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [
          { to: '0x1234567890123456789012345678901234567890', data: '0x' },
          '0x123456' // Historical block number
        ],
        id: 2
      },
      expected: 'fallback_attempted'
    },
    {
      name: 'Batch Request - Should handle multiple requests',
      request: [
        { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 3 },
        { jsonrpc: '2.0', method: 'eth_gasPrice', params: [], id: 4 }
      ],
      expected: 'success'
    }
  ];

  for (const testCase of testCases) {
    console.log(`\n📋 Test: ${testCase.name}`);
    console.log(`Expected: ${testCase.expected}`);
    
    try {
      const response = await axios.post(`${BASE_URL}/base-mainnet`, testCase.request, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });
      
      console.log(`✅ Status: ${response.status}`);
      
      if (Array.isArray(response.data)) {
        console.log(`📊 Batch Response: ${response.data.length} items`);
        response.data.forEach((item, index) => {
          console.log(`   Item ${index + 1}: ${item.result ? 'Success' : 'Error'} (ID: ${item.id})`);
        });
      } else {
        console.log(`📊 Response: ${response.data.result ? 'Success' : 'Error'} (ID: ${response.data.id})`);
        if (response.data.error) {
          console.log(`❌ Error: ${response.data.error.message}`);
        }
      }
      
    } catch (error) {
      console.log(`❌ Request failed: ${error.message}`);
      if (error.response) {
        console.log(`   Status: ${error.response.status}`);
        console.log(`   Data: ${JSON.stringify(error.response.data)}`);
      }
    }
  }

  // Test health endpoints
  console.log('\n🏥 Testing Health Endpoints\n');
  
  try {
    const healthResponse = await axios.get(`${BASE_URL}/health`);
    console.log(`✅ Health Check: ${healthResponse.data.status}`);
    console.log(`   Upstream: ${healthResponse.data.upstream}`);
    console.log(`   Uptime: ${healthResponse.data.uptime}s`);
  } catch (error) {
    console.log(`❌ Health check failed: ${error.message}`);
  }

  try {
    const statsResponse = await axios.get(`${BASE_URL}/stats`);
    console.log(`✅ Stats: ${JSON.stringify(statsResponse.data.stats, null, 2)}`);
  } catch (error) {
    console.log(`❌ Stats check failed: ${error.message}`);
  }
}

// Run the test
testFailover().catch(console.error);

