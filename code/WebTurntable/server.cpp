#include "server.h"
#include "config.h"
#include "motion.h"
#include "presets.h"
#include "sequencer.h"
#include "wireless.h"

#include <cmath>

#include <ArduinoJson.h>
#include <LittleFS.h>
#include <Preferences.h>

#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>

namespace
{
	AsyncWebServer server(80);
	AsyncWebSocket ws("/ws");
	Preferences preferences;

	// Settings live in NVS, so uploading the web UI (which rewrites LittleFS) keeps them
	constexpr char SETTINGS_NAMESPACE[] = "turntable";
	constexpr char SETTINGS_KEY[] = "settings";
	constexpr unsigned long SETTINGS_SAVE_DELAY_MS = 750;
	constexpr unsigned long WS_CLEANUP_INTERVAL_MS = 1000;
	constexpr unsigned long STATE_INTERVAL_MS = 100;

	// Last-used state, persisted to NVS. Bump MAGIC whenever the layout changes.
	struct TurntableSettings
	{
		static constexpr uint32_t MAGIC = 0x54544233;   // "TTB3"

		uint32_t magic        = MAGIC;
		float rpm             = DEFAULT_RPM;
		Direction dir         = Direction::CW;
		DriveMode driveMode   = DriveMode::Half;
		float maxRpm          = DEFAULT_MAX_RPM;
		float accel           = DEFAULT_ACCEL;
		SpinOptions spin;
		SweepOptions sweep;
	};

