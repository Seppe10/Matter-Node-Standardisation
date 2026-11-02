#include <iotedu_core.h>

#include <app/server/CommissioningWindowManager.h>
#include <app/server/Server.h>
#include <bsp/esp-bsp.h>
#include <esp_err.h>
#include <esp_log.h>
#include <esp_mac.h>
#include <esp_matter.h>
#include <nvs.h>
#include <nvs_flash.h>

#include <stdio.h>
#include <string.h>

#include <app_openthread_config.h>
#include <app_reset.h>

using namespace esp_matter;
using namespace esp_matter::attribute;

static const char *TAG = "iotedu_core";

static esp_err_t ensure_stable_serial_number(char *serial, size_t serial_size)
{
    nvs_handle_t handle;
    esp_err_t err = nvs_open("chip-factory", NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }

    size_t length = serial_size;
    err = nvs_get_str(handle, "serial-num", serial, &length);
    if (err == ESP_OK && serial[0] != '\0') {
        nvs_close(handle);
        return ESP_OK;
    }

    uint8_t mac[6] = {};
    err = esp_read_mac(mac, ESP_MAC_BASE);
    if (err != ESP_OK) {
        nvs_close(handle);
        return err;
    }
    snprintf(serial, serial_size, "%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    err = nvs_set_str(handle, "serial-num", serial);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "Stored stable Basic Information serial number");
    }
    return err;
}

static esp_err_t enable_serial_number_attribute(node_t *node)
{
    endpoint_t *root = endpoint::get(node, 0);
    cluster_t *basic = root == nullptr ? nullptr : cluster::get(root, chip::app::Clusters::BasicInformation::Id);
    if (basic == nullptr) {
        return ESP_ERR_NOT_FOUND;
    }

    char serial[13] = {};
    esp_err_t err = ensure_stable_serial_number(serial, sizeof(serial));
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to store serial number, err:%d", err);
        return err;
    }
    if (cluster::basic_information::attribute::create_serial_number(basic, serial, static_cast<uint16_t>(strlen(serial))) == nullptr) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

static esp_err_t factory_reset_button_register()
{
    button_handle_t push_button;
    esp_err_t err = bsp_iot_button_create(&push_button, NULL, BSP_BUTTON_NUM);
    VerifyOrReturnError(err == ESP_OK, err);
    return app_reset_button_register(push_button);
}

static void open_commissioning_window_if_necessary()
{
    VerifyOrReturn(chip::Server::GetInstance().GetFabricTable().FabricCount() == 0);

    chip::CommissioningWindowManager &commissionMgr = chip::Server::GetInstance().GetCommissioningWindowManager();
    VerifyOrReturn(commissionMgr.IsCommissioningWindowOpen() == false);

    CHIP_ERROR err = commissionMgr.OpenBasicCommissioningWindow(chip::System::Clock::Seconds16(300),
                                                                chip::CommissioningWindowAdvertisement::kDnssdOnly);
    if (err != CHIP_NO_ERROR) {
        ESP_LOGE(TAG, "Failed to open commissioning window, err:%" CHIP_ERROR_FORMAT, err.Format());
    }
}

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

static esp_err_t app_identification_cb(identification::callback_type_t type, uint16_t endpoint_id, uint8_t effect_id,
                                       uint8_t effect_variant, void *priv_data)
{
    ESP_LOGI(TAG, "Identification callback: type: %u, effect: %u, variant: %u", type, effect_id, effect_variant);
    return ESP_OK;
}

static esp_err_t app_attribute_update_cb(attribute::callback_type_t type, uint16_t endpoint_id, uint32_t cluster_id,
                                         uint32_t attribute_id, esp_matter_attr_val_t *val, void *priv_data)
{
    return ESP_OK;
}

esp_err_t iotedu_core_prepare(esp_matter::node_t **node)
{
    if (node == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }

    // The reference firmware ignores this return value.
    nvs_flash_init();

    esp_err_t err = factory_reset_button_register();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to initialize reset button, err:%d", err);
        return err;
    }

    node::config_t node_config;
    node_t *created = node::create(&node_config, app_attribute_update_cb, app_identification_cb);
    if (created == nullptr) {
        ESP_LOGE(TAG, "Failed to create Matter node");
        return ESP_FAIL;
    }
    err = enable_serial_number_attribute(created);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to enable Basic Information SerialNumber, err:%d", err);
        return err;
    }
    *node = created;
    return ESP_OK;
}

esp_err_t iotedu_core_start(void)
{
#if CHIP_DEVICE_CONFIG_ENABLE_THREAD
    esp_openthread_platform_config_t config = {
        .radio_config = ESP_OPENTHREAD_DEFAULT_RADIO_CONFIG(),
        .host_config = ESP_OPENTHREAD_DEFAULT_HOST_CONFIG(),
        .port_config = ESP_OPENTHREAD_DEFAULT_PORT_CONFIG(),
    };
    set_openthread_platform_config(&config);
#endif

    esp_err_t err = esp_matter::start(app_event_cb);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start Matter, err:%d", err);
    }
    return err;
}
