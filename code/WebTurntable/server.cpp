#include "server.h"
#include "config.h"
#include "motion.h"

#include <cmath>

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
	constexpr unsigned long STATE_INTERVAL_MS = 100;

	// Last-used state, persisted to NVS. Bump MAGIC whenever the layout changes.
	struct TurntableSettings
	{
		static constexpr uint32_t MAGIC = 0x54544232;   // "TTB2"

		uint32_t magic        = MAGIC;
		float rpm             = DEFAULT_RPM;
		Direction dir         = Direction::CW;
		bool spinning         = false;    // Resume spinning after a power cycle, as v1 did
		DriveMode driveMode   = DriveMode::Half;
		float maxRpm          = DEFAULT_MAX_RPM;
		float accel           = DEFAULT_ACCEL;
	};

	// Only touched from loop(), which runs every queued command
	TurntableSettings settings;
	bool settingsDirty = false;
	unsigned long lastSettingsChangeMs = 0;
	// Last move target, kept in degrees so repeated Rotate by presses don't add up rounding errors
	double moveTargetDeg = 0.0;
	int32_t moveTargetPos = 0;

	// Commands parsed in the AsyncTCP task and run in loop(), so all state stays on one thread
	enum class CommandType : uint8_t
	{
		Speed,
		Run,
		Stop,
		Halt,
		MoveBy,
		MoveTo,
		SetZero,
		Settings
	};

	// Which way a Go to angle move turns
	enum class MoveDirection : uint8_t
	{
		Shortest,
		CW,
		CCW
	};

	// One validated command from a client
	struct Command
	{
		CommandType type;
		float value;            // RPM for Speed and Run, degrees for MoveBy and MoveTo
		bool hasValue;
		Direction dir;
		MoveDirection moveDir;
		bool hasDriveMode;
		DriveMode driveMode;
		bool hasMaxRpm;
		float maxRpm;
		bool hasAccel;
		float accel;
	};

	QueueHandle_t commandQueue = nullptr;

	// Error handler that halts execution and blinks the LED indefinitely
	void haltWithErrorIndicator()
	{
		Serial.println("Critical error: Halting execution");
		motionHalt();
		while (true)
		{
			digitalWrite(LED_PIN, HIGH);
			delay(500);
			digitalWrite(LED_PIN, LOW);
			delay(500);
		}
	}

	// Protocol name for a direction
	const char* directionName(Direction dir)
	{
		return dir == Direction::CW ? "cw" : "ccw";
	}

	// Protocol name for a drive mode
	const char* driveModeName(DriveMode mode)
	{
		return mode == DriveMode::Full ? "full" : "half";
	}

	// Protocol name for a motion state
	const char* motionStateName(MotionState state)
	{
		switch (state)
		{
			case MotionState::Running:
				return "running";
			case MotionState::Moving:
				return "moving";
			case MotionState::Stopping:
				return "stopping";
			default:
				return "idle";
		}
	}

	// Keep a value inside [low, high]
	float clampFloat(float value, float low, float high)
	{
		return value < low ? low : (value > high ? high : value);
	}

	// Log the persisted settings to the serial console
	void logSettings(const char* context)
	{
		Serial.printf("%s rpm=%.2f, dir=%s, spinning=%d, mode=%s, maxRpm=%.1f, accel=%.1f\n",
			context, settings.rpm, directionName(settings.dir), settings.spinning,
			driveModeName(settings.driveMode), settings.maxRpm, settings.accel);
	}

	// Mark settings as dirty and start the save delay timer
	void queueSettingsSave()
	{
		settingsDirty = true;
		lastSettingsChangeMs = millis();
	}

	// Save the current turntable settings to flash memory
	void saveTurntableState()
	{
		settingsDirty = false;
		size_t bytesWritten = preferences.putBytes(SETTINGS_KEY, &settings, sizeof(settings));
		if (bytesWritten != sizeof(settings))
		{
			// Not retried until the next change, so a failing flash isn't hammered
			Serial.println("Error: Failed to write settings");
			return;
		}
		logSettings("Settings saved:");
	}

	// Load turntable settings from flash memory, returns true if successful
	bool loadTurntableState()
	{
		if (!preferences.isKey(SETTINGS_KEY))
		{
			Serial.println("No saved settings found");
			return false;
		}

		TurntableSettings loaded;
		size_t bytesRead = preferences.getBytes(SETTINGS_KEY, &loaded, sizeof(loaded));
		if (bytesRead != sizeof(loaded) || loaded.magic != TurntableSettings::MAGIC)
		{
			Serial.println("Saved settings are from another version, using defaults");
			return false;
		}

		// Clamp everything, so a bad value can't drive the motor too hard
		loaded.maxRpm = clampFloat(loaded.maxRpm, MIN_RPM, MAX_RPM_LIMIT);
		loaded.rpm = clampFloat(loaded.rpm, MIN_RPM, loaded.maxRpm);
		loaded.accel = clampFloat(loaded.accel, MIN_ACCEL, MAX_ACCEL);
		loaded.dir = loaded.dir == Direction::CCW ? Direction::CCW : Direction::CW;
		loaded.driveMode = loaded.driveMode == DriveMode::Full ? DriveMode::Full : DriveMode::Half;
		settings = loaded;
		logSettings("Settings loaded:");
		return true;
	}

	// Value rounded to a fixed number of decimals, so JSON stays short. A String, so the
	// document keeps its own copy.
	SerializedValue<String> roundedJson(float value, unsigned int decimals)
	{
		return serialized(String(value, decimals));
	}

	// Serialize the current state for the web UI
	String stateJson()
	{
		const MotionStatus status = motionStatus();

		JsonDocument doc;
		doc["type"] = "state";
		doc["motion"] = motionStateName(status.state);
		doc["angle"] = roundedJson(status.angleDeg, 1);
		doc["speed"] = roundedJson(status.speedRpm, 2);
		doc["rpm"] = roundedJson(settings.rpm, 2);
		doc["dir"] = directionName(settings.dir);
		doc["spinning"] = settings.spinning;

		JsonObject current = doc["settings"].to<JsonObject>();
		current["driveMode"] = driveModeName(settings.driveMode);
		current["maxRpm"] = roundedJson(settings.maxRpm, 1);
		current["accel"] = roundedJson(settings.accel, 1);

		JsonObject limits = doc["limits"].to<JsonObject>();
		limits["minRpm"] = MIN_RPM;
		limits["maxRpm"] = MAX_RPM_LIMIT;
		limits["minAccel"] = MIN_ACCEL;
		limits["maxAccel"] = MAX_ACCEL;

		String json;
		serializeJson(doc, json);
		return json;
	}

	// Send the state to every connected client
	void broadcastState()
	{
		ws.textAll(stateJson());
	}

	// Tell one client its command was rejected
	void sendError(AsyncWebSocketClient *client, const char *message)
	{
		JsonDocument doc;
		doc["type"] = "error";
		doc["msg"] = message;
		String json;
		serializeJson(doc, json);
		client->text(json);
	}

	// Read a "cw"/"ccw" field; returns false if it's present but invalid
	bool parseDirection(JsonVariantConst value, Direction &dir)
	{
		if (value == "cw")
		{
			dir = Direction::CW;
			return true;
		}
		if (value == "ccw")
		{
			dir = Direction::CCW;
			return true;
		}
		return false;
	}

	// Turn a JSON message into a command; on failure, message says why
	bool parseCommand(JsonDocument &json, Command &command, const char *&message)
	{
		command = {};
		const JsonVariantConst cmd = json["cmd"];

		if (cmd == "speed" || cmd == "run")
		{
			command.type = cmd == "speed" ? CommandType::Speed : CommandType::Run;
			command.hasValue = json["rpm"].is<float>();
			command.value = json["rpm"] | 0.0f;
			if (command.type == CommandType::Speed && !command.hasValue)
			{
				message = "speed needs a number rpm";
				return false;
			}
			if (command.type == CommandType::Run && !parseDirection(json["dir"], command.dir))
			{
				message = "run needs dir cw or ccw";
				return false;
			}
			return true;
		}
		if (cmd == "stop" || cmd == "halt" || cmd == "setZero")
		{
			command.type = cmd == "stop" ? CommandType::Stop : (cmd == "halt" ? CommandType::Halt : CommandType::SetZero);
			return true;
		}
		if (cmd == "moveBy" || cmd == "moveTo")
		{
			command.type = cmd == "moveBy" ? CommandType::MoveBy : CommandType::MoveTo;
			if (!json["deg"].is<float>() || !std::isfinite(json["deg"].as<float>()))
			{
				message = "move needs a number deg";
				return false;
			}
			command.value = json["deg"].as<float>();
			command.moveDir = MoveDirection::Shortest;
			const JsonVariantConst dir = json["dir"];
			if (dir == "cw")
			{
				command.moveDir = MoveDirection::CW;
			}
			else if (dir == "ccw")
			{
				command.moveDir = MoveDirection::CCW;
			}
			else if (!dir.isNull() && dir != "shortest")
			{
				message = "dir must be shortest, cw or ccw";
				return false;
			}
			return true;
		}
		if (cmd == "settings")
		{
			command.type = CommandType::Settings;
			const JsonVariantConst mode = json["driveMode"];
			if (!mode.isNull())
			{
				if (mode != "half" && mode != "full")
				{
					message = "driveMode must be half or full";
					return false;
				}
				command.hasDriveMode = true;
				command.driveMode = mode == "full" ? DriveMode::Full : DriveMode::Half;
			}
			command.hasMaxRpm = json["maxRpm"].is<float>();
			command.maxRpm = json["maxRpm"] | 0.0f;
			command.hasAccel = json["accel"].is<float>();
			command.accel = json["accel"] | 0.0f;
			return true;
		}

		message = "unknown command";
		return false;
	}

	// Run one command. Called from loop() only.
	void executeCommand(const Command &command)
	{
		const MotionStatus status = motionStatus();

		switch (command.type)
		{
			case CommandType::Speed:
				settings.rpm = clampFloat(command.value, MIN_RPM, settings.maxRpm);
				if (settings.spinning)
				{
					motionRun(settings.rpm, settings.dir);
				}
				queueSettingsSave();
				break;

			case CommandType::Run:
				if (command.hasValue)
				{
					settings.rpm = clampFloat(command.value, MIN_RPM, settings.maxRpm);
				}
				settings.dir = command.dir;
				settings.spinning = true;
				// Saves wait for idle (flash writes pause the step timer), so a spin that
				// starts from rest is saved first, to resume after a power cycle
				if (status.state == MotionState::Idle)
				{
					saveTurntableState();
				}
				else
				{
					queueSettingsSave();
				}
				motionRun(settings.rpm, settings.dir);
				break;

			case CommandType::Stop:
			case CommandType::Halt:
				if (settings.spinning)
				{
					settings.spinning = false;
					queueSettingsSave();
				}
				if (command.type == CommandType::Halt)
				{
					motionHalt();
				}
				else
				{
					motionStop();
				}
				break;

			case CommandType::MoveBy:
			case CommandType::MoveTo:
			{
				// Work in unwrapped degrees from zero. Build on the last target while it's
				// unfinished or the disk still sits on it, so quick presses add up exactly.
				const bool onLastTarget = status.state == MotionState::Moving || status.position == moveTargetPos;
				const double here = motionHalfStepsToDegrees(status.position);
				double targetDeg;
				if (command.type == CommandType::MoveBy)
				{
					targetDeg = (onLastTarget ? moveTargetDeg : here) + command.value;
				}
				else
				{
					// Clockwise distance to the target angle, then pick the way round
					double delta = fmod(command.value - status.angleDeg, 360.0);
					if (delta < 0.0)
					{
						delta += 360.0;
					}
					if (command.moveDir == MoveDirection::Shortest && delta > 180.0)
					{
						delta -= 360.0;
					}
					else if (command.moveDir == MoveDirection::CCW && delta > 0.0)
					{
						delta -= 360.0;
					}
					targetDeg = here + delta;
				}
				if (settings.spinning)
				{
					settings.spinning = false;
					queueSettingsSave();
				}
				moveTargetDeg = targetDeg;
				moveTargetPos = motionDegreesToHalfSteps(targetDeg);
				motionMoveTo(moveTargetPos, settings.rpm);
				break;
			}

			case CommandType::SetZero:
				motionSetZero();
				moveTargetDeg = 0.0;
				moveTargetPos = 0;
				break;

			case CommandType::Settings:
				if (command.hasDriveMode)
				{
					settings.driveMode = command.driveMode;
					motionSetDriveMode(settings.driveMode);
				}
				if (command.hasMaxRpm)
				{
					settings.maxRpm = clampFloat(command.maxRpm, MIN_RPM, MAX_RPM_LIMIT);
					if (settings.rpm > settings.maxRpm)
					{
						settings.rpm = settings.maxRpm;
						if (settings.spinning)
						{
							motionRun(settings.rpm, settings.dir);
						}
					}
				}
				if (command.hasAccel)
				{
					settings.accel = clampFloat(command.accel, MIN_ACCEL, MAX_ACCEL);
					motionSetAcceleration(settings.accel);
				}
				queueSettingsSave();
				break;
		}
	}

	// Handle incoming WebSocket messages from clients
	void handleClientMessage(AsyncWebSocketClient *client, void *arg, uint8_t *data, size_t len)
	{
		AwsFrameInfo *info = (AwsFrameInfo*)arg;
		if (!(info->final && info->index == 0 && info->len == len && info->opcode == WS_TEXT))
		{
			return;
		}

		JsonDocument json;
		if (deserializeJson(json, reinterpret_cast<const char*>(data), len))
		{
			sendError(client, "malformed JSON");
			return;
		}

		Command command;
		const char *message = nullptr;
		if (!parseCommand(json, command, message))
		{
			sendError(client, message);
			return;
		}
		if (xQueueSend(commandQueue, &command, 0) != pdTRUE)
		{
			sendError(client, "busy, try again");
		}
	}

	// WebSocket event handler
	void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client, AwsEventType type, void *arg, uint8_t *data, size_t len)
	{
		switch (type)
		{
		case WS_EVT_CONNECT:
			Serial.printf("Client %lu connected\n", (unsigned long)client->id());
			client->text(stateJson());
			break;

		case WS_EVT_DISCONNECT:
			Serial.printf("Client %lu disconnected\n", (unsigned long)client->id());
			break;

		case WS_EVT_DATA:
			handleClientMessage(client, arg, data, len);
			break;

		default:
			break;
		}
	}
}

