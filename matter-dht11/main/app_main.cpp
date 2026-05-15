// -----------------------------------------------------------------------------
// Matter DHT11 Temperature and Humidity Sensor - Main Application
// -----------------------------------------------------------------------------
// This file creates a Matter device that reports temperature and humidity values from a DHT11 sensor. The ESP32-H2 reads the DHT11 in a background FreeRTOS task, then updates two separate Matter endpoints:
// 1. Temperature Sensor endpoint
// 2. Humidity Sensor endpoint
//
// Main functions of this code:
// 1. Initialise NVS storage for Matter commissioning data
// 2. Register a factory reset button
// 3. Create a Matter node
// 4. Add temperature and humidity sensor endpoints
// 5. Initialise the DHT11 driver
// 6. Start a background task that polls the DHT11
// 7. Configure Thread networking when enabled
// 8. Start the Matter server
// -----------------------------------------------------------------------------

#include <app/server/CommissioningWindowManager.h>  // Used to open/reopen Matter commissioning windows
#include <app/server/Server.h>                      // Gives access to the Matter server and fabric table
#include <bsp/esp-bsp.h>                            // Board support package, including button helpers
#include <esp_err.h>                                // ESP-IDF error types and helper functions
#include <esp_log.h>                                // ESP-IDF logging functions
#include <esp_matter.h>                             // ESP-Matter framework
#include <esp_matter_ota.h>                         // ESP-Matter OTA support - Not yet used
#include <nvs_flash.h>                              // Non-volatile storage used by Matter

#include <app_openthread_config.h>                  // Project-specific OpenThread configuration
#include <app_reset.h>                              // Reset button helper functions
#include <common_macros.h>                          // Helper macros

// DHT11 driver used by this application
#include <drivers/dht11.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// Log tag used to identify messages from this file in the serial monitor
static const char *TAG = "app_main";

// Shortens access to ESP-Matter and Matter cluster types used below
using namespace esp_matter;
using namespace esp_matter::attribute;
using namespace esp_matter::endpoint;
using namespace chip::app::Clusters;

// -----------------------------------------------------------------------------
// Temperature Matter update helper
// -----------------------------------------------------------------------------
// The Matter Temperature Measurement cluster stores temperature as Celsius x 100
// Example:
// - 24.00°C is stored as 2400
// - 25.50°C is stored as 2550
// The update is scheduled onto the Matter/SystemLayer thread. This avoids directly modifying Matter attributes from the DHT11 FreeRTOS task
// -----------------------------------------------------------------------------
static void temp_sensor_notification(uint16_t endpoint_id, float temp, void *user_data)
{
    // schedule the attribute update so that we can report it from matter thread
    chip::DeviceLayer::SystemLayer().ScheduleLambda([endpoint_id, temp]() {
        attribute_t * attribute = attribute::get(endpoint_id,
                                                 TemperatureMeasurement::Id,
                                                 TemperatureMeasurement::Attributes::MeasuredValue::Id);

         // Read the current attribute value first so the type and metadata remain valid
        esp_matter_attr_val_t val = esp_matter_invalid(NULL);
        attribute::get_val(attribute, &val);

        // Convert Celsius into Matter format: temperature x 100
        val.val.i16 = static_cast<int16_t>(temp * 100);
        
        // Write the new temperature value to the Matter endpoint
        attribute::update(endpoint_id, TemperatureMeasurement::Id, TemperatureMeasurement::Attributes::MeasuredValue::Id, &val);
    });
}

// -----------------------------------------------------------------------------
// Humidity Matter update helper
// -----------------------------------------------------------------------------
// The Matter Relative Humidity Measurement cluster stores humidity as percent x 100
// Example:
// - 50% relative humidity is stored as 5000
// - 65.5% relative humidity is stored as 6550
// The DHT11 normally reports whole-number humidity values, but Matter still uses the x100 format
// -----------------------------------------------------------------------------
static void humidity_sensor_notification(uint16_t endpoint_id, float humidity, void *user_data)
{
    chip::DeviceLayer::SystemLayer().ScheduleLambda([endpoint_id, humidity]() {
        attribute_t * attribute = attribute::get(endpoint_id,
                                                 RelativeHumidityMeasurement::Id,
                                                 RelativeHumidityMeasurement::Attributes::MeasuredValue::Id);

        // Read the current attribute value first so the type and metadata remain valid
        esp_matter_attr_val_t val = esp_matter_invalid(NULL);
        attribute::get_val(attribute, &val);

        // Convert relative humidity into Matter format: humidity x 100
        val.val.u16 = static_cast<uint16_t>(humidity * 100);
        
        // Write the new humidity value to the Matter endpoint
        attribute::update(endpoint_id, RelativeHumidityMeasurement::Id, RelativeHumidityMeasurement::Attributes::MeasuredValue::Id, &val);
    });
}

