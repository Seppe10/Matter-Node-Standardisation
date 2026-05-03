#include "photosensitive_sensor.h"

#include <math.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_adc/adc_oneshot.h"
#include "esp_err.h"
#include "esp_log.h"

#include <esp_matter.h>
#include <platform/CHIPDeviceLayer.h>
#include <app-common/zap-generated/ids/Clusters.h>
#include <app-common/zap-generated/ids/Attributes.h>

static const char *TAG = "photosensitive_sensor";

using namespace esp_matter;
using namespace chip::app::Clusters;

static adc_oneshot_unit_handle_t s_adc_handle = nullptr;
static uint16_t s_endpoint_id = 0;

/*
 * Keep this the same as your old working app.
 * If your old ADC channel was different, change it here.
 */
static const adc_channel_t PHOTOSENSITIVE_ADC_CHANNEL = ADC_CHANNEL_4;

static float adc_raw_to_lux_estimate(int raw)
{
    /*
     * This is only a proof-of-concept mapping.
     * A photoresistor does not directly output lux.
     * Calibrate this later using real measured light levels.
     */
    float normalized = raw / 4095.0f;

    /*
     * If your readings work backwards, use:
     * normalized = 1.0f - normalized;
     */
    float lux = 1.0f + (normalized * 999.0f);

    return lux;
}

static uint16_t lux_to_matter_measured_value(float lux)
{
    /*
     * Matter Illuminance Measurement:
     * MeasuredValue = 10000 * log10(lux) + 1
     */
    if (lux <= 0.0f) {
        return 0;
    }

    float measured = (10000.0f * log10f(lux)) + 1.0f;

    if (measured < 1.0f) {
        return 1;
    }

    if (measured > 0xFFFE) {
        return 0xFFFE;
    }

    return (uint16_t)lroundf(measured);
}

static void update_matter_illuminance(uint16_t endpoint_id, uint16_t measured_value)
{
    /*
     * Schedule the update on the Matter/SystemLayer thread.
     * This follows the same pattern used by the ESP-Matter sensors example.
     */
    chip::DeviceLayer::SystemLayer().ScheduleLambda([endpoint_id, measured_value]() {
        attribute_t *attribute = attribute::get(
            endpoint_id,
            IlluminanceMeasurement::Id,
            IlluminanceMeasurement::Attributes::MeasuredValue::Id
        );

        if (!attribute) {
            ESP_LOGE(TAG, "Illuminance MeasuredValue attribute not found");
            return;
        }

        esp_matter_attr_val_t val = esp_matter_invalid(NULL);
        attribute::get_val(attribute, &val);

        val.val.u16 = measured_value;

        esp_err_t err = attribute::update(
            endpoint_id,
            IlluminanceMeasurement::Id,
            IlluminanceMeasurement::Attributes::MeasuredValue::Id,
            &val
        );

        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Matter attribute update failed: %s", esp_err_to_name(err));
        }
    });
}

static void photosensitive_sensor_task(void *arg)
{
    int raw = 0;

    while (true) {
        esp_err_t err = adc_oneshot_read(s_adc_handle, PHOTOSENSITIVE_ADC_CHANNEL, &raw);

        if (err == ESP_OK) {
            float lux = adc_raw_to_lux_estimate(raw);
            uint16_t measured_value = lux_to_matter_measured_value(lux);

            update_matter_illuminance(s_endpoint_id, measured_value);

            ESP_LOGI(TAG,
                     "ADC raw=%d, approx_lux=%.2f, matter_measured_value=%u",
                     raw,
                     lux,
                     measured_value);
        } else {
            ESP_LOGE(TAG, "ADC read failed: %s", esp_err_to_name(err));
        }

        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

esp_err_t photosensitive_sensor_init(uint16_t endpoint_id)
{
    s_endpoint_id = endpoint_id;

    adc_oneshot_unit_init_cfg_t init_config = {};
    init_config.unit_id = ADC_UNIT_1;

    esp_err_t err = adc_oneshot_new_unit(&init_config, &s_adc_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to create ADC unit: %s", esp_err_to_name(err));
        return err;
    }

    adc_oneshot_chan_cfg_t channel_config = {};
    channel_config.atten = ADC_ATTEN_DB_12;
    channel_config.bitwidth = ADC_BITWIDTH_DEFAULT;

    err = adc_oneshot_config_channel(s_adc_handle, PHOTOSENSITIVE_ADC_CHANNEL, &channel_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to configure ADC channel: %s", esp_err_to_name(err));
        return err;
    }

    BaseType_t task_created = xTaskCreate(
        photosensitive_sensor_task,
        "photo_sensor_task",
        4096,
        NULL,
        5,
        NULL
    );

    if (task_created != pdPASS) {
        ESP_LOGE(TAG, "Failed to create photosensitive sensor task");
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "Photosensitive sensor started on endpoint %u", s_endpoint_id);
    return ESP_OK;
}
