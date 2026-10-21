#include "presets.h"
#include "config.h"

#include <cmath>

#include <Preferences.h>

namespace
{
    // Presets live in NVS, so firmware and web UI uploads both keep them. One key per slot.
    constexpr char PRESETS_NAMESPACE[] = "presets";

    // What's stored under each slot's key. Bump MAGIC whenever the layout changes.
    struct StoredPreset
    {
        static constexpr uint32_t MAGIC = 0x50525331;   // "PRS1"

        uint32_t magic;
        Preset preset;
    };

    Preferences presetPrefs;
    bool storageOpen = false;

    // Owned by loop()
    Preset presets[PRESET_SLOTS];
    bool used[PRESET_SLOTS] = {};
    uint16_t dirty = 0;     // One bit per slot that has to be written or removed

    // NVS key for a slot: "p0" to "p9"
    void slotKey(uint8_t id, char (&key)[4])
    {
        snprintf(key, sizeof(key), "p%u", id);
    }

    // Check a loaded preset and keep it inside the limits; false if it can't be used
    bool sanitize(Preset &preset)
    {
        preset.name[PRESET_NAME_SIZE - 1] = '\0';
        if (preset.name[0] == '\0' || (preset.mode != JobType::Spin && preset.mode != JobType::Sweep))
        {
            return false;
        }
        if (!std::isfinite(preset.rpm))
        {
            preset.rpm = DEFAULT_RPM;
        }
        preset.rpm = preset.rpm < MIN_RPM ? MIN_RPM : (preset.rpm > MAX_RPM_LIMIT ? MAX_RPM_LIMIT : preset.rpm);
        clampSpinOptions(preset.spin);
        clampSweepOptions(preset.sweep);
        return true;
    }
}

// Load the saved presets from NVS
void presetsBegin()
{
    storageOpen = presetPrefs.begin(PRESETS_NAMESPACE, false);
    if (!storageOpen)
    {
        // Presets still work until the next power-up; they just aren't kept
        Serial.println("Error: Failed to open preset storage (NVS)");
        return;
    }

    uint8_t count = 0;
    for (uint8_t id = 0; id < PRESET_SLOTS; id++)
    {
        char key[4];
        slotKey(id, key);
        if (!presetPrefs.isKey(key))
        {
            continue;
        }
        StoredPreset stored;
        const size_t bytesRead = presetPrefs.getBytes(key, &stored, sizeof(stored));
        if (bytesRead != sizeof(stored) || stored.magic != StoredPreset::MAGIC || !sanitize(stored.preset))
        {
            Serial.printf("Preset %u is from another version, ignoring it\n", id);
            continue;
        }
        presets[id] = stored.preset;
        used[id] = true;
        count++;
    }
    Serial.printf("Presets loaded: %u\n", count);
}

// The preset in a slot, or nullptr if the slot is empty
const Preset* presetGet(uint8_t id)
{
    return id < PRESET_SLOTS && used[id] ? &presets[id] : nullptr;
}

// Save a preset over the one with the same name, or else in the first free slot.
// Returns the slot, or -1 if every slot is used.
int presetSave(const Preset &preset)
{
    int slot = -1;
    for (uint8_t id = 0; id < PRESET_SLOTS && slot < 0; id++)
    {
        if (used[id] && strcmp(presets[id].name, preset.name) == 0)
        {
            slot = id;
        }
    }
    for (uint8_t id = 0; id < PRESET_SLOTS && slot < 0; id++)
    {
        if (!used[id])
        {
            slot = id;
        }
    }
    if (slot < 0)
    {
        return -1;
    }

    presets[slot] = preset;
    presets[slot].name[PRESET_NAME_SIZE - 1] = '\0';
    used[slot] = true;
    dirty |= 1u << slot;
    return slot;
}

// Delete a preset. Returns false if the slot was already empty.
bool presetDelete(uint8_t id)
{
    if (!presetGet(id))
    {
        return false;
    }
    used[id] = false;
    dirty |= 1u << id;
    return true;
}

// Write changed presets to flash. Flash writes pause stepping, so only call this while that's harmless.
void presetsFlush()
{
    if (dirty == 0 || !storageOpen)
    {
        return;
    }

    for (uint8_t id = 0; id < PRESET_SLOTS; id++)
    {
        if (!(dirty & (1u << id)))
        {
            continue;
        }
        char key[4];
        slotKey(id, key);
        if (used[id])
        {
            const StoredPreset stored = {StoredPreset::MAGIC, presets[id]};
            if (presetPrefs.putBytes(key, &stored, sizeof(stored)) != sizeof(stored))
            {
                Serial.printf("Error: Failed to write preset %u\n", id);
                continue;
            }
            Serial.printf("Preset %u saved: %s\n", id, presets[id].name);
        }
        else if (presetPrefs.isKey(key))
        {
            presetPrefs.remove(key);
            Serial.printf("Preset %u deleted\n", id);
        }
    }
    // Not retried until the next change, so a failing flash isn't hammered
    dirty = 0;
}
