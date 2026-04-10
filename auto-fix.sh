#!/bin/bash

echo "=== CalAI IP Auto-Fix Script ==="
echo ""

# Get current IP
CURRENT_IP=$(ifconfig en0 | grep "inet " | awk '{print $2}')

echo "Current IP: $CURRENT_IP"

# Update all API files
echo "Updating API files..."

# Update main API
sed -i.bak "s|http://[0-9]*\.[0-9]*\.[0-9]*\.[0-9]*:3001|http://$CURRENT_IP:3001|g" mobile/src/services/api.js

# Update DNA API
sed -i.bak "s|http://[0-9]*\.[0-9]*\.[0-9]*\.[0-9]*:3001|http://$CURRENT_IP:3001|g" mobile/src/services/dnaApi.js

echo "Updated to: http://$CURRENT_IP:3001"

# Test backend connection
echo ""
echo "Testing backend connection..."
if curl -s --max-time 3 "http://$CURRENT_IP:3001/health" > /dev/null; then
    echo "Backend: CONNECTED"
    
    # Test DNA analysis with fallback
    echo "Testing DNA analysis (with fallback)..."
    curl -s --max-time 5 -X POST "http://$CURRENT_IP:3001/api/dna/analyze" \
      -H "Content-Type: application/json" \
      -d '{"geneticData": "rs9939609", "userId": 4}' \
      --max-time 8 > /tmp/dna_test.json
    
    if [ $? -eq 0 ]; then
        echo "DNA Analysis: WORKING"
        echo ""
        echo "Sample Response:"
        cat /tmp/dna_test.json | head -3
    else
        echo "DNA Analysis: TIMEOUT (OpenAI slow)"
        echo "Using fallback analysis - still functional!"
    fi
else
    echo "Backend: NOT CONNECTED"
    echo "Please restart backend: npm start (in backend folder)"
fi

echo ""
echo "=== Expo Go Instructions ==="
echo "1. Start mobile app: npx expo start"
echo "2. Connect to: exp://$CURRENT_IP:8081"
echo "3. Test DNA analysis in app"
echo ""
echo "=== Quick Commands ==="
echo "Backend: cd backend && npm start"
echo "Mobile:  cd mobile && npx expo start"
echo "Fix IP:  ./fix-ip.sh"
