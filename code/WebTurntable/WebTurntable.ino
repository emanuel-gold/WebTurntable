/*
    Webpage controllable turntable code.
*/

#include "config.h"
#include "motion.h"
#include "sequencer.h"
#include "server.h"
#include "shutter.h"
#include "wireless.h"

void setup()
{
    // Same speed as the ESP32 boot messages, so both show in one monitor
    Serial.begin(115200);

    // Initialize LED pin for error indication
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, HIGH);

    // Start the step timer and ramp task, then the web server (which applies saved settings)
    motionBegin();
    initWebserver();
}

void loop()
{
    handleNetwork();
    handleCommands();
    // After commands, so a sweep with no dwell starts its next leg before storage sees it idle
    handleSequencer();
    handleShutter();
    handleStateBroadcast();
    handleSettingsStorage();
    handleWebSocketClients();

    // Stepping runs on a timer now, so loop() can yield
    delay(1);
}
