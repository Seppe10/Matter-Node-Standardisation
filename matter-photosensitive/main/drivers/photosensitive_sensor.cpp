// -----------------------------------------------------------------------------
// Matter-over-Thread Photosensitive Sensor Driver for ESP32-H2
// -----------------------------------------------------------------------------
// Read a photoresistor/light-dependent resistor (LDR) using the ESP32-H2 ADC, estimates the surrounding light level in lux, converts that lux value into the Matter Illuminance Measurement format, and updates the Matter attribute so a smart home controller can read the light level
// Main functions of this code:
// 1. Read the photoresistor using the ESP32-H2 ADC
// 2. Average multiple ADC readings to reduce noise
// 3. Convert ADC readings into an estimated lux value
// 4. Convert lux into the Matter Illuminance Measurement value format
// 5. Update the Matter endpoint continuously from a FreeRTOS task
// -----------------------------------------------------------------------------

#include "photosensitive_sensor.h"

#include <math.h> // Used for colour conversion calculations such as powf(), logf(), and fmodf()

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_adc/adc_oneshot.h"    // ESP-IDF one-shot ADC driver
#include "esp_err.h"    // ESP-IDF error codes
#include "esp_log.h"    // ESP-IDF logging

#include <esp_matter.h> // ESP-Matter framework
#include <platform/CHIPDeviceLayer.h>
#include <app-common/zap-generated/ids/Clusters.h>
#include <app-common/zap-generated/ids/Attributes.h>

// Log tag used to identify messages from this file in the serial monitor
static const char *TAG = "photosensitive_sensor";

// These namespaces shorten access to Matter and ESP-Matter types
using namespace esp_matter;
using namespace chip::app::Clusters;

// ADC handle used by the ESP-IDF one-shot ADC driver
static adc_oneshot_unit_handle_t s_adc_handle = nullptr;

// Matter endpoint ID for the illuminance sensor endpoint
// This is provided by app_main when the sensor is initialised
static uint16_t s_endpoint_id = 0;

// -----------------------------------------------------------------------------
// ADC input configuration
// -----------------------------------------------------------------------------
// Selects the ESP32-H2 ADC channel the photoresistor voltage divider is connected to. The ADC channel must match the physical GPIO used in the wiring
// -----------------------------------------------------------------------------

static const adc_channel_t PHOTOSENSITIVE_ADC_CHANNEL = ADC_CHANNEL_3;

// ESP32-H2 ADC readings are usually in the range 0-4095 when using the default ADC bit width
static constexpr int ADC_RAW_MIN = 0;
static constexpr int ADC_RAW_MAX = 4095;

// Controls how the ADC value is interpreted
    // true  = brighter light gives a higher ADC reading.
    // false = brighter light gives a lower ADC reading.
static constexpr bool ADC_INCREASES_WITH_LIGHT = true;

// -----------------------------------------------------------------------------
// Calibration values
// -----------------------------------------------------------------------------
// These values map real ADC readings to real lux readings
// The code uses the ADC value and Lux points to estimate lux using a logarithmic model
// -----------------------------------------------------------------------------

static constexpr int   CAL_RAW_DIM    = 80;
static constexpr float CAL_LUX_DIM    = 120.0f;

static constexpr int   CAL_RAW_BRIGHT = 3000;
static constexpr float CAL_LUX_BRIGHT = 1000.0f;

// -----------------------------------------------------------------------------
// Helper functions
// -----------------------------------------------------------------------------

// Limits an integer value so it stays inside a valid range
static int clamp_int(int value, int min_value, int max_value)
{
    if (value < min_value) {
        return min_value;
    }

    if (value > max_value) {
        return max_value;
    }

    return value;
}

// Limits a floating-point value so it stays inside a valid range
static float clamp_float(float value, float min_value, float max_value)
{
    if (value < min_value) {
        return min_value;
    }

    if (value > max_value) {
        return max_value;
    }

    return value;
}

