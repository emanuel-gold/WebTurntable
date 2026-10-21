#ifndef PRESETS_H
#define PRESETS_H

#include <Arduino.h>

#include "sequencer.h"

constexpr uint8_t PRESET_SLOTS = 10;
constexpr size_t PRESET_NAME_SIZE = 64;     // UTF-8 bytes, including the terminator

// A saved mode with its speed and options. Drive mode, acceleration and max speed aren't included.
struct Preset
{
    char name[PRESET_NAME_SIZE];
    JobType mode;           // Spin or Sweep
    float rpm;
    SpinOptions spin;       // Used when mode is Spin
    SweepOptions sweep;     // Used when mode is Sweep
};

// Load the saved presets from NVS
void presetsBegin();

// The preset in a slot, or nullptr if the slot is empty
const Preset* presetGet(uint8_t id);

// Save a preset over the one with the same name, or else in the first free slot.
// Returns the slot, or -1 if every slot is used.
int presetSave(const Preset &preset);

// Delete a preset. Returns false if the slot was already empty.
bool presetDelete(uint8_t id);

// Write changed presets to flash. Flash writes pause stepping, so only call this while that's harmless.
void presetsFlush();

#endif // PRESETS_H