// Factory reset button not required, remove
static esp_err_t factory_reset_button_register()
{
    button_handle_t push_button;
    esp_err_t err = bsp_iot_button_create(&push_button, NULL, BSP_BUTTON_NUM);
    VerifyOrReturnError(err == ESP_OK, err);
    return app_reset_button_register(push_button);
}

// -----------------------------------------------------------------------------
// Reopen commissioning window when needed
// -----------------------------------------------------------------------------
// This function checks whether the device has any Matter fabrics remaining. A fabric represents a commissioned smart home connection. If there are no fabrics left, the function opens a new commissioning window so the device can be added to a smart home again
// -----------------------------------------------------------------------------
static void open_commissioning_window_if_necessary()
{
    // Only continue if there are no commissioned fabrics left.
    VerifyOrReturn(chip::Server::GetInstance().GetFabricTable().FabricCount() == 0);

    // Do not open another window if one is already open
    chip::CommissioningWindowManager  &commissionMgr = chip::Server::GetInstance().GetCommissioningWindowManager();
    VerifyOrReturn(commissionMgr.IsCommissioningWindowOpen() == false);

    // Open a basic commissioning window for 300 seconds
    // This example uses DNS-SD advertisement only
    CHIP_ERROR err = commissionMgr.OpenBasicCommissioningWindow(chip::System::Clock::Seconds16(300),
                                                                chip::CommissioningWindowAdvertisement::kDnssdOnly);
    if (err != CHIP_NO_ERROR) {
        ESP_LOGE(TAG, "Failed to open commissioning window, err:%" CHIP_ERROR_FORMAT, err.Format());
    }
}

// -----------------------------------------------------------------------------
// Matter event callback
// -----------------------------------------------------------------------------
// This function receives high-level Matter device events and logs useful status messages. It also reopens the commissioning window when the last fabric is removed
// -----------------------------------------------------------------------------
static void app_event_cb(const ChipDeviceEvent *event, intptr_t arg)
{
    switch (event->Type) {
    case chip::DeviceLayer::DeviceEventType::kCommissioningComplete:
        ESP_LOGI(TAG, "Commissioning complete");
        break;

    case chip::DeviceLayer::DeviceEventType::kFailSafeTimerExpired:
        ESP_LOGI(TAG, "Commissioning failed, fail safe timer expired");
        break;

    case chip::DeviceLayer::DeviceEventType::kFabricRemoved:
        ESP_LOGI(TAG, "Fabric removed successfully");
        open_commissioning_window_if_necessary();
        break;

    case chip::DeviceLayer::DeviceEventType::kBLEDeinitialized:
        ESP_LOGI(TAG, "BLE deinitialized and memory reclaimed");
        break;

    default:
        break;
    }
}

// -----------------------------------------------------------------------------
// Matter Identify callback
// -----------------------------------------------------------------------------
// Matter controllers can send Identify commands to help the user confirm which physical device they are controlling. This implementation only logs the identify request, but it could be expanded to blink an LED or show another visible indication
// -----------------------------------------------------------------------------
static esp_err_t app_identification_cb(identification::callback_type_t type, uint16_t endpoint_id, uint8_t effect_id,
                                       uint8_t effect_variant, void *priv_data)
{
    ESP_LOGI(TAG, "Identification callback: type: %u, effect: %u, variant: %u", type, effect_id, effect_variant);
    return ESP_OK;
}

// -----------------------------------------------------------------------------
// Matter attribute update callback
// -----------------------------------------------------------------------------
// This callback is called when Matter attributes are updated
// -----------------------------------------------------------------------------
static esp_err_t app_attribute_update_cb(attribute::callback_type_t type, uint16_t endpoint_id, uint32_t cluster_id,
                                         uint32_t attribute_id, esp_matter_attr_val_t *val, void *priv_data)
{
    // Since this is just a sensor and we don't expect any writes on our temperature sensor,
    // so, return success.
    return ESP_OK;
}

// -----------------------------------------------------------------------------
// DHT11 Matter configuration structure
// -----------------------------------------------------------------------------
// Stores the endpoint IDs for the two Matter endpoints that the DHT11 task needs to update
// - temperature_endpoint_id points to the Temperature Sensor endpoint
// - humidity_endpoint_id points to the Humidity Sensor endpoint
// -----------------------------------------------------------------------------
typedef struct {
    uint16_t temperature_endpoint_id;
    uint16_t humidity_endpoint_id;
} dht11_matter_config_t;