// Normalises the ADC direction so that higher corrected values always mean brighter light
static int correct_adc_direction(int raw)
{
    raw = clamp_int(raw, ADC_RAW_MIN, ADC_RAW_MAX);

    if (ADC_INCREASES_WITH_LIGHT) {
        return raw;
    }

    return ADC_RAW_MAX - raw;
}

// Reads the ADC multiple times and returns the average
static esp_err_t read_adc_average(int *average_raw)
{
    if (average_raw == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }

    int raw = 0;
    int valid_samples = 0;
    int total = 0;

    static constexpr int SAMPLE_COUNT    = 32;
    static constexpr int SAMPLE_DELAY_MS = 5;

    for (int i = 0; i < SAMPLE_COUNT; i++) {
        esp_err_t err = adc_oneshot_read(s_adc_handle, PHOTOSENSITIVE_ADC_CHANNEL, &raw);

        if (err == ESP_OK) {
            total += raw;
            valid_samples++;
        } else {
            ESP_LOGW(TAG, "ADC sample failed: %s", esp_err_to_name(err));
        }

        vTaskDelay(pdMS_TO_TICKS(SAMPLE_DELAY_MS));
    }

    if (valid_samples == 0) {
        return ESP_FAIL;
    }

    *average_raw = total / valid_samples;
    return ESP_OK;
}

// -----------------------------------------------------------------------------
// ADC-to-lux conversion
// -----------------------------------------------------------------------------
// A photoresistor is not linear. Doubling the light level does not simply double the ADC value. Because of this, the code estimates lux using a logarithmic power-law model based on two calibration points
// -----------------------------------------------------------------------------
static float adc_raw_to_lux_estimate(int raw)
{
    // Correct the ADC direction first so the model always treats higher values as brighter light
    int corrected_raw    = correct_adc_direction(raw);
    int corrected_dim    = correct_adc_direction(CAL_RAW_DIM);
    int corrected_bright = correct_adc_direction(CAL_RAW_BRIGHT);

    // Avoid log(0). Logarithmic calculations require values greater than zero
    corrected_raw    = clamp_int(corrected_raw,    1, ADC_RAW_MAX);
    corrected_dim    = clamp_int(corrected_dim,    1, ADC_RAW_MAX);
    corrected_bright = clamp_int(corrected_bright, 1, ADC_RAW_MAX);

    // Check that the calibration values are usable
    // If they are invalid, return a safe fallback value instead of producing an invalid number such as NaN or infinity
    if (corrected_dim == corrected_bright ||
        CAL_LUX_DIM    <= 0.0f           ||
        CAL_LUX_BRIGHT <= 0.0f) {
        ESP_LOGW(TAG, "Invalid calibration constants, using fallback lux value");
        return 1.0f;
    }

    // Convert the calibration values and current reading into natural-log space
    float ln_adc_dim    = logf((float)corrected_dim);
    float ln_adc_bright = logf((float)corrected_bright);
    float ln_lux_dim    = logf(CAL_LUX_DIM);
    float ln_lux_bright = logf(CAL_LUX_BRIGHT);
    float ln_adc_raw    = logf((float)corrected_raw);

    // Calculate the slope of the calibration curve in log space
    // This represents how strongly the sensor reading changes with light level
    float gamma = (ln_adc_dim - ln_adc_bright) /
                  (ln_lux_bright - ln_lux_dim);

    // Avoid division by zero if the calibration curve is unusable
    if (fabsf(gamma) < 1e-6f) {
        ESP_LOGW(TAG, "Degenerate gamma value, using fallback lux value");
        return 1.0f;
    }

    // Calculate the intercept of the calibration line in log space
    float ln_A = ln_adc_dim + gamma * ln_lux_dim;

    // Convert the current ADC reading into an estimated lux value
    float lux = expf((ln_A - ln_adc_raw) / gamma);

    // Keep the output inside a sensible practical range
    lux = clamp_float(lux, 1.0f, 10000.0f);

    return lux;
}

