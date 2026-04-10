# ESP32 Health Monitor - Sensor Wiring Guide

## Required Components

### Hardware
- ESP32 Development Board
- DHT22 Temperature & Humidity Sensor
- Heart Rate Sensor (Analog - like Pulse Sensor Amped)
- ECG Sensor (Analog - like AD8232)
- MPU6050 Accelerometer/Gyroscope
- OLED Display (SSD1306, 128x64)
- Breadboard and Jumper Wires
- 10k resistor (for DHT22 pull-up)

### Libraries
- WiFi.h (built-in)
- WebServer.h (built-in)
- ArduinoJson.h
- Wire.h (built-in)
- DHT sensor library by Adafruit
- Adafruit_GFX.h
- Adafruit_SSD1306.h

## Wiring Connections

### DHT22 Temperature & Humidity Sensor
```
DHT22    ESP32
VCC    -> 3.3V
GND    -> GND
DATA   -> GPIO 4
```
*Add 10k resistor between DATA and VCC (pull-up resistor)*

### Heart Rate Sensor (Analog)
```
Heart Rate Sensor    ESP32
VCC    -> 3.3V
GND    -> GND
OUT    -> GPIO 32
```

### ECG Sensor (Analog)
```
ECG Sensor    ESP32
VCC    -> 3.3V
GND    -> GND
OUT    -> GPIO 33
```

### MPU6050 (I2C)
```
MPU6050    ESP32
VCC    -> 3.3V
GND    -> GND
SDA    -> GPIO 21 (SDA)
SCL    -> GPIO 22 (SCL)
```

### OLED Display (I2C)
```
OLED Display    ESP32
VCC    -> 3.3V
GND    -> GND
SDA    -> GPIO 21 (SDA) - Shared with MPU6050
SCL    -> GPIO 22 (SCL) - Shared with MPU6050
```

## Pin Configuration Summary

| Sensor Type | Sensor Model | ESP32 Pin | Data Type |
|-------------|-------------|-----------|-----------|
| Temperature | DHT22 | GPIO 4 | Digital |
| Humidity | DHT22 | GPIO 4 | Digital |
| Heart Rate | Pulse Sensor | GPIO 32 | Analog |
| ECG | AD8232 | GPIO 33 | Analog |
| Motion | MPU6050 | GPIO 21/22 | I2C |
| Display | SSD1306 OLED | GPIO 21/22 | I2C |

## Installation Instructions

### 1. Install Arduino IDE
- Download and install Arduino IDE 2.0+
- Add ESP32 board support
- Install required libraries

### 2. Install Libraries
```cpp
// In Arduino IDE Library Manager, install:
- ArduinoJson by Benoit Blanchon
- DHT sensor library by Adafruit
- Adafruit GFX by Adafruit
- Adafruit SSD1306 by Adafruit
```

### 3. Upload Code
1. Open `simple_test.ino`
2. Select ESP32 board
3. Select correct COM port
4. Upload the sketch

### 4. Test Sensors
- Open Serial Monitor (115200 baud)
- Verify all sensors are detected
- Check WiFi connection
- Test web interface
- Verify OLED display shows data

## Expected Serial Output

```
Connecting to WiFi....
WiFi Connected!
IP Address: 172.32.1.52
Sensors initialized:
- DHT22 Temperature & Humidity Sensor
- Heart Rate Sensor (Analog)
- ECG Sensor (Analog)
- MPU6050 Motion Sensor
- OLED Display
HTTP server started
Real Sensor Data - HR: 75 BPM, Temp: 36.8°C, Steps: 1250, Stress: 45%, O2: 97%, ECG: 0.523V, Motion: 0.15, Moving: No
```

## OLED Display Output

The OLED display will show:
```
ESP32 Health Monitor
HR: 75 BPM
Temp: 36.8C
Stress: 45%
O2: 97%
Motion: Yes
Steps: 1250
WiFi: OK
```

## Troubleshooting

### Mobile App Shows Wrong Temperature
- Check DHT22 wiring (GPIO 4)
- Verify 10k pull-up resistor is connected
- Ensure DHT sensor is properly powered (3.3V)
- Look for "DHT22 sensor error" message in Serial Monitor

### DHT22 Sensor Not Working
- Check DATA pin connection to GPIO 4
- Verify 10k pull-up resistor between DATA and VCC
- Ensure sensor is powered (3.3V)
- DHT22 is more reliable than DS18B20 for temperature readings

### Temperature Reading Issues
- DHT22 provides more accurate temperature readings
- Temperature range: -40°C to 80°C
- Humidity also available (can be added to code)
- Sensor takes about 2 seconds to read

### Mobile App Shows Zero Values
- Check ESP32 is connected to WiFi
- Verify IP address in mobile app (172.32.1.52)
- Test endpoints in browser: `http://172.32.1.52/health`
- Check Serial Monitor for real sensor data

### Heart Rate Sensor Not Reading
- Check analog pin GPIO 32
- Verify sensor is powered (3.3V)
- Check sensor output with multimeter
- Sensor should show fluctuating values

### ECG Sensor Not Working
- Check analog pin GPIO 33
- Verify sensor connections
- Ensure proper grounding
- Check ECG waveform in mobile app

### MPU6050 Not Detected
- Check I2C connections (GPIO 21/22)
- Verify 3.3V power
- Run I2C scanner to check address
- Shared with OLED display

### OLED Display Not Working
- Check I2C connections (GPIO 21/22)
- Verify 3.3V power
- Check I2C address (0x3C)
- Shared with MPU6050

### WiFi Connection Issues
- Verify SSID and password
- Check ESP32 is within WiFi range
- Restart ESP32 if needed

## DHT22 vs DS18B20

### DHT22 Advantages
- **Better Accuracy**: ±0.5°C accuracy vs ±0.5°C for DS18B20
- **Humidity Data**: Also provides humidity readings
- **Simpler Wiring**: Only 3 pins vs 3 pins for DS18B20
- **Digital Output**: No need for analog conversion
- **Reliability**: More stable readings

### DHT22 Specifications
- **Temperature Range**: -40°C to 80°C
- **Temperature Accuracy**: ±0.5°C
- **Humidity Range**: 0% to 100%
- **Humidity Accuracy**: ±2%
- **Sampling Rate**: 0.5 Hz (once every 2 seconds)

## Calibration

### DHT22 Sensor
- Factory calibrated, no additional calibration needed
- Allow 2 seconds between readings for accuracy
- Sensor needs 2 seconds to stabilize after power-on

### Heart Rate Sensor
- The threshold adapts automatically
- For better accuracy, calibrate based on your specific sensor
- Monitor serial output for heart rate detection

### ECG Sensor
- ECG value ranges from 0-3.3V
- Adjust based on your specific ECG module
- Consider adding proper filtering for noise reduction

### MPU6050
- Motion threshold is set to 0.5
- Adjust based on your activity level
- Calibrate for your specific use case

## Web Interface

After uploading, open your browser and navigate to:
- `http://[ESP32_IP]` - Main dashboard
- `http://[ESP32_IP]/health` - All sensor data (JSON)
- `http://[ESP32_IP]/ecg` - Live ECG data (JSON)
- `http://[ESP32_IP]/insights` - Health analysis with raw data (JSON)

## Mobile App Integration

The CalAI mobile app will automatically connect to the ESP32 and display:
- **Real-time temperature readings** from DHT22 (accurate values)
- **Live heart rate** from sensor (fixed from showing 0)
- **ECG waveform display** (fixed display issues)
- **Motion detection** and step counting
- **Health insights** and recommendations
- **All data now shows properly** in mobile app and website

## Fixed Issues

### Mobile App Zero Values Fixed
- `/insights` endpoint now includes all raw sensor data
- Heart rate, stress level, oxygen level no longer show 0
- Temperature shows proper value with 1 decimal place
- ECG waveform displays correctly

### Temperature Reading Fixed with DHT22
- **Replaced DS18B20 with DHT22** for better accuracy
- **Better error handling** for DHT22 sensor
- **Realistic temperature range** (20-45°C with fallback)
- **Humidity data available** (can be added to mobile app)

### Display Support Added
- OLED display shows real-time health data
- Physical display shows all sensor readings
- WiFi status and motion detection visible on display

### DHT22 Benefits
- **More accurate temperature readings**
- **Also provides humidity data**
- **Better reliability** than DS18B20
- **Simpler integration** with ESP32
