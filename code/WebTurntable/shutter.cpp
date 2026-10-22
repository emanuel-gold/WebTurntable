#include "shutter.h"

#include <NimBLEDevice.h>
#include <NimBLEHIDDevice.h>

namespace
{
    constexpr char DEVICE_NAME[] = "Turntable Shutter";
    constexpr uint8_t REPORT_ID = 1;
    constexpr unsigned long PRESS_MS = 60;      // Short, so the camera doesn't read a hold (QuickTake video)
    constexpr uint16_t APPEARANCE_GENERIC_HID = 0x03C0;

    // Consumer control only: Volume Up and Volume Down, one bit each. No keyboard usage page,
    // because iOS hides its on-screen keyboard while a Bluetooth keyboard is connected.
    const uint8_t REPORT_MAP[] =
    {
        0x05, 0x0C,         // Usage Page (Consumer)
        0x09, 0x01,         // Usage (Consumer Control)
        0xA1, 0x01,         // Collection (Application)
        0x85, REPORT_ID,    //   Report ID
        0x15, 0x00,         //   Logical Minimum (0)
        0x25, 0x01,         //   Logical Maximum (1)
        0x75, 0x01,         //   Report Size (1)
        0x95, 0x02,         //   Report Count (2)
        0x09, 0xE9,         //   Usage (Volume Increment)
        0x09, 0xEA,         //   Usage (Volume Decrement)
        0x81, 0x02,         //   Input (Data, Variable, Absolute)
        0x95, 0x06,         //   Report Count (6): padding to a byte
        0x81, 0x03,         //   Input (Constant)
        0xC0                // End Collection
    };

    // Written by the NimBLE host task (core 0), read by loop()
    volatile bool s_connected = false;
    volatile bool s_encrypted = false;
    volatile bool s_subscribed = false;

    // Owned by loop()
    NimBLEServer *server = nullptr;
    NimBLECharacteristic *inputReport = nullptr;
    bool enabled = false;
    bool pressing = false;
    unsigned long pressStartMs = 0;

    // Send one input report: the bits of the keys held down
    void sendReport(uint8_t keys)
    {
        inputReport->setValue(&keys, 1);
        inputReport->notify();
    }

    // Tracks the phone's connection and pairing
    class ServerCallbacks : public NimBLEServerCallbacks
    {
        void onConnect(NimBLEServer *, NimBLEConnInfo &connInfo) override
        {
            s_connected = true;
            s_encrypted = connInfo.isEncrypted();
            Serial.printf("Shutter: phone connected (%s)\n", connInfo.getAddress().toString().c_str());
        }

        void onDisconnect(NimBLEServer *, NimBLEConnInfo &, int reason) override
        {
            s_connected = false;
            s_encrypted = false;
            s_subscribed = false;
            Serial.printf("Shutter: phone disconnected (reason 0x%02x)\n", reason);
        }

        void onAuthenticationComplete(NimBLEConnInfo &connInfo) override
        {
            s_encrypted = connInfo.isEncrypted();
            Serial.printf("Shutter: pairing %s\n", s_encrypted ? "done" : "failed");
        }
    } serverCallbacks;

    // Tracks whether the phone listens for key presses
    class ReportCallbacks : public NimBLECharacteristicCallbacks
    {
        void onSubscribe(NimBLECharacteristic *, NimBLEConnInfo &, uint16_t subValue) override
        {
            s_subscribed = (subValue & 1) != 0;
        }
    } reportCallbacks;

    // Set up the advertisement once: a HID device, with the name in the scan response.
    // Adding the service again on every start would grow the advertisement each time.
    void configureAdvertising()
    {
        NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
        advertising->setAppearance(APPEARANCE_GENERIC_HID);
        advertising->addServiceUUID(NimBLEUUID((uint16_t)0x1812));
        advertising->setName(DEVICE_NAME);
        advertising->enableScanResponse(true);
    }
}

// Start the Bluetooth stack as a BLE remote named "Turntable Shutter", advertising if enabled
void shutterBegin(bool enable)
{
    NimBLEDevice::init(DEVICE_NAME);
    // Just Works pairing with bonding, so the phone reconnects by itself after the first time
    NimBLEDevice::setSecurityAuth(true, false, true);
    NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);

    server = NimBLEDevice::createServer();
    server->setCallbacks(&serverCallbacks);

    NimBLEHIDDevice *hid = new NimBLEHIDDevice(server);
    hid->setManufacturer("WebTurntable");
    hid->setPnp(0x02, 0xE502, 0xA111, 0x0210);
    hid->setHidInfo(0x00, 0x01);
    hid->setReportMap((uint8_t*)REPORT_MAP, sizeof(REPORT_MAP));
    inputReport = hid->getInputReport(REPORT_ID);
    inputReport->setCallbacks(&reportCallbacks);
    hid->setBatteryLevel(100);
    server->start();
    configureAdvertising();

    shutterSetEnabled(enable);
    Serial.printf("Shutter: Bluetooth %s, %d phone(s) paired\n", enable ? "on" : "off", NimBLEDevice::getNumBonds());
}

// Start or stop advertising. Turning it off also drops the connected phone.
void shutterSetEnabled(bool enable)
{
    enabled = enable;
    server->advertiseOnDisconnect(enable);
    if (enable)
    {
        if (!s_connected)
        {
            NimBLEDevice::startAdvertising();
        }
        return;
    }
    NimBLEDevice::stopAdvertising();
    for (uint16_t handle : server->getPeerDevices())
    {
        server->disconnect(handle);
    }
}

// Press and release a key on the connected phone. Returns false if no phone is ready.
bool shutterPress(ShutterKey key)
{
    if (!shutterStatus().ready)
    {
        return false;
    }
    if (!pressing)
    {
        sendReport(key == ShutterKey::VolumeDown ? 0x02 : 0x01);
        pressing = true;
        pressStartMs = millis();
    }
    return true;
}

// Release a pressed key once it has been held long enough. Called from loop().
void handleShutter()
{
    if (pressing && millis() - pressStartMs >= PRESS_MS)
    {
        pressing = false;
        if (s_connected)
        {
            sendReport(0);
        }
    }
}

// Current connection state
ShutterStatus shutterStatus()
{
    ShutterStatus status;
    status.enabled = enabled;
    status.connected = s_connected;
    status.ready = s_connected && s_encrypted && s_subscribed;
    return status;
}

// Drop the connected phone and forget every pairing, so a new phone can pair
void shutterForgetPhones()
{
    for (uint16_t handle : server->getPeerDevices())
    {
        server->disconnect(handle);
    }
    NimBLEDevice::deleteAllBonds();
    Serial.println("Shutter: forgot all paired phones");
}