// -----------------------------------------------------------------------------
// Lux-to-Matter conversion
// -----------------------------------------------------------------------------
// The Matter Illuminance Measurement cluster does not store lux directly. Instead, it stores a logarithmic value:
// MeasuredValue = 10000 * log10(lux) + 1 -> Approximate examples:
// - 1 lux    -> 1
// - 10 lux   -> 10001
// - 100 lux  -> 20001
// -1000 lux  -> 30001
// -----------------------------------------------------------------------------
static uint16_t lux_to_matter_measured_value(float lux)
{
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

// Updates the Matter Illuminance Measurement attribute
static void update_matter_illuminance(uint16_t endpoint_id, uint16_t measured_value)
{
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

        // Read the existing attribute value first so the stored type stays aligned with the Matter attribute definition
        attribute::get_val(attribute, &val);

        // Update the uint16 Matter value with the latest measured illuminance
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

// -----------------------------------------------------------------------------
// Sensor task
// -----------------------------------------------------------------------------
// This FreeRTOS task runs continuously after initialisation
// Every cycle it:
// 1. Reads the ADC
// 2. Estimates lux
// 3. Converts lux to the Matter format
// 4. Updates the Matter sensor attribute
// 5. Logs the values for calibration and debugging
// -----------------------------------------------------------------------------

static void photosensitive_sensor_task(void *arg)
{
    int raw = 0;

    while (true) {
        esp_err_t err = read_adc_average(&raw);

        if (err == ESP_OK) {
            int corrected_raw = correct_adc_direction(raw);
            float lux = adc_raw_to_lux_estimate(raw);
            uint16_t measured_value = lux_to_matter_measured_value(lux);

            update_matter_illuminance(s_endpoint_id, measured_value);

            ESP_LOGI(TAG,
                     "ADC raw=%d, corrected_raw=%d, approx_lux=%.2f, matter_measured_value=%u",
                     raw,
                     corrected_raw,
                     lux,
                     measured_value);
        } else {
            ESP_LOGE(TAG, "ADC average read failed: %s", esp_err_to_name(err));
        }

        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

// -----------------------------------------------------------------------------
// Public initialisation function
// -----------------------------------------------------------------------------
// Called from app_main after the Matter illuminance endpoint has been created
// This function configures the ADC and starts the background sensor task
// -----------------------------------------------------------------------------
esp_err_t photosensitive_sensor_init(uint16_t endpoint_id)
{
    // Save the Matter endpoint ID so the background task knows which endpoint to update
    s_endpoint_id = endpoint_id;

    // Create ADC unit 1.
    adc_oneshot_unit_init_cfg_t init_config = {};
    init_config.unit_id = ADC_UNIT_1;

    esp_err_t err = adc_oneshot_new_unit(&init_config, &s_adc_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to create ADC unit: %s", esp_err_to_name(err));
        return err;
    }

    // Configure the ADC channel used by the photoresistor
    adc_oneshot_chan_cfg_t channel_config = {};
    channel_config.atten     = ADC_ATTEN_DB_12;
    channel_config.bitwidth  = ADC_BITWIDTH_DEFAULT;

    err = adc_oneshot_config_channel(s_adc_handle, PHOTOSENSITIVE_ADC_CHANNEL, &channel_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to configure ADC channel: %s", esp_err_to_name(err));
        return err;
    }

    // Start the FreeRTOS task that continuously reads the light sensor and updates the Matter attribute
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
    ESP_LOGI(TAG,
             "Calibration (log model): dim(raw=%d, lux=%.2f), bright(raw=%d, lux=%.2f), "
             "adc_increases_with_light=%s",
             CAL_RAW_DIM,
             CAL_LUX_DIM,
             CAL_RAW_BRIGHT,
             CAL_LUX_BRIGHT,
             ADC_INCREASES_WITH_LIGHT ? "true" : "false");

    return ESP_OK;
}