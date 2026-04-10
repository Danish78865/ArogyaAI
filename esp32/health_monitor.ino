#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <WiFiClient.h>

// WiFi Configuration
const char* ssid = "Hackathon-2025";
const char* password = "20252025";

// Web server on port 80
WebServer server(80);

// Health monitoring variables
float heartRate = 0;
float bodyTemperature = 0;
int steps = 0;
float stressLevel = 0;
float oxygenLevel = 0;
unsigned long lastUpdateTime = 0;
const unsigned long updateInterval = 2000; // Update every 2 seconds

// Simulate sensor data (replace with actual sensors)
void simulateHealthData() {
  // Simulate realistic health data
  heartRate = 60 + random(20, 40); // 60-100 BPM
  bodyTemperature = 36.0 + random(-5, 15) / 10.0; // 35.5-37.5°C
  steps += random(0, 5); // Random steps
  stressLevel = random(20, 80); // 20-80 stress level
  oxygenLevel = 95 + random(-3, 4); // 92-99% oxygen
}

void setup() {
  Serial.begin(115200);
  
  // Initialize WiFi
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  
  Serial.println("\n✅ Connected to WiFi!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());

  // Setup web server routes
  server.on("/", handleRoot);
  server.on("/health", handleHealthData);
  server.on("/insights", handleHealthInsights);
  
  server.begin();
  Serial.println("HTTP server started");
}

void loop() {
  server.handleClient();
  
  // Update health data every 2 seconds
  if (millis() - lastUpdateTime > updateInterval) {
    simulateHealthData();
    lastUpdateTime = millis();
    
    // Print to Serial for debugging
    Serial.print("HR: "); Serial.print(heartRate);
    Serial.print(" BPM, Temp: "); Serial.print(bodyTemperature);
    Serial.print("°C, Steps: "); Serial.print(steps);
    Serial.print(", Stress: "); Serial.print(stressLevel);
    Serial.print("%, O2: "); Serial.print(oxygenLevel);
    Serial.println("%");
  }
}

void handleRoot() {
  String html = generateHTMLPage();
  server.send(200, "text/html", html);
}

void handleHealthData() {
  // Create JSON response with current health data
  StaticJsonDocument<200> doc;
  
  doc["timestamp"] = millis();
  doc["heartRate"] = heartRate;
  doc["bodyTemperature"] = bodyTemperature;
  doc["steps"] = steps;
  doc["stressLevel"] = stressLevel;
  doc["oxygenLevel"] = oxygenLevel;
  doc["deviceStatus"] = "online";
  
  String response;
  serializeJson(doc, response);
  
  server.send(200, "application/json", response);
}

void handleHealthInsights() {
  // Generate AI-like health insights based on data
  StaticJsonDocument<500> doc;
  
  // Analyze health patterns
  String heartStatus = (heartRate > 100) ? "Elevated" : 
                      (heartRate < 60) ? "Low" : "Normal";
  
  String stressStatus = (stressLevel > 70) ? "High" :
                      (stressLevel > 40) ? "Moderate" : "Low";
  
  String tempStatus = (bodyTemperature > 37.2) ? "Elevated" :
                     (bodyTemperature < 36.0) ? "Low" : "Normal";
  
  String overallHealth = "Good";
  if (heartRate > 100 || stressLevel > 70 || bodyTemperature > 37.5) {
    overallHealth = "Needs Attention";
  } else if (heartRate > 80 || stressLevel > 50) {
    overallHealth = "Fair";
  }
  
  // Generate recommendations
  String recommendation = "Continue monitoring your health metrics.";
  if (stressLevel > 70) {
    recommendation = "Consider stress reduction techniques like deep breathing or meditation.";
  } else if (heartRate > 100) {
    recommendation = "Heart rate is elevated. Consider resting and monitoring.";
  } else if (oxygenLevel < 95) {
    recommendation = "Oxygen levels are slightly low. Ensure proper ventilation.";
  } else if (steps < 100) {
    recommendation = "Low activity detected. Consider a short walk.";
  }
  
  doc["timestamp"] = millis();
  doc["heartStatus"] = heartStatus;
  doc["stressStatus"] = stressStatus;
  doc["temperatureStatus"] = tempStatus;
  doc["overallHealth"] = overallHealth;
  doc["recommendation"] = recommendation;
  doc["dataPoints"] = 5;
  doc["deviceUptime"] = millis() / 1000;
  
  String response;
  serializeJson(doc, response);
  
  server.send(200, "application/json", response);
}

String generateHTMLPage() {
  return R"(
<!DOCTYPE html>
<html>
<head>
    <title>ESP32 Health Monitor</title>
    <meta name='viewport' content='width=device-width, initial-scale=1'>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .metric { display: flex; justify-content: space-between; margin: 10px 0; padding: 15px; background: #f8f9fa; border-radius: 5px; }
        .value { font-size: 24px; font-weight: bold; color: #007bff; }
        .label { color: #666; }
        .status { padding: 10px; margin: 10px 0; border-radius: 5px; text-align: center; }
        .good { background: #d4edda; color: #155724; }
        .warning { background: #fff3cd; color: #856404; }
        .danger { background: #f8d7da; color: #721c24; }
    </style>
</head>
<body>
    <div class='container'>
        <h1>🏥 ESP32 Health Monitor</h1>
        <div class='metric'>
            <span class='label'>Heart Rate:</span>
            <span class='value'>)" + String(heartRate) + R"( BPM</span>
        </div>
        <div class='metric'>
            <span class='label'>Temperature:</span>
            <span class='value'>)" + String(bodyTemperature) + R"(°C</span>
        </div>
        <div class='metric'>
            <span class='label'>Steps:</span>
            <span class='value'>)" + String(steps) + R"(</span>
        </div>
        <div class='metric'>
            <span class='label'>Stress Level:</span>
            <span class='value'>)" + String(stressLevel) + R"(%</span>
        </div>
        <div class='metric'>
            <span class='label'>Oxygen Level:</span>
            <span class='value'>)" + String(oxygenLevel) + R"(%</span>
        </div>
        <div class='status good'>
            ✅ Device Online - Data Updated Every 2 Seconds
        </div>
        <h3>API Endpoints:</h3>
        <p><strong>/health</strong> - Raw health data (JSON)</p>
        <p><strong>/insights</strong> - AI-generated health insights (JSON)</p>
        <p><small>Refresh page for live data</small></p>
    </div>
    <script>
        // Auto-refresh every 2 seconds
        setTimeout(() => location.reload(), 2000);
    </script>
</body>
</html>
  )";
}
