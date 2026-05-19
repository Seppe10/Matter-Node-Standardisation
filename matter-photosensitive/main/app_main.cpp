// -----------------------------------------------------------------------------
// Matter Photosensitive Light Sensor - Main Application
// -----------------------------------------------------------------------------
// This file is the main entry point for the ESP32-H2 Matter light sensor device
// It creates a Matter node, adds a Light Sensor endpoint, configures Thread when enabled, starts the Matter stack, and then starts the photosensitive sensor driver that updates the Matter illuminance value
// Main functions of this code:
// 1. Initialise NVS storage for Matter commissioning data
// 2. Create the main Matter node
// 3. Create a Matter Light Sensor endpoint
// 4. Configure OpenThread when Matter-over-Thread is enabled
// 5. Start the Matter server
// 6. Start the photoresistor/light sensor driver
// -------------------------------

#include <esp_err.h>    // ESP-IDF error types and helper functions
#include <esp_log.h>    // ESP-IDF logging functions for serial monitor output
#include <nvs_flash.h>  // Non-volatile storage used by Matter commissioning

#include <esp_matter.h> // ESP-Matter framework
#include "app_openthread_config.h"  // Project-specific OpenThread configuration

// OpenThread header
#if CHIP_DEVICE_CONFIG_ENABLE_THREAD
#include <platform/ESP32/OpenthreadLauncher.h>
#endif

// Driver used to read the photoresistor and update the Matter illuminance value
#include "drivers/photosensitive_sensor.h"

// Log tag used to identify messages from this file in the serial monitor
static const char *TAG = "app_main";

// Shortens access to ESP-Matter endpoint and Matter cluster types
using namespace esp_matter;
using namespace esp_matter::endpoint;
using namespace chip::app::Clusters;

// -----------------------------------------------------------------------------
// Matter event callback
// -----------------------------------------------------------------------------
// This function is called by the Matter stack when important device events occur, such as commissioning completing or failing. It is mainly used here for useful serial monitor logging
// -----------------------------------------------------------------------------

static void app_event_cb(const ChipDeviceEvent *event, intptr_t arg)
{
    switch (event->Type) {
    case chip::DeviceLayer::DeviceEventType::kCommissioningComplete:
        ESP_LOGI(TAG, "Commissioning complete");
        break;

    case chip::DeviceLayer::DeviceEventType::kFailSafeTimerExpired:
        ESP_LOGI(TAG, "Commissioning failed: fail-safe timer expired");
        break;

    case chip::DeviceLayer::DeviceEventType::kBLEDeinitialized:
        ESP_LOGI(TAG, "BLE deinitialized");
        break;

    default:
        break;
    }
}

// -----------------------------------------------------------------------------
// Matter identification callback
// -----------------------------------------------------------------------------
// Matter controllers can send an Identify command to help the user confirm which physical device is being controlled. This callback currently only logs the endpoint that received the Identify request
// -----------------------------------------------------------------------------

static esp_err_t app_identification_cb(
    esp_matter::identification::callback_type_t type,
    uint16_t endpoint_id,
    uint8_t effect_id,
    uint8_t effect_variant,
    void *priv_data)
{
    ESP_LOGI(TAG, "Identification callback: endpoint=%u", endpoint_id);
    return ESP_OK;
}

// -----------------------------------------------------------------------------
// Matter attribute update callback
// -----------------------------------------------------------------------------
// This callback is triggered when a Matter attribute is updated
// -----------------------------------------------------------------------------

static esp_err_t app_attribute_update_cb(
    esp_matter::attribute::callback_type_t type,
    uint16_t endpoint_id,
    uint32_t cluster_id,
    uint32_t attribute_id,
    esp_matter_attr_val_t *val,
    void *priv_data)
{
    return ESP_OK;
}

// -----------------------------------------------------------------------------
// app_main
// -----------------------------------------------------------------------------
// Main entry point for the ESP-IDF application. This runs once when the ESP32-H2 starts. After setup is complete, Matter and the photosensitive sensor driver continue running through their own tasks
// -----------------------------------------------------------------------------

extern "C" void app_main()
{
    // -------------------------------------------------------------------------
    // Initialise NVS
    // -------------------------------------------------------------------------
    // NVS stores Matter commissioning data, including fabric information
    // Without NVS, the device would not remember its commissioned smart home
    // -------------------------------------------------------------------------
    esp_err_t err = nvs_flash_init();

    // If the NVS partition is full or from an incompatible version, erase it and initialise it again
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to initialize NVS: %s", esp_err_to_name(err));
        return;
    }

    // -------------------------------------------------------------------------
    // Create Matter node
    // -------------------------------------------------------------------------
    // The Matter node represents the physical device. Endpoints are added to this node to describe the device features
    // -------------------------------------------------------------------------
    node::config_t node_config;
    node_t *node = node::create(&node_config, app_attribute_update_cb, app_identification_cb);

    if (!node) {
        ESP_LOGE(TAG, "Failed to create Matter node");
        return;
    }

    // -------------------------------------------------------------------------
    // Create Matter Light Sensor endpoint
    // -------------------------------------------------------------------------
    // The light sensor endpoint exposes the Illuminance Measurement cluster to the smart home controller
    // -------------------------------------------------------------------------
    light_sensor::config_t light_sensor_config;
    endpoint_t *light_sensor_ep = light_sensor::create(
        node,
        &light_sensor_config,
        ENDPOINT_FLAG_NONE,
        NULL
    );

    if (!light_sensor_ep) {
        ESP_LOGE(TAG, "Failed to create Light Sensor endpoint");
        return;
    }

    // Store the endpoint ID so it can be passed to the sensor driver. The driver uses this ID when updating the Matter illuminance attribute.
    uint16_t light_sensor_endpoint_id = endpoint::get_id(light_sensor_ep);
    ESP_LOGI(TAG, "Light Sensor endpoint created: endpoint_id=%u", light_sensor_endpoint_id);

// -------------------------------------------------------------------------
// Configure Thread networking when enabled
// -------------------------------------------------------------------------
// The ESP32-H2 supports Matter-over-Thread. If Thread support is enabled in the project configuration, this section sets up the OpenThread radio, host, and port configuration before Matter is started.
// -------------------------------------------------------------------------
#if CHIP_DEVICE_CONFIG_ENABLE_THREAD
    esp_openthread_platform_config_t config = {
        .radio_config = ESP_OPENTHREAD_DEFAULT_RADIO_CONFIG(),
        .host_config = ESP_OPENTHREAD_DEFAULT_HOST_CONFIG(),
        .port_config = ESP_OPENTHREAD_DEFAULT_PORT_CONFIG(),
    };

    set_openthread_platform_config(&config);
#endif

    // -------------------------------------------------------------------------
    // Start Matter
    // -------------------------------------------------------------------------
    // After this call, the device can open a commissioning window and communicate with Matter controllers over the configured transport
    // -------------------------------------------------------------------------
    err = esp_matter::start(app_event_cb);

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start Matter: %s", esp_err_to_name(err));
        return;
    }

    // -------------------------------------------------------------------------
    // Start the photosensitive sensor driver
    // -------------------------------------------------------------------------
    // The driver reads the ADC, estimates lux, converts the lux value into the Matter Illuminance Measurement format, and updates the endpoint created above.
    // -------------------------------------------------------------------------
    err = photosensitive_sensor_init(light_sensor_endpoint_id);

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start photosensitive sensor: %s", esp_err_to_name(err));
        return;
    }

    ESP_LOGI(TAG, "Matter photosensitive light sensor started");
}
