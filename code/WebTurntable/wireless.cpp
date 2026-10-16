#include "wireless.h"
#include "config.h"
#include "server.h"

#include <ArduinoJson.h>
#include <DNSServer.h>
#include <ESPAsyncWebServer.h>
#include <ESPmDNS.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WiFi.h>

#include <esp_attr.h>
#include <esp_system.h>

namespace
{
    // Setup access point address. The ESP32 default, 192.168.4.1, is the home router's address here.
    // Phones get DHCP leases from the next address up (192.168.4.6 onward).
    const IPAddress AP_IP(192, 168, 4, 5);
    const IPAddress AP_SUBNET(255, 255, 255, 0);
    constexpr char AP_URL[] = "http://192.168.4.5";

    constexpr char WIFI_NAMESPACE[] = "wifi";
    constexpr unsigned long CONNECT_TIMEOUT_MS = 20000;     // Saved network at power-up, or a new one from setup
    constexpr unsigned long JOINED_GRACE_MS = 30000;        // Setup access point stays up after joining
    constexpr unsigned long RETRY_INTERVAL_MS = 60000;      // Retry the saved network while in setup
    constexpr unsigned long RETRY_ATTEMPT_MS = 15000;
    constexpr unsigned long SCAN_MAX_AGE_MS = 15000;
    constexpr unsigned long RESET_HOLD_MS = 1000;
    constexpr uint32_t SETUP_MAGIC = 0x53455455;            // "SETU"

    // Set by "Change Wi-Fi network". Survives esp_restart() but not a power cycle.
    RTC_NOINIT_ATTR uint32_t s_bootIntoSetup;

    DNSServer dns;
    Preferences wifiPrefs;

    // Owned by loop()
    NetworkMode mode = NetworkMode::Connecting;
    unsigned long modeSinceMs = 0;
    String savedSsid;
    String savedPass;
    String joinSsid;
    String joinPass;
    bool retrySaved = false;        // In setup only because the saved network wasn't found
    bool retrying = false;
    unsigned long lastRetryMs = 0;
    bool scanning = false;
    unsigned long lastScanMs = 0;
    bool wasConnected = false;

    // Written by the Wi-Fi event task
    volatile uint8_t s_disconnectReason = 0;

    // Shared with the HTTP handlers in the AsyncTCP task, guarded by s_lock
    SemaphoreHandle_t s_lock = nullptr;
    struct Shared
    {
        NetworkMode mode = NetworkMode::Connecting;
        String ssid;
        String ip;
        int32_t rssi = 0;
        String error;
        String scanJson = "[]";
        bool scanning = false;
        bool scanRequested = false;
        bool joinRequested = false;
        String requestSsid;
        String requestPass;
        bool accessPointRequested = false;
    } shared;

    // Run body with the shared state locked
    template <typename Body>
    void withLock(Body body)
    {
        xSemaphoreTake(s_lock, portMAX_DELAY);
        body();
        xSemaphoreGive(s_lock);
    }

    // Copy the loop-owned state into the shared snapshot
    void publish(const String &error = "")
    {
        const bool connected = WiFi.status() == WL_CONNECTED;
        const String ssid = mode == NetworkMode::Lan || mode == NetworkMode::Connecting ? savedSsid : joinSsid;
        const String ip = connected ? WiFi.localIP().toString() : String();
        const int32_t rssi = connected ? WiFi.RSSI() : 0;
        withLock([&]
        {
            shared.mode = mode;
            shared.ssid = mode == NetworkMode::AccessPoint || mode == NetworkMode::Setup ? String() : ssid;
            shared.ip = ip;
            shared.rssi = rssi;
            shared.error = error;
            shared.scanning = scanning;
        });
    }

    // Switch state and remember when
    void setMode(NetworkMode next, const String &error = "")
    {
        mode = next;
        modeSinceMs = millis();
        Serial.printf("Wi-Fi: %s\n", networkModeName(mode));
        publish(error);
    }