	// Only touched from loop(), which runs every queued command
	TurntableSettings settings;
	bool settingsDirty = false;
	unsigned long lastSettingsChangeMs = 0;
	bool presetsChanged = false;

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
		Settings,
		WifiSetup,
		SpinOptions,
		SweepOptions,
		Sweep,
		PresetSave,
		PresetApply,
		PresetDelete,
		Hello           // A client connected: send it the presets
	};

	// Which spin and sweep option fields a command carries
	constexpr uint8_t FIELD_STOP_AFTER = 1 << 0;
	constexpr uint8_t FIELD_STOP_VALUE = 1 << 1;
	constexpr uint8_t FIELD_FROM = 1 << 2;
	constexpr uint8_t FIELD_TO = 1 << 3;
	constexpr uint8_t FIELD_DWELL = 1 << 4;

	// One validated command from a client
	struct Command
	{
		CommandType type;
		uint32_t clientId;      // Who to tell if the command fails when it runs
		float value;            // RPM for Speed, Run and Sweep, degrees for MoveBy and MoveTo
		bool hasValue;
		Direction dir;
		MoveDirection moveDir;
		bool hasDriveMode;
		DriveMode driveMode;
		bool hasMaxRpm;
		float maxRpm;
		bool hasAccel;
		float accel;
		uint8_t fields;         // FIELD_* bits for spin and sweep
		SpinOptions spin;
		SweepOptions sweep;
		JobType presetMode;
		uint8_t presetId;
		char presetName[PRESET_NAME_SIZE];
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

	// Protocol name for a stop condition. countName is "revs" for spins and "cycles" for sweeps.
	const char* stopAfterName(StopAfter stopAfter, const char *countName)
	{
		switch (stopAfter)
		{
			case StopAfter::Count:
				return countName;
			case StopAfter::Minutes:
				return "minutes";
			default:
				return "never";
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
		Serial.printf("%s rpm=%.2f, dir=%s, mode=%s, maxRpm=%.1f, accel=%.1f, spin=%s %.2f, "
			"sweep=%.1f..%.1f dwell %lu ms %s %.2f\n",
			context, settings.rpm, directionName(settings.dir), driveModeName(settings.driveMode),
			settings.maxRpm, settings.accel,
			stopAfterName(settings.spin.stopAfter, "revs"), settings.spin.stopValue,
			settings.sweep.fromDeg, settings.sweep.toDeg, (unsigned long)settings.sweep.dwellMs,
			stopAfterName(settings.sweep.stopAfter, "cycles"), settings.sweep.stopValue);
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
		clampSpinOptions(loaded.spin);
		clampSweepOptions(loaded.sweep);
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

	// Add spin options to a JSON object
	void addSpinOptions(JsonObject object, const SpinOptions &options)
	{
		object["stopAfter"] = stopAfterName(options.stopAfter, "revs");
		object["stopValue"] = roundedJson(options.stopValue, 2);
	}

	// Add sweep options to a JSON object
	void addSweepOptions(JsonObject object, const SweepOptions &options)
	{
		object["fromDeg"] = roundedJson(options.fromDeg, 1);
		object["toDeg"] = roundedJson(options.toDeg, 1);
		object["dwellMs"] = options.dwellMs;
		object["stopAfter"] = stopAfterName(options.stopAfter, "cycles");
		object["stopValue"] = roundedJson(options.stopValue, 2);
	}

	// Serialize the current state for the web UI
	String stateJson()
	{
		const MotionStatus status = motionStatus();
		const JobStatus job = sequencerStatus();

		JsonDocument doc;
		doc["type"] = "state";
		doc["motion"] = motionStateName(status.state);
		doc["angle"] = roundedJson(status.angleDeg, 1);
		doc["speed"] = roundedJson(status.speedRpm, 2);
		doc["rpm"] = roundedJson(settings.rpm, 2);
		doc["dir"] = directionName(settings.dir);
		doc["spinning"] = job.type == JobType::Spin;

		// The running spin or sweep and what's left of it, or null
		if (job.type == JobType::None)
		{
			doc["job"] = nullptr;
		}
		else
		{
			JsonObject running = doc["job"].to<JsonObject>();
			running["type"] = job.type == JobType::Spin ? "spin" : "sweep";
			if (job.type == JobType::Spin && job.stopAfter == StopAfter::Count)
			{
				running["revsLeft"] = roundedJson(job.revsLeft, 2);
			}
			if (job.type == JobType::Sweep)
			{
				running["cycle"] = job.cycle;
				if (job.stopAfter == StopAfter::Count)
				{
					running["cycles"] = job.cycles;
				}
			}
			if (job.stopAfter == StopAfter::Minutes)
			{
				running["secondsLeft"] = job.secondsLeft;
			}
		}

		addSpinOptions(doc["spin"].to<JsonObject>(), settings.spin);
		addSweepOptions(doc["sweep"].to<JsonObject>(), settings.sweep);

		JsonObject current = doc["settings"].to<JsonObject>();
		current["driveMode"] = driveModeName(settings.driveMode);
		current["maxRpm"] = roundedJson(settings.maxRpm, 1);
		current["accel"] = roundedJson(settings.accel, 1);

		const NetworkStatus network = networkStatus();
		JsonObject wifi = doc["wifi"].to<JsonObject>();
		wifi["mode"] = networkModeName(network.mode);
		wifi["ssid"] = network.ssid;
		wifi["ip"] = network.ip;
		wifi["rssi"] = network.rssi;

		JsonObject limits = doc["limits"].to<JsonObject>();
		limits["minRpm"] = MIN_RPM;
		limits["maxRpm"] = MAX_RPM_LIMIT;
		limits["minAccel"] = MIN_ACCEL;
		limits["maxAccel"] = MAX_ACCEL;
		limits["minRevs"] = roundedJson(MIN_STOP_REVS, 1);
		limits["maxRevs"] = MAX_STOP_REVS;
		limits["minMinutes"] = roundedJson(MIN_STOP_MINUTES, 1);
		limits["maxMinutes"] = MAX_STOP_MINUTES;
		limits["maxCycles"] = MAX_SWEEP_CYCLES;
		limits["maxSweepDeg"] = MAX_SWEEP_DEG;
		limits["maxDwellMs"] = MAX_DWELL_MS;

		String json;
		serializeJson(doc, json);
		return json;
	}

	// Serialize the saved presets for the web UI
	String presetsJson()
	{
		JsonDocument doc;
		doc["type"] = "presets";
		JsonArray list = doc["presets"].to<JsonArray>();
		for (uint8_t id = 0; id < PRESET_SLOTS; id++)
		{
			const Preset *preset = presetGet(id);
			if (!preset)
			{
				continue;
			}
			JsonObject item = list.add<JsonObject>();
			item["id"] = id;
			item["name"] = preset->name;
			item["mode"] = preset->mode == JobType::Sweep ? "sweep" : "spin";
			item["rpm"] = roundedJson(preset->rpm, 2);
			if (preset->mode == JobType::Sweep)
			{
				addSweepOptions(item, preset->sweep);
			}
			else
			{
				addSpinOptions(item, preset->spin);
			}
		}

		String json;
		serializeJson(doc, json);
		return json;
	}

	// Send the state to every connected client
	void broadcastState()
	{
		ws.textAll(stateJson());
	}

	// An error message for one client
	String errorJson(const char *message)
	{
		JsonDocument doc;
		doc["type"] = "error";
		doc["msg"] = message;
		String json;
		serializeJson(doc, json);
		return json;
	}

	// Tell one client its command was rejected
	void sendError(AsyncWebSocketClient *client, const char *message)
	{
		client->text(errorJson(message));
	}

	// Tell a client, by id, that its command failed when it ran. Does nothing if it has gone.
	void sendError(uint32_t clientId, const char *message)
	{
		ws.text(clientId, errorJson(message));
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

	// Read an optional number field into target and mark it in fields; false if it isn't a number
	bool parseNumberField(JsonVariantConst value, uint8_t field, float &target, Command &command)
	{
		if (value.isNull())
		{
			return true;
		}
		if (!value.is<float>() || !std::isfinite(value.as<float>()))
		{
			return false;
		}
		target = value.as<float>();
		command.fields |= field;
		return true;
	}

	// Read the optional stopAfter and stopValue fields. countName is "revs" for spins and
	// "cycles" for sweeps. On failure, message says why.
	bool parseStopFields(JsonDocument &json, const char *countName, StopAfter &stopAfter, float &stopValue,
		Command &command, const char *&message)
	{
		const JsonVariantConst after = json["stopAfter"];
		if (!after.isNull())
		{
			if (after == "never")
			{
				stopAfter = StopAfter::Never;
			}
			else if (after == countName)
			{
				stopAfter = StopAfter::Count;
			}
			else if (after == "minutes")
			{
				stopAfter = StopAfter::Minutes;
			}
			else
			{
				message = strcmp(countName, "revs") == 0
					? "stopAfter must be never, revs or minutes"
					: "stopAfter must be never, cycles or minutes";
				return false;
			}
			command.fields |= FIELD_STOP_AFTER;
		}
		if (!parseNumberField(json["stopValue"], FIELD_STOP_VALUE, stopValue, command))
		{
			message = "stopValue must be a number";
			return false;
		}
		return true;
	}

	// Read the optional sweep option fields. On failure, message says why.
	bool parseSweepFields(JsonDocument &json, Command &command, const char *&message)
	{
		float dwellMs = 0.0f;
		if (!parseNumberField(json["fromDeg"], FIELD_FROM, command.sweep.fromDeg, command)
			|| !parseNumberField(json["toDeg"], FIELD_TO, command.sweep.toDeg, command)
			|| !parseNumberField(json["dwellMs"], FIELD_DWELL, dwellMs, command))
		{
			message = "fromDeg, toDeg and dwellMs must be numbers";
			return false;
		}
		command.sweep.dwellMs = dwellMs <= 0.0f ? 0 : (dwellMs >= MAX_DWELL_MS ? MAX_DWELL_MS : (uint32_t)lroundf(dwellMs));
		return parseStopFields(json, "cycles", command.sweep.stopAfter, command.sweep.stopValue, command, message);
	}

	// Read a preset id; false if it isn't a whole number
	bool parsePresetId(JsonVariantConst value, Command &command, const char *&message)
	{
		if (!value.is<int>() || value.as<int>() < 0 || value.as<int>() >= PRESET_SLOTS)
		{
			message = "no preset with that id";
			return false;
		}
		command.presetId = (uint8_t)value.as<int>();
		return true;
	}

	// Turn a JSON message into a command; on failure, message says why
	bool parseCommand(JsonDocument &json, Command &command, const char *&message)
	{
		command = {};
		const JsonVariantConst cmd = json["cmd"];

		if (cmd == "speed" || cmd == "run" || cmd == "sweep")
		{
			command.type = cmd == "speed" ? CommandType::Speed : (cmd == "run" ? CommandType::Run : CommandType::Sweep);
			command.hasValue = json["rpm"].is<float>();
			command.value = json["rpm"] | 0.0f;
			if (command.type == CommandType::Speed && !command.hasValue)
			{
				message = "speed needs a number rpm";
				return false;
			}
			if (command.type == CommandType::Run)
			{
				if (!parseDirection(json["dir"], command.dir))
				{
					message = "run needs dir cw or ccw";
					return false;
				}
				return parseStopFields(json, "revs", command.spin.stopAfter, command.spin.stopValue, command, message);
			}
			if (command.type == CommandType::Sweep)
			{
				return parseSweepFields(json, command, message);
			}
			return true;
		}
		if (cmd == "spinOptions")
		{
			command.type = CommandType::SpinOptions;
			return parseStopFields(json, "revs", command.spin.stopAfter, command.spin.stopValue, command, message);
		}
		if (cmd == "sweepOptions")
		{
			command.type = CommandType::SweepOptions;
			return parseSweepFields(json, command, message);
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
		if (cmd == "presetSave")
		{
			command.type = CommandType::PresetSave;
			const char *name = json["name"] | "";
			if (name[0] == '\0' || strlen(name) >= PRESET_NAME_SIZE)
			{
				message = "preset needs a name, up to 63 bytes";
				return false;
			}
			strlcpy(command.presetName, name, sizeof(command.presetName));
			const JsonVariantConst mode = json["mode"];
			if (mode != "spin" && mode != "sweep")
			{
				message = "presetSave needs mode spin or sweep";
				return false;
			}
			command.presetMode = mode == "sweep" ? JobType::Sweep : JobType::Spin;
			return true;
		}
		if (cmd == "presetApply" || cmd == "presetDelete")
		{
			command.type = cmd == "presetApply" ? CommandType::PresetApply : CommandType::PresetDelete;
			return parsePresetId(json["id"], command, message);
		}
		if (cmd == "wifiSetup")
		{
			command.type = CommandType::WifiSetup;
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

	// Copy the spin option fields a command carries into the settings
	void applySpinFields(const Command &command)
	{
		if (command.fields & FIELD_STOP_AFTER)
		{
			settings.spin.stopAfter = command.spin.stopAfter;
		}
		if (command.fields & FIELD_STOP_VALUE)
		{
			settings.spin.stopValue = command.spin.stopValue;
		}
		clampSpinOptions(settings.spin);
	}

	// Copy the sweep option fields a command carries into the settings
	void applySweepFields(const Command &command)
	{
		if (command.fields & FIELD_FROM)
		{
			settings.sweep.fromDeg = command.sweep.fromDeg;
		}
		if (command.fields & FIELD_TO)
		{
			settings.sweep.toDeg = command.sweep.toDeg;
		}
		if (command.fields & FIELD_DWELL)
		{
			settings.sweep.dwellMs = command.sweep.dwellMs;
		}
		if (command.fields & FIELD_STOP_AFTER)
		{
			settings.sweep.stopAfter = command.sweep.stopAfter;
		}
		if (command.fields & FIELD_STOP_VALUE)
		{
			settings.sweep.stopValue = command.sweep.stopValue;
		}
		clampSweepOptions(settings.sweep);
	}

	// Run one command. Called from loop() only. Returns an error for the sender, or nullptr.
	const char* executeCommand(const Command &command)
	{
		switch (command.type)
		{
			case CommandType::Speed:
				settings.rpm = clampFloat(command.value, MIN_RPM, settings.maxRpm);
				sequencerSetSpeed(settings.rpm);
				queueSettingsSave();
				break;

			case CommandType::Run:
				if (command.hasValue)
				{
					settings.rpm = clampFloat(command.value, MIN_RPM, settings.maxRpm);
				}
				settings.dir = command.dir;
				applySpinFields(command);
				queueSettingsSave();
				sequencerSpin(settings.rpm, settings.dir, settings.spin);
				break;

			case CommandType::SpinOptions:
				applySpinFields(command);
				queueSettingsSave();
				break;

			case CommandType::SweepOptions:
				applySweepFields(command);
				queueSettingsSave();
				break;

			case CommandType::Sweep:
				if (command.hasValue)
				{
					settings.rpm = clampFloat(command.value, MIN_RPM, settings.maxRpm);
				}
				applySweepFields(command);
				queueSettingsSave();
				if (!sequencerSweep(settings.rpm, settings.sweep))
				{
					return "From and To must be different angles";
				}
				break;

			case CommandType::Stop:
				sequencerStop();
				break;

			case CommandType::Halt:
				sequencerHalt();
				break;

			case CommandType::MoveBy:
				sequencerMoveBy(command.value, settings.rpm);
				break;

			case CommandType::MoveTo:
				sequencerMoveTo(command.value, command.moveDir, settings.rpm);
				break;

			case CommandType::SetZero:
				sequencerSetZero();
				break;

			case CommandType::PresetSave:
			{
				// The speed and the options of the tab the client had open
				Preset preset = {};
				strlcpy(preset.name, command.presetName, sizeof(preset.name));
				preset.mode = command.presetMode;
				preset.rpm = settings.rpm;
				preset.spin = settings.spin;
				preset.sweep = settings.sweep;
				if (presetSave(preset) < 0)
				{
					return "All 10 presets are used. Delete one first.";
				}
				presetsChanged = true;
				break;
			}

			case CommandType::PresetApply:
			{
				// Loads the speed and options; the motion starts when the user presses Start
				const Preset *preset = presetGet(command.presetId);
				if (!preset)
				{
					return "That preset was deleted";
				}
				settings.rpm = clampFloat(preset->rpm, MIN_RPM, settings.maxRpm);
				if (preset->mode == JobType::Sweep)
				{
					settings.sweep = preset->sweep;
				}
				else
				{
					settings.spin = preset->spin;
				}
				sequencerSetSpeed(settings.rpm);
				queueSettingsSave();
				break;
			}

			case CommandType::PresetDelete:
				if (!presetDelete(command.presetId))
				{
					return "That preset was already deleted";
				}
				presetsChanged = true;
				break;

			case CommandType::WifiSetup:
				// Stop, save, and restart into the setup access point
				sequencerHalt();
				saveTurntableState();
				presetsFlush();
				networkRestartIntoSetup();
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
						sequencerSetSpeed(settings.rpm);
					}
				}
				if (command.hasAccel)
				{
					settings.accel = clampFloat(command.accel, MIN_ACCEL, MAX_ACCEL);
					motionSetAcceleration(settings.accel);
				}
				queueSettingsSave();
				break;

			case CommandType::Hello:
				break;
		}
		return nullptr;
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
		command.clientId = client->id();
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
		{
			Serial.printf("Client %lu connected\n", (unsigned long)client->id());
			client->text(stateJson());
			// The presets belong to loop(), so it sends them
			Command hello = {};
			hello.type = CommandType::Hello;
			hello.clientId = client->id();
			xQueueSend(commandQueue, &hello, 0);
			break;
		}

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
	presetsBegin();

	// Join the saved Wi-Fi network, or start setup; also adds the setup page routes
	networkBegin(server);

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
		if (command.type == CommandType::Hello)
		{
			ws.text(command.clientId, presetsJson());
			continue;
		}
		const char *error = executeCommand(command);
		if (error)
		{
			sendError(command.clientId, error);
		}
		ranCommand = true;
	}
	if (ranCommand)
	{
		broadcastState();
	}
	if (presetsChanged)
	{
		presetsChanged = false;
		ws.textAll(presetsJson());
	}
}

// Broadcast the state 10 times a second while the disk moves or a job runs, and once when they stop
void handleStateBroadcast()
{
	static unsigned long lastBroadcastMs = 0;
	static MotionState lastState = MotionState::Idle;
	static JobType lastJob = JobType::None;
	if (millis() - lastBroadcastMs >= STATE_INTERVAL_MS)
	{
		lastBroadcastMs = millis();
		const MotionState state = motionStatus().state;
		const JobType job = sequencerStatus().type;
		if (state != MotionState::Idle || job != JobType::None || state != lastState || job != lastJob)
		{
			broadcastState();
		}
		lastState = state;
		lastJob = job;
	}
}

// Save settings after an idle delay to minimize flash wear, and presets once they change.
// Flash writes pause the step timer for a moment, so writes wait while the disk moves to a
// target, where every step counts. A spin is saved as it runs: a brief hitch there only
// nudges the dial. A sweep's dwell counts as idle.
void handleSettingsStorage()
{
	const MotionState state = motionStatus().state;
	if (state != MotionState::Idle && state != MotionState::Running)
	{
		return;
	}
	if (settingsDirty && millis() - lastSettingsChangeMs >= SETTINGS_SAVE_DELAY_MS)
	{
		saveTurntableState();
	}
	presetsFlush();
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
