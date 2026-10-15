/*
    Webpage controllable turntable code.
*/

#include "server.h"
#include "turntable.h"

void setup()
{
    // Same speed as the ESP32 boot messages, so both show in one monitor
    Serial.begin(115200);

    // Initialize motor control pins
    for (uint8_t i = 0; i < 4; i++)
    {
        pinMode(MOTOR_PINS[i], OUTPUT);
        digitalWrite(MOTOR_PINS[i], LOW);
    }

    // Initialize LED pin for error indication
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, HIGH);

    // Initialize web server and load saved settings from flash
    initWebserver();
}

void loop()
{
    handleSettingsStorage();
    handleWebSocketClients();
    handleTurntable();
}