    // Bring up the open setup access point, with DNS answering every name with the turntable
    void startAccessPoint()
    {
        WiFi.mode(WIFI_AP_STA);
        if (!WiFi.softAPConfig(AP_IP, AP_IP, AP_SUBNET))
        {
            Serial.println("Error: Failed to set the access point address");
        }
        WiFi.softAP(WIFI_SSID, WIFI_PASSWORD);
        dns.start(53, "*", AP_IP);
        Serial.printf("Setup access point %s started - %s\n", WIFI_SSID, AP_URL);
    }

    // Shut the access point down and stay a LAN client
    void stopAccessPoint()
    {
        dns.stop();
        WiFi.softAPdisconnect(true);
        WiFi.mode(WIFI_STA);
        Serial.println("Setup access point stopped");
    }

    // Start an asynchronous network scan for the setup page
    void startScan()
    {
        if (retrying)
        {
            // A connection attempt and a scan both hop channels; the scan wins
            WiFi.disconnect(false, false);
            retrying = false;
            lastRetryMs = millis();
        }
        // Short dwell per channel: the scan leaves the access point's channel, so a phone
        // on the setup page loses contact for the length of the scan (about 1.6 s here)
        if (WiFi.scanNetworks(true, false, false, 120) == WIFI_SCAN_FAILED)
        {
            Serial.println("Error: Wi-Fi scan failed to start");
            return;
        }
        scanning = true;
        publish();
    }

