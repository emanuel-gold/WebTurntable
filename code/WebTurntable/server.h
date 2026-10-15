#ifndef SERVER_H
#define SERVER_H

// Access point credentials
constexpr const char* WIFI_SSID       = "TURNTABLE";
constexpr const char* WIFI_PASSWORD   = "";

// Initialize the webserver
void initWebserver();

// Save turntable settings to flash if needed
void handleSettingsStorage();

// Periodically drop stale WebSocket clients
void handleWebSocketClients();

#endif // SERVER_H