#ifndef WIRELESS_H
#define WIRELESS_H

#include <Arduino.h>

class AsyncWebServer;

// How the turntable is connected
enum class NetworkMode : uint8_t
{
    Connecting,     // Joining the saved network after power-up
    Lan,            // A client on the user's network, with no access point
    Setup,          // Setup access point with the captive page
    Joining,        // Trying a network picked on the setup page
    Joined,         // Joined; the setup access point stays up briefly so the page can say so
    AccessPoint     // Access point only, picked on the setup page (not saved)
};

// Snapshot of the connection for the UI
struct NetworkStatus
{
    NetworkMode mode;
    String ssid;        // Network joined, or being joined
    String ip;          // LAN address, when connected
    int32_t rssi;       // Signal strength in dBm, when connected
};

// Read the reset button, load the saved network, start Wi-Fi and mDNS, and add the setup routes
void networkBegin(AsyncWebServer &server);

// Run the connection state machine. Called from loop().
void handleNetwork();

// Current connection state
NetworkStatus networkStatus();

// Protocol name for a network mode
const char* networkModeName(NetworkMode mode);

// Restart into Wi-Fi setup, keeping the saved network until a new one connects
void networkRestartIntoSetup();

#endif // WIRELESS_H
