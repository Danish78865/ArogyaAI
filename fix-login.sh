#!/bin/bash

echo "=== CalAI Login Fix Script ==="
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
    
    # Test login endpoint
    echo "Testing login endpoint..."
    LOGIN_RESULT=$(curl -s --max-time 5 -X POST "http://$CURRENT_IP:3001/api/auth/login" \
      -H "Content-Type: application/json" \
      -d '{"email": "user@calai.com", "password": "calai123"}')
    
    if echo "$LOGIN_RESULT" | grep -q "token"; then
        echo "Login: WORKING"
        echo ""
        echo "=== Login Credentials ==="
        echo "Email: user@calai.com"
        echo "Password: calai123"
        echo ""
        echo "=== Mobile App Instructions ==="
        echo "1. Clear app cache/storage"
        echo "2. Start mobile app: npx expo start"
        echo "3. Connect to: exp://$CURRENT_IP:8081"
        echo "4. Use login credentials above"
        echo "5. Go to DNA tab for testing"
    else
        echo "Login: FAILED"
        echo "Creating new test user..."
        curl -s --max-time 5 -X POST "http://$CURRENT_IP:3001/api/auth/register" \
          -H "Content-Type: application/json" \
          -d '{"email": "user@calai.com", "password": "calai123", "name": "CalAI User"}'
        echo "Test user created successfully!"
    fi
else
    echo "Backend: NOT CONNECTED"
    echo "Please restart backend: npm start (in backend folder)"
fi

echo ""
echo "=== Troubleshooting Login Issues ==="
echo "1. Clear mobile app storage/cache"
echo "2. Use correct credentials: user@calai.com / calai123"
echo "3. Ensure same WiFi network"
echo "4. Check IP: $CURRENT_IP"
echo "5. Restart mobile app if needed"
