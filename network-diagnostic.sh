#!/bin/bash

echo "📱 Expo Go Network Diagnostic Tool"
echo "=================================="

echo "🔍 Step 1: Check Mac Network Configuration"
echo "Current IP: $(ifconfig | grep '192.0.0' | awk '{print $2}' | head -1)"
echo ""

echo "🔍 Step 2: Check Active Network Interfaces"
echo "Available interfaces:"
ifconfig | grep -E "en0|en1|en2|en3" | grep "inet " | awk '{print "  " $1 ": " $2}'

echo ""
echo "🔍 Step 3: Check for iPhone Hotspot"
echo "Looking for connected devices..."
arp -a | grep "192.0.0" | head -5

echo ""
echo "🔍 Step 4: Test Backend Connection"
echo "Testing backend at $(ifconfig | grep '192.0.0' | awk '{print $2}' | head -1):3001"
curl -s --max-time 3 "http://$(ifconfig | grep '192.0.0' | awk '{print $2}' | head -1):3001/health" && echo "✅ Backend reachable" || echo "❌ Backend not reachable"

echo ""
echo "📱 Expo Go Setup Instructions:"
echo "1. Ensure iPhone is connected to Mac's Personal Hotspot"
echo "2. Both devices must be on 192.0.0.x subnet"
echo "3. In Expo Go app, connect to: exp://192.0.0.2:8081"
echo "4. Or scan QR code from Expo terminal"
echo ""
echo "🔧 Troubleshooting:"
echo "- If iPhone not showing: Check Personal Hotspot is enabled"
echo "- If connection fails: Restart iPhone Personal Hotspot"
echo "- If IP changes: Run ./fix-ip.sh script"
echo "- If firewall issues: sudo ufw disable (temporary)"