// -----------------------------------------------------------------------------
// DHT11 background task
// -----------------------------------------------------------------------------
// This FreeRTOS task continuously reads the DHT11 sensor and updates the Matter temperature and humidity endpoints
// Cycle:
// 1. Wait briefly after startup to let the sensor stabilise
// 2. Read temperature and humidity from the DHT11
// 3. If the read succeeds, update the Matter attributes
// // 4. If the read fails, log the error
// 5. Wait 2 seconds before reading again
// -----------------------------------------------------------------------------
static void dht11_task(void *arg)
{
    dht11_matter_config_t *config = static_cast<dht11_matter_config_t *>(arg);

    vTaskDelay(pdMS_TO_TICKS(2000));

    while (true) {
        dht11_reading_t reading = {};

        esp_err_t err = dht11_read(&reading);

        if (err == ESP_OK) {
            ESP_LOGI(TAG,
                     "DHT11 Temperature: %d°C, Humidity: %u%%RH",
                     reading.temperature,
                     reading.humidity);

            temp_sensor_notification(
                config->temperature_endpoint_id,
                static_cast<float>(reading.temperature),
                NULL
            );

            humidity_sensor_notification(
                config->humidity_endpoint_id,
                static_cast<float>(reading.humidity),
                NULL
            );
        } else {
            ESP_LOGW(TAG, "DHT11 read failed: %s", esp_err_to_name(err));
        }

        vTaskDelay(pdMS_TO_TICKS(2000));
    }
}

// -----------------------------------------------------------------------------
// app_main
// -----------------------------------------------------------------------------
// Main entry point for the ESP-IDF application. This function runs once at boot, sets up Matter, creates the sensor endpoints, starts the DHT11 task, configures Thread if enabled, and starts the Matter server.
// -----------------------------------------------------------------------------
extern "C" void app_main()
{
    // -------------------------------------------------------------------------
    // Initialise NVS
    // -------------------------------------------------------------------------
    // NVS stores Matter commissioning data, including fabric information
    // Without NVS, the device would not remember its commissioned smart home
    // -------------------------------------------------------------------------
    nvs_flash_init();

    // Needs to be removed
    esp_err_t err = factory_reset_button_register();
    ABORT_APP_ON_FAILURE(ESP_OK == err, ESP_LOGE(TAG, "Failed to initialize reset button, err:%d", err));

    // -------------------------------------------------------------------------
    // Create Matter node
    // -------------------------------------------------------------------------
    // The Matter node represents the physical device. Sensor endpoints are added to this node so the controller can discover the device capabilities
    // -------------------------------------------------------------------------
    node::config_t node_config;
    node_t *node = node::create(&node_config, app_attribute_update_cb, app_identification_cb);
    ABORT_APP_ON_FAILURE(node != nullptr, ESP_LOGE(TAG, "Failed to create Matter node"));

    // -------------------------------------------------------------------------
    // Create Temperature Sensor endpoint
    // -------------------------------------------------------------------------
    // This endpoint exposes the Matter Temperature Measurement cluster
    // -------------------------------------------------------------------------
    temperature_sensor::config_t temp_sensor_config;
    endpoint_t * temp_sensor_ep = temperature_sensor::create(node, &temp_sensor_config, ENDPOINT_FLAG_NONE, NULL);
    ABORT_APP_ON_FAILURE(temp_sensor_ep != nullptr, ESP_LOGE(TAG, "Failed to create temperature_sensor endpoint"));

    // -------------------------------------------------------------------------
    // Create Humidity Sensor endpoint
    // -------------------------------------------------------------------------
    // This endpoint exposes the Matter Relative Humidity Measurement cluster
    // -------------------------------------------------------------------------
    humidity_sensor::config_t humidity_sensor_config;
    endpoint_t * humidity_sensor_ep = humidity_sensor::create(node, &humidity_sensor_config, ENDPOINT_FLAG_NONE, NULL);
    ABORT_APP_ON_FAILURE(humidity_sensor_ep != nullptr, ESP_LOGE(TAG, "Failed to create humidity_sensor endpoint"));

    // -------------------------------------------------------------------------
    // Initialise DHT11 driver
    // -------------------------------------------------------------------------
    // This configures the GPIO used to communicate with the DHT11 sensor
    // -------------------------------------------------------------------------
    err = dht11_init();
    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, "Failed to initialize DHT11 driver"));

    // Store the endpoint IDs so the DHT11 task knows where to report each value
    static dht11_matter_config_t dht11_config = {
        .temperature_endpoint_id = endpoint::get_id(temp_sensor_ep),
        .humidity_endpoint_id = endpoint::get_id(humidity_sensor_ep),
    };

    // -------------------------------------------------------------------------
    // Start DHT11 sensor task
    // -------------------------------------------------------------------------
    xTaskCreate(
        dht11_task,
        "dht11_task",
        4096,
        &dht11_config,
        5,
        NULL
    );

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
    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, "Failed to start Matter, err:%d", err));
}
