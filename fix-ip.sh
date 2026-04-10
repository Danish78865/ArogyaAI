#!/bin/bash

echo "🔍 Finding your current IP address..."

# Get the primary network interface IP
IP=$(ifconfig | grep -E "inet.*broadcast" | awk '{print $2}' | head -1)

if [ -z "$IP" ]; then
    # Fallback to en0
    IP=$(ifconfig en0 | grep "inet " | awk '{print $2}')
fi

if [ -z "$IP" ]; then
    echo "❌ Could not find IP address automatically"
    echo "📱 Please manually update these files:"
    echo "   mobile/src/services/api.js - change API_BASE_URL"
    echo "   mobile/src/services/dnaApi.js - change all URLs"
    exit 1
fi

echo "✅ Found IP: $IP"
echo ""
echo "📱 Updating mobile app files..."

# Update API file
sed -i.bak "s|http://[0-9]*\.[0-9]*\.[0-9]*:3001|http://$IP:3001|g" mobile/src/services/api.js

# Update DNA API file
sed -i.bak "s|http://[0-9]*\.[0-9]*\.[0-9]*:3001|http://$IP:3001|g" mobile/src/services/dnaApi.js

echo "✅ Updated to: http://$IP:3001"
echo ""
echo "🚀 Now restart your mobile app and test DNA analysis!"
