#ifndef SERVER_H
#define SERVER_H

// Setup access point name and password (open)
constexpr const char* WIFI_SSID       = "TURNTABLE";
constexpr const char* WIFI_PASSWORD   = "";

// mDNS hostname, so the UI is also at http://turntable.local
constexpr const char* MDNS_HOSTNAME   = "turntable";

// Initialize the webserver, load saved settings and resume a saved spin
void initWebserver();

// Run commands queued by the WebSocket handler
void handleCommands();

// Send the state to clients while the disk moves
void handleStateBroadcast();

// Save turntable settings to flash if needed
void handleSettingsStorage();

// Periodically drop stale WebSocket clients
void handleWebSocketClients();

#endif // SERVER_H
