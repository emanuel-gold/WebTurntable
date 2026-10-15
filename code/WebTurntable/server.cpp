#include "server.h"
#include "turntable.h"

#include <atomic>

#include <ArduinoJson.h>
#include <LittleFS.h>
#include <Preferences.h>

#include <WiFi.h>
#include <ESPmDNS.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>

namespace
{
	AsyncWebServer server(80);
	AsyncWebSocket ws("/ws");
	Preferences preferences;

	// Access point address. The ESP32 default, 192.168.4.1, is the home router's address here.
	// Phones get DHCP leases from the next address up (192.168.4.6 onward).
	const IPAddress AP_IP(192, 168, 4, 5);
	const IPAddress AP_SUBNET(255, 255, 255, 0);

	// Settings live in NVS, so uploading the web UI (which rewrites LittleFS) keeps them
	constexpr char SETTINGS_NAMESPACE[] = "turntable";
	constexpr char SETTINGS_KEY[] = "settings";
	constexpr unsigned long SETTINGS_SAVE_DELAY_MS = 750;
	constexpr unsigned long WS_CLEANUP_INTERVAL_MS = 1000;

	// Set from the AsyncTCP task, which can run on the other core, and read in loop()
	std::atomic<bool> settingsDirty{false};
	std::atomic<unsigned long> lastSettingsChangeMs{0};

	// Error handler that halts execution and blinks the LED indefinitely
    void haltWithErrorIndicator()
    {
        Serial.println("Critical error: Halting execution");
        while (true)
        {
            digitalWrite(LED_PIN, HIGH);
            delay(500);
            digitalWrite(LED_PIN, LOW);
            delay(500);
        }
    }

	// Helper to convert rotation direction enum to string for logging
    const char* directionToString(uint8_t direction)
    {
        switch (direction)
        {
            case RotateDirection::CW:
                return "CW";
            case RotateDirection::OFF:
                return "OFF";
            case RotateDirection::CCW:
                return "CCW";
            default:
                return "UNKNOWN";
        }
    }

	// Helper to convert stepping mode enum to string for logging
    const char* modeToString(uint8_t mode)
    {
        switch (mode)
        {
            case RotateMode::FULL_STEPPING:
                return "FULL";
            case RotateMode::HALF_STEPPING:
                return "HALF";
            default:
                return "UNKNOWN";
        }
    }

	// Log information about the current turntable state to serial console
    void logTurntableStatus(const char* context)
    {
        Serial.print(context);
        Serial.print(" direction=");
        Serial.print(directionToString(g_turntable.direction));
        Serial.print(", speed=");
        Serial.print(g_turntable.sliderSpeed);
        Serial.print(", mode=");
        Serial.println(modeToString(g_turntable.mode));
    }

	// Mark settings as dirty and start the save delay timer
    void queueSettingsSave()
    {
        // Time first, so loop() never pairs the new flag with an old time and skips the delay
        lastSettingsChangeMs = millis();
        settingsDirty = true;
    }

	// Save the current turntable settings to flash memory
    void saveTurntableState()
    {
        // Clear the flag before copying, so a change that lands mid-save queues another save
        settingsDirty = false;
        const TurntableSettings snapshot = g_turntable;

        size_t bytesWritten = preferences.putBytes(SETTINGS_KEY, &snapshot, sizeof(snapshot));
        if (bytesWritten != sizeof(snapshot))
        {
            // Not retried until the next change, so a failing flash isn't hammered
            Serial.println("Error: Failed to write settings");
            return;
        }

        logTurntableStatus("Settings saved:");
    }

	// Load turntable settings from flash memory, returns true if successful
    bool loadTurntableState()
    {
        if (!preferences.isKey(SETTINGS_KEY))
        {
            Serial.println("No saved settings found");
            return false;
        }

        TurntableSettings loadedSettings;
        size_t bytesRead = preferences.getBytes(SETTINGS_KEY, &loadedSettings, sizeof(loadedSettings));

        // Validate size and magic number
        if (bytesRead != sizeof(loadedSettings) || loadedSettings.magic != TurntableSettings::MAGIC)
        {
            Serial.println("Error: Saved settings invalid");
            return false;
        }

        // Apply loaded settings
        g_turntable = loadedSettings;
        logTurntableStatus("Settings loaded:");
        return true;
    }

	// Serialize the current settings in the format the web UI expects
	String pageContent()
	{
		JsonDocument page;
		page["stepping_direction"] = static_cast<uint8_t>(g_turntable.direction);
		page["stepping_speed"] = g_turntable.sliderSpeed;
		page["stepping_mode"] = static_cast<uint8_t>(g_turntable.mode);

		String jsonString;
		serializeJson(page, jsonString);
		return jsonString;
	}

	// Update the connected clients
	void updatePage()
	{
		ws.textAll(pageContent());
	}

