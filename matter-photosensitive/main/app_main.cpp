#include <esp_err.h>
#include <esp_log.h>
#include <nvs_flash.h>

#include <esp_matter.h>
#include "app_openthread_config.h"

#if CHIP_DEVICE_CONFIG_ENABLE_THREAD
#include <platform/ESP32/OpenthreadLauncher.h>
#endif

#include "drivers/photosensitive_sensor.h"

static const char *TAG = "app_main";

using namespace esp_matter;
using namespace esp_matter::endpoint;
using namespace chip::app::Clusters;

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

extern "C" void app_main()
{
    esp_err_t err = nvs_flash_init();

    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to initialize NVS: %s", esp_err_to_name(err));
        return;
    }

    node::config_t node_config;
    node_t *node = node::create(&node_config, app_attribute_update_cb, app_identification_cb);

    if (!node) {
        ESP_LOGE(TAG, "Failed to create Matter node");
        return;
    }

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

    uint16_t light_sensor_endpoint_id = endpoint::get_id(light_sensor_ep);
    ESP_LOGI(TAG, "Light Sensor endpoint created: endpoint_id=%u", light_sensor_endpoint_id);

#if CHIP_DEVICE_CONFIG_ENABLE_THREAD
    esp_openthread_platform_config_t config = {
        .radio_config = ESP_OPENTHREAD_DEFAULT_RADIO_CONFIG(),
        .host_config = ESP_OPENTHREAD_DEFAULT_HOST_CONFIG(),
        .port_config = ESP_OPENTHREAD_DEFAULT_PORT_CONFIG(),
    };

    set_openthread_platform_config(&config);
#endif

    err = esp_matter::start(app_event_cb);

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start Matter: %s", esp_err_to_name(err));
        return;
    }

    err = photosensitive_sensor_init(light_sensor_endpoint_id);

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start photosensitive sensor: %s", esp_err_to_name(err));
        return;
    }

    ESP_LOGI(TAG, "Matter photosensitive light sensor started");
}
