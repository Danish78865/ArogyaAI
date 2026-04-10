// Test script to verify ESP32 connection
const axios = require('axios');

const ESP32_IP = 'http://172.32.1.52';

async function testESP32Connection() {
  console.log('Testing ESP32 connection...');
  console.log('ESP32 IP:', ESP32_IP);
  
  try {
    // Test health endpoint
    console.log('\n1. Testing /health endpoint...');
    const healthResponse = await axios.get(`${ESP32_IP}/health`, { timeout: 5000 });
    console.log('Health data:', healthResponse.data);
    
    // Test insights endpoint
    console.log('\n2. Testing /insights endpoint...');
    const insightsResponse = await axios.get(`${ESP32_IP}/insights`, { timeout: 5000 });
    console.log('Insights data:', insightsResponse.data);
    
    console.log('\n3. Testing root endpoint...');
    const rootResponse = await axios.get(`${ESP32_IP}/`, { timeout: 5000 });
    console.log('Root endpoint status:', rootResponse.status);
    
    console.log('\nAll tests passed! ESP32 is working correctly.');
    
  } catch (error) {
    console.error('Connection error:', error.message);
    console.log('\nTroubleshooting:');
    console.log('1. Make sure ESP32 is running the health_monitor.ino code');
    console.log('2. Verify ESP32 is connected to WiFi');
    console.log('3. Check if ESP32 IP is correct');
    console.log('4. Ensure ESP32 web server is running');
  }
}

testESP32Connection();