	// Handle incoming WebSocket messages from clients
	void handleClientMessage(void *arg, uint8_t *data, size_t len)
	{
		AwsFrameInfo *info = (AwsFrameInfo*)arg;
		if (info->final && info->index == 0 && info->len == len && info->opcode == WS_TEXT)
		{
			JsonDocument jsonData;
			if (deserializeJson(jsonData, reinterpret_cast<const char*>(data), len))
			{
				Serial.println("Ignored malformed message");
				return;
			}

			// Anything that isn't an integer becomes -1 and fails the range checks
			const int content = jsonData["content"] | -1;

			// Handle stepping direction change
			if (jsonData["type"] == "stepping_direction")
			{
				if (content >= RotateDirection::CW && content <= RotateDirection::CCW && g_turntable.direction != content)
				{
					g_turntable.direction = (RotateDirection) content;
					queueSettingsSave();
				}
				updatePage();
			}
			// Handle speed/slider change
			else if (jsonData["type"] == "stepping_speed")
			{
				if (content >= 0)
				{
					uint16_t sliderSpeed = content > TOTAL_SLIDER_STEPS ? TOTAL_SLIDER_STEPS : content;
					if (g_turntable.sliderSpeed != sliderSpeed)
					{
						g_turntable.sliderSpeed = sliderSpeed;
						queueSettingsSave();
					}
				}
				updatePage();
			}
			// Handle stepping mode change
			else if (jsonData["type"] == "stepping_mode")
			{
				if (content >= RotateMode::FULL_STEPPING && content <= RotateMode::HALF_STEPPING && g_turntable.mode != content)
				{
					g_turntable.mode = (RotateMode) content;
					queueSettingsSave();
				}
				updatePage();
			}
		}
	}

	// WebSocket event handler
	void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client, AwsEventType type, void *arg, uint8_t *data, size_t len)
	{
		switch (type)
		{
		case WS_EVT_CONNECT:
			Serial.println("Client connected");
			logTurntableStatus("Current state:");
			client->text(pageContent());
			break;

		case WS_EVT_DISCONNECT:
			Serial.println("Client disconnected");
			break;

		case WS_EVT_DATA:
			handleClientMessage(arg, data, len);
			break;

		default:
			break;
		}
	}

	// Send main page HTML
	void onIndexRequest(AsyncWebServerRequest *request) 
	{
		IPAddress remote_ip = request->client()->remoteIP();
		Serial.println("[" + remote_ip.toString() + "] HTTP GET request of " + request->url());
		request->send(LittleFS, "/index.html", "text/html");
	}

	// Send style sheet
	void onCSSRequest(AsyncWebServerRequest *request) 
	{
		IPAddress remote_ip = request->client()->remoteIP();
		Serial.println("[" + remote_ip.toString() + "] HTTP GET request of " + request->url());
		request->send(LittleFS, "/style.css", "text/css");
	}
}

// Initialize the web server and load saved settings from flash
void initWebserver()
{
	// Initialize file system
	if (!LittleFS.begin())
	{
		Serial.println("Error: Failed to mount LittleFS. Upload the web UI (tools\\flash.cmd webui)");
		haltWithErrorIndicator();
	}
	if (!LittleFS.exists("/index.html"))
	{
		Serial.println("Error: /index.html missing from LittleFS. Upload the web UI (tools\\flash.cmd webui)");
		haltWithErrorIndicator();
	}

	// Load persisted settings from flash
	if (!preferences.begin(SETTINGS_NAMESPACE, false))
	{
		Serial.println("Error: Failed to open settings storage (NVS)");
		haltWithErrorIndicator();
	}
	loadTurntableState();

	// Setup WiFi access point, with its address set first so DHCP hands out matching leases
	if (!WiFi.softAPConfig(AP_IP, AP_IP, AP_SUBNET))
	{
		Serial.println("Error: Failed to set the access point address");
	}
	WiFi.softAP(WIFI_SSID, WIFI_PASSWORD);
	Serial.print("WiFi AP started - IP: ");
	Serial.println(WiFi.softAPIP());

	// Announce the hostname over mDNS. Not fatal: the IP address still works without it.
	if (MDNS.begin(MDNS_HOSTNAME))
	{
		MDNS.addService("http", "tcp", 80);
		Serial.printf("mDNS started - http://%s.local\n", MDNS_HOSTNAME);
	}
	else
	{
		Serial.println("Error: Failed to start mDNS");
	}

	// Configure WebSocket
	ws.onEvent(onWsEvent);
	server.addHandler(&ws);
	
	// Configure HTTP routes
	server.on("/", HTTP_GET, onIndexRequest);
	server.on("/style.css", HTTP_GET, onCSSRequest);

	// Serve static files from LittleFS
	server.serveStatic("/", LittleFS, "/");
	server.begin();
}

// Handle settings storage with delayed write to flash to minimize wear
void handleSettingsStorage()
{
	if (settingsDirty && millis() - lastSettingsChangeMs >= SETTINGS_SAVE_DELAY_MS)
	{
		saveTurntableState();
	}
}

// Drop WebSocket clients beyond the limit, since phone browsers don't always close their connections
void handleWebSocketClients()
{
	static unsigned long lastCleanupMs = 0;
	if (millis() - lastCleanupMs >= WS_CLEANUP_INTERVAL_MS)
	{
		lastCleanupMs = millis();
		ws.cleanupClients();
	}
}