    // Turn finished scan results into JSON: one entry per name, strongest first
    void finishScan(int16_t count)
    {
        JsonDocument doc;
        JsonArray networks = doc.to<JsonArray>();
        for (int16_t i = 0; i < count; i++)
        {
            const String ssid = WiFi.SSID(i);
            if (ssid.isEmpty())
            {
                continue;   // Hidden network; use "Other network…" on the page
            }
            bool duplicate = false;
            for (JsonObject existing : networks)
            {
                if (existing["ssid"] == ssid)
                {
                    duplicate = true;
                    if (WiFi.RSSI(i) > existing["rssi"].as<int32_t>())
                    {
                        existing["rssi"] = WiFi.RSSI(i);
                    }
                    break;
                }
            }
            if (!duplicate)
            {
                JsonObject network = networks.add<JsonObject>();
                network["ssid"] = ssid;
                network["rssi"] = WiFi.RSSI(i);
                network["secure"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
            }
        }
        WiFi.scanDelete();

        String json;
        serializeJson(doc, json);
        scanning = false;
        lastScanMs = millis();
        withLock([&]
        {
            shared.scanJson = json;
            shared.scanning = false;
        });
        Serial.printf("Wi-Fi scan found %d networks\n", (int)networks.size());
    }

    // Enter setup. retry keeps trying the saved network in the background.
    void enterSetup(bool retry, const String &error = "")
    {
        retrySaved = retry && !savedSsid.isEmpty();
        retrying = false;
        lastRetryMs = millis();
        if (WiFi.getMode() != WIFI_AP_STA)
        {
            startAccessPoint();
        }
        setMode(NetworkMode::Setup, error);
        startScan();
    }

    // Now a LAN client on the saved network
    void enterLan()
    {
        Serial.printf("Joined %s - http://%s.local (%s)\n", savedSsid.c_str(), MDNS_HOSTNAME, WiFi.localIP().toString().c_str());
        wasConnected = true;
        setMode(NetworkMode::Lan);
    }

    // Save a network that just connected
    void saveCredentials(const String &ssid, const String &pass)
    {
        savedSsid = ssid;
        savedPass = pass;
        wifiPrefs.putString("ssid", ssid);
        wifiPrefs.putString("pass", pass);
    }

    // Why a join failed, in words for the setup page
    const char* joinFailureMessage(uint8_t reason)
    {
        switch (reason)
        {
            case WIFI_REASON_AUTH_FAIL:
            case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
            case WIFI_REASON_HANDSHAKE_TIMEOUT:
                return "Couldn't join: check the password.";
            case WIFI_REASON_NO_AP_FOUND:
                return "Network not found. It may be 5 GHz only, or out of range.";
            default:
                return "Couldn't join the network. Try again.";
        }
    }

    // Pick up requests posted by the setup page
    void takeRequests()
    {
        bool scanRequested = false;
        bool joinRequested = false;
        bool accessPointRequested = false;
        String ssid;
        String pass;
        withLock([&]
        {
            scanRequested = shared.scanRequested;
            joinRequested = shared.joinRequested;
            accessPointRequested = shared.accessPointRequested;
            ssid = shared.requestSsid;
            pass = shared.requestPass;
            shared.scanRequested = false;
            shared.joinRequested = false;
            shared.accessPointRequested = false;
            shared.requestPass = String();
        });

        if (mode != NetworkMode::Setup)
        {
            return;
        }
        if (accessPointRequested)
        {
            // Not saved: the next power-up runs the usual flow again
            WiFi.disconnect(false, false);
            WiFi.mode(WIFI_AP);
            retrySaved = false;
            setMode(NetworkMode::AccessPoint);
            return;
        }
        if (joinRequested)
        {
            if (retrying || scanning)
            {
                WiFi.scanDelete();
                scanning = false;
                retrying = false;
                WiFi.disconnect(false, false);
            }
            joinSsid = ssid;
            joinPass = pass;
            s_disconnectReason = 0;
            WiFi.begin(joinSsid.c_str(), joinPass.c_str());
            setMode(NetworkMode::Joining);
            Serial.printf("Joining %s\n", joinSsid.c_str());
            return;
        }
        if (scanRequested && !scanning && millis() - lastScanMs >= SCAN_MAX_AGE_MS)
        {
            startScan();
        }
    }

    // Answer phones' connectivity checks and stray URLs while the access point is up
    void onNotFound(AsyncWebServerRequest *request)
    {
        const bool captive = mode == NetworkMode::Setup || mode == NetworkMode::Joining
            || mode == NetworkMode::Joined || mode == NetworkMode::AccessPoint;
        const String host = request->host();
        if (captive && host != AP_IP.toString() && !host.startsWith(MDNS_HOSTNAME))
        {
            // Any other host means a connectivity probe or a typed URL: send it to our page
            request->redirect(String(AP_URL) + (mode == NetworkMode::AccessPoint ? "/" : "/setup"));
            return;
        }
        request->send(404, "text/plain", "Not found");
    }

    // Reply with a small JSON object
    void sendJson(AsyncWebServerRequest *request, int code, const String &json)
    {
        AsyncWebServerResponse *response = request->beginResponse(code, "application/json", json);
        response->addHeader("Cache-Control", "no-store");
        request->send(response);
    }

    // Register the setup page, its API, and the captive redirect
    void addRoutes(AsyncWebServer &server)
    {
        // The control UI, unless setup is running
        server.on("/", HTTP_GET, [](AsyncWebServerRequest *request)
        {
            if (mode == NetworkMode::Setup || mode == NetworkMode::Joining || mode == NetworkMode::Joined)
            {
                request->redirect("/setup");
                return;
            }
            request->send(LittleFS, "/index.html", "text/html");
        });

        server.on("/setup", HTTP_GET, [](AsyncWebServerRequest *request)
        {
            request->send(LittleFS, "/setup.html", "text/html");
        });

        server.on("/api/wifi/status", HTTP_GET, [](AsyncWebServerRequest *request)
        {
            JsonDocument doc;
            withLock([&]
            {
                doc["mode"] = networkModeName(shared.mode);
                doc["ssid"] = shared.ssid;
                doc["ip"] = shared.ip;
                doc["rssi"] = shared.rssi;
                doc["error"] = shared.error;
            });
            doc["hostname"] = String(MDNS_HOSTNAME) + ".local";
            String json;
            serializeJson(doc, json);
            sendJson(request, 200, json);
        });

        server.on("/api/wifi/scan", HTTP_GET, [](AsyncWebServerRequest *request)
        {
            String json;
            withLock([&]
            {
                shared.scanRequested = true;
                json = String("{\"scanning\":") + (shared.scanning ? "true" : "false")
                    + ",\"networks\":" + shared.scanJson + "}";
            });
            sendJson(request, 200, json);
        });

        server.on("/api/wifi/join", HTTP_POST, [](AsyncWebServerRequest *request)
        {
            const String ssid = request->hasParam("ssid", true) ? request->getParam("ssid", true)->value() : String();
            const String pass = request->hasParam("password", true) ? request->getParam("password", true)->value() : String();
            if (ssid.isEmpty() || ssid.length() > 32)
            {
                sendJson(request, 400, "{\"error\":\"Enter a network name (up to 32 characters).\"}");
                return;
            }
            if (!pass.isEmpty() && (pass.length() < 8 || pass.length() > 63))
            {
                sendJson(request, 400, "{\"error\":\"Wi-Fi passwords are 8 to 63 characters.\"}");
                return;
            }
            withLock([&]
            {
                shared.requestSsid = ssid;
                shared.requestPass = pass;
                shared.joinRequested = true;
            });
            sendJson(request, 202, "{\"ok\":true}");
        });

        server.on("/api/wifi/ap", HTTP_POST, [](AsyncWebServerRequest *request)
        {
            withLock([&] { shared.accessPointRequested = true; });
            sendJson(request, 202, "{\"ok\":true}");
        });

        server.onNotFound(onNotFound);
    }

    // True if the reset button is held for RESET_HOLD_MS at power-up
    bool resetButtonHeld()
    {
        pinMode(RESET_BUTTON_PIN, INPUT_PULLUP);
        delay(10);
        const unsigned long start = millis();
        while (digitalRead(RESET_BUTTON_PIN) == LOW)
        {
            if (millis() - start >= RESET_HOLD_MS)
            {
                return true;
            }
            delay(10);
        }
        return false;
    }
}

// Read the reset button, load the saved network, start Wi-Fi and mDNS, and add the setup routes
void networkBegin(AsyncWebServer &server)
{
    s_lock = xSemaphoreCreateMutex();

    // "Change Wi-Fi network" restarts with this flag; a power-on leaves RTC memory as noise
    const bool changeRequested = esp_reset_reason() == ESP_RST_SW && s_bootIntoSetup == SETUP_MAGIC;
    s_bootIntoSetup = 0;
    const bool buttonHeld = resetButtonHeld();

    wifiPrefs.begin(WIFI_NAMESPACE, false);
    savedSsid = wifiPrefs.getString("ssid", "");
    savedPass = wifiPrefs.getString("pass", "");

    WiFi.persistent(false);     // The saved network lives in our own NVS namespace
    WiFi.setHostname(MDNS_HOSTNAME);
    WiFi.onEvent([](arduino_event_id_t, arduino_event_info_t info)
    {
        s_disconnectReason = info.wifi_sta_disconnected.reason;
    }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);

    addRoutes(server);

    if (changeRequested || buttonHeld)
    {
        Serial.println(buttonHeld ? "Reset button held: starting Wi-Fi setup" : "Change of Wi-Fi network requested: starting setup");
        enterSetup(false);
    }
    else if (savedSsid.isEmpty())
    {
        Serial.println("No saved Wi-Fi network: starting setup");
        enterSetup(false);
    }
    else
    {
        WiFi.mode(WIFI_STA);
        WiFi.begin(savedSsid.c_str(), savedPass.c_str());
        Serial.printf("Connecting to %s\n", savedSsid.c_str());
        setMode(NetworkMode::Connecting);
    }

    // mDNS answers on whichever interface is up: the LAN, or the setup access point
    if (MDNS.begin(MDNS_HOSTNAME))
    {
        MDNS.addService("http", "tcp", 80);
        Serial.printf("mDNS started - http://%s.local\n", MDNS_HOSTNAME);
    }
    else
    {
        Serial.println("Error: Failed to start mDNS");
    }
}

// Run the connection state machine. Called from loop().
void handleNetwork()
{
    const unsigned long now = millis();
    const bool connected = WiFi.status() == WL_CONNECTED;

    if (scanning)
    {
        const int16_t count = WiFi.scanComplete();
        if (count >= 0)
        {
            finishScan(count);
        }
        else if (count == WIFI_SCAN_FAILED)
        {
            scanning = false;
            publish();
        }
    }

    switch (mode)
    {
        case NetworkMode::Connecting:
            if (connected)
            {
                enterLan();
            }
            else if (now - modeSinceMs >= CONNECT_TIMEOUT_MS)
            {
                Serial.printf("Saved network %s not found: starting setup, still retrying it\n", savedSsid.c_str());
                WiFi.disconnect(false, false);
                enterSetup(true);
            }
            break;

        case NetworkMode::Lan:
        {
            // The driver reconnects by itself after a drop; just log the changes
            static unsigned long lastPublishMs = 0;
            if (connected != wasConnected)
            {
                wasConnected = connected;
                Serial.println(connected ? "Wi-Fi reconnected" : "Wi-Fi lost, reconnecting");
                publish();
            }
            else if (now - lastPublishMs >= 5000)
            {
                lastPublishMs = now;
                publish();      // Keeps the signal strength current
            }
            break;
        }

        case NetworkMode::Setup:
            takeRequests();
            if (mode != NetworkMode::Setup)
            {
                break;
            }
            if (retrying)
            {
                if (connected)
                {
                    Serial.printf("Saved network %s is back\n", savedSsid.c_str());
                    stopAccessPoint();
                    enterLan();
                }
                else if (now - lastRetryMs >= RETRY_ATTEMPT_MS || WiFi.softAPgetStationNum() > 0)
                {
                    // Give up for now, and never disturb a phone that's using the setup page
                    WiFi.disconnect(false, false);
                    retrying = false;
                    lastRetryMs = now;
                }
            }
            else if (retrySaved && !scanning && WiFi.softAPgetStationNum() == 0 && now - lastRetryMs >= RETRY_INTERVAL_MS)
            {
                WiFi.begin(savedSsid.c_str(), savedPass.c_str());
                retrying = true;
                lastRetryMs = now;
            }
            break;

        case NetworkMode::Joining:
            if (connected)
            {
                saveCredentials(joinSsid, joinPass);
                joinPass = String();
                Serial.printf("Joined %s (%s); setup access point closes in %lu s\n",
                    joinSsid.c_str(), WiFi.localIP().toString().c_str(), JOINED_GRACE_MS / 1000);
                setMode(NetworkMode::Joined);
            }
            else
            {
                const uint8_t reason = s_disconnectReason;
                const bool badPassword = reason == WIFI_REASON_AUTH_FAIL || reason == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT
                    || reason == WIFI_REASON_HANDSHAKE_TIMEOUT;
                if ((badPassword && now - modeSinceMs >= 3000) || now - modeSinceMs >= CONNECT_TIMEOUT_MS)
                {
                    Serial.printf("Couldn't join %s (reason %u)\n", joinSsid.c_str(), reason);
                    WiFi.disconnect(false, false);
                    joinPass = String();
                    setMode(NetworkMode::Setup, joinFailureMessage(reason));
                }
            }
            break;

        case NetworkMode::Joined:
            if (now - modeSinceMs >= JOINED_GRACE_MS)
            {
                stopAccessPoint();
                enterLan();
            }
            break;

        case NetworkMode::AccessPoint:
            break;
    }
}

// Current connection state
NetworkStatus networkStatus()
{
    NetworkStatus status;
    withLock([&]
    {
        status.mode = shared.mode;
        status.ssid = shared.ssid;
        status.ip = shared.ip;
        status.rssi = shared.rssi;
    });
    return status;
}

// Protocol name for a network mode
const char* networkModeName(NetworkMode mode)
{
    switch (mode)
    {
        case NetworkMode::Connecting:
            return "connecting";
        case NetworkMode::Lan:
            return "lan";
        case NetworkMode::Setup:
            return "setup";
        case NetworkMode::Joining:
            return "joining";
        case NetworkMode::Joined:
            return "joined";
        case NetworkMode::AccessPoint:
            return "ap";
    }
    return "unknown";
}

// Restart into Wi-Fi setup, keeping the saved network until a new one connects
void networkRestartIntoSetup()
{
    Serial.println("Restarting into Wi-Fi setup");
    s_bootIntoSetup = SETUP_MAGIC;
    delay(200);     // Let the last WebSocket frames go out
    esp_restart();
}