// Initialize the web server and load saved settings from flash
void initWebserver()
{
	commandQueue = xQueueCreate(16, sizeof(Command));

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

	// Load persisted settings from flash and apply them
	if (!preferences.begin(SETTINGS_NAMESPACE, false))
	{
		Serial.println("Error: Failed to open settings storage (NVS)");
		haltWithErrorIndicator();
	}
	loadTurntableState();
	motionSetDriveMode(settings.driveMode);
	motionSetAcceleration(settings.accel);
	if (settings.spinning)
	{
		motionRun(settings.rpm, settings.dir);
	}

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

	// Serve the web UI from LittleFS
	server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html");
	server.begin();
}

// Run queued commands from the web UI, then tell every client the new state
void handleCommands()
{
	Command command;
	bool ranCommand = false;
	while (xQueueReceive(commandQueue, &command, 0) == pdTRUE)
	{
		executeCommand(command);
		ranCommand = true;
	}
	if (ranCommand)
	{
		broadcastState();
	}
}

// Broadcast the state 10 times a second while the disk moves, and once when it stops
void handleStateBroadcast()
{
	static unsigned long lastBroadcastMs = 0;
	static MotionState lastState = MotionState::Idle;
	if (millis() - lastBroadcastMs >= STATE_INTERVAL_MS)
	{
		lastBroadcastMs = millis();
		const MotionState state = motionStatus().state;
		if (state != MotionState::Idle || state != lastState)
		{
			broadcastState();
		}
		lastState = state;
	}
}

// Save settings after an idle delay to minimize flash wear. Waits while the disk moves,
// because flash writes pause the step timer.
void handleSettingsStorage()
{
	if (settingsDirty && millis() - lastSettingsChangeMs >= SETTINGS_SAVE_DELAY_MS
		&& motionStatus().state == MotionState::Idle)
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
