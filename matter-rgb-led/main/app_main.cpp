// -----------------------------------------------------------------------------
// Matter-over-Thread RGB LED
// -----------------------------------------------------------------------------
// This program creates a Matter Extended Color Light device that can be commissioned into a smart home system. The ESP32-H2 controls a common-cathode RGB LED using PWM outputs for red, green, and blue
// Main functions of this code:
// 1. Configure PWM channels for the RGB LED pins
// 2. Convert Matter colour values into RGB values
// 3. Create a Matter colour-light endpoint
// 4. React to Matter commands such as on/off, brightness, hue, saturation, XY colour, and colour temperature
// 5. Enable Thread networking when Thread support is enabled in the project
// -----------------------------------------------------------------------------

#include <math.h>    // Used for colour conversion calculations such as powf(), logf(), and fmodf()
#include <stdint.h>  // Provides fixed-width integer types such as uint8_t and uint16_t

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "driver/ledc.h"    // ESP-IDF LEDC driver used for PWM output

#include "esp_err.h"    // ESP-IDF error handling types and helpers
#include "esp_log.h"    // ESP-IDF logging functions
#include "nvs_flash.h"  // Non-volatile storage used by Matter for commissioning data

#include <esp_matter.h> // ESP-Matter framework

#include <app/server/CommissioningWindowManager.h>
#include <app/server/Server.h>

// OpenThread header
#if CHIP_DEVICE_CONFIG_ENABLE_THREAD
#include <platform/ESP32/OpenthreadLauncher.h>
#include "esp_openthread.h"
#include "esp_openthread_types.h"
#include "esp_ot_config.h"
#endif

// These namespaces shorten access to Matter and ESP-Matter types
using namespace chip::DeviceLayer;
using namespace esp_matter;
using namespace esp_matter::attribute;
using namespace esp_matter::endpoint;
using namespace chip::app::Clusters;

// Log tag used to identify messages from this application in the serial monitor
static const char *TAG = "rgb_matter_light";

// -----------------------------------------------------------------------------
// RGB LED pin setup - for cathode RGB LED
// -----------------------------------------------------------------------------

#define RGB_RED_GPIO      4
#define RGB_GREEN_GPIO    10
#define RGB_BLUE_GPIO     5

// -----------------------------------------------------------------------------
// LEDC PWM setup
// -----------------------------------------------------------------------------

#define RGB_PWM_MODE       LEDC_LOW_SPEED_MODE
#define RGB_PWM_TIMER      LEDC_TIMER_0
#define RGB_PWM_FREQ_HZ    5000
#define RGB_PWM_RESOLUTION LEDC_TIMER_8_BIT

#define RGB_RED_CHANNEL    LEDC_CHANNEL_0
#define RGB_GREEN_CHANNEL  LEDC_CHANNEL_1
#define RGB_BLUE_CHANNEL   LEDC_CHANNEL_2

// -----------------------------------------------------------------------------
// Matter default values
// -----------------------------------------------------------------------------

#define DEFAULT_POWER       true
#define DEFAULT_BRIGHTNESS  300
#define DEFAULT_HUE         0
#define DEFAULT_SATURATION  254

// Stores the Matter endpoint ID after the light endpoint is created
static uint16_t light_endpoint_id = 0;

// Current logical light state.
static bool current_power = DEFAULT_POWER;
static uint8_t current_brightness = DEFAULT_BRIGHTNESS;
static uint8_t current_hue = DEFAULT_HUE;
static uint8_t current_saturation = DEFAULT_SATURATION;
static uint16_t current_x = 0;
static uint16_t current_y = 0;

// Current RGB value before brightness is applied.
static uint8_t current_red = 0;
static uint8_t current_green = 255;
static uint8_t current_blue = 0;

// -----------------------------------------------------------------------------
// RGB LEDC driver
// -----------------------------------------------------------------------------

// Configures one GPIO as a PWM output channel
static esp_err_t configure_pwm_channel(gpio_num_t gpio_num, ledc_channel_t channel)
{
    ledc_channel_config_t channel_config = {};
    channel_config.gpio_num = gpio_num;
    channel_config.speed_mode = RGB_PWM_MODE;
    channel_config.channel = channel;
    channel_config.intr_type = LEDC_INTR_DISABLE;
    channel_config.timer_sel = RGB_PWM_TIMER;
    channel_config.duty = 0;
    channel_config.hpoint = 0;

    return ledc_channel_config(&channel_config);
}

// Sets the PWM duty cycle for a specific colour channel
static esp_err_t set_pwm_channel(ledc_channel_t channel, uint8_t value)
{
    esp_err_t err = ledc_set_duty(RGB_PWM_MODE, channel, value);
    if (err != ESP_OK) {
        return err;
    }

    return ledc_update_duty(RGB_PWM_MODE, channel);
}

// Applies the current RGB state to the physical LED
static esp_err_t apply_rgb(void)
{
    uint8_t r = 0;
    uint8_t g = 0;
    uint8_t b = 0;

    if (current_power) {
        r = ((uint16_t)current_red * current_brightness) / 255;
        g = ((uint16_t)current_green * current_brightness) / 255;
        b = ((uint16_t)current_blue * current_brightness) / 255;
    }

    esp_err_t ret;

    ret = set_pwm_channel(RGB_RED_CHANNEL, r);
    if (ret != ESP_OK) {
        return ret;
    }

    ret = set_pwm_channel(RGB_GREEN_CHANNEL, g);
    if (ret != ESP_OK) {
        return ret;
    }

    ret = set_pwm_channel(RGB_BLUE_CHANNEL, b);
    if (ret != ESP_OK) {
        return ret;
    }

    ESP_LOGI(TAG,
             "Applied RGB: R=%u G=%u B=%u brightness=%u power=%s",
             r,
             g,
             b,
             current_brightness,
             current_power ? "ON" : "OFF");

    return ESP_OK;
}

// Initialises the LEDC timer and the three RGB PWM channels
static esp_err_t init_rgb_led(void)
{
    ledc_timer_config_t timer_config = {};
    timer_config.speed_mode = RGB_PWM_MODE;
    timer_config.duty_resolution = RGB_PWM_RESOLUTION;
    timer_config.timer_num = RGB_PWM_TIMER;
    timer_config.freq_hz = RGB_PWM_FREQ_HZ;
    timer_config.clk_cfg = LEDC_AUTO_CLK;

    esp_err_t err = ledc_timer_config(&timer_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to configure LEDC timer: %s", esp_err_to_name(err));
        return err;
    }

    err = configure_pwm_channel((gpio_num_t)RGB_RED_GPIO, RGB_RED_CHANNEL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to configure red channel: %s", esp_err_to_name(err));
        return err;
    }

    err = configure_pwm_channel((gpio_num_t)RGB_GREEN_GPIO, RGB_GREEN_CHANNEL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to configure green channel: %s", esp_err_to_name(err));
        return err;
    }

    err = configure_pwm_channel((gpio_num_t)RGB_BLUE_GPIO, RGB_BLUE_CHANNEL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to configure blue channel: %s", esp_err_to_name(err));
        return err;
    }

    ESP_LOGI(TAG,
             "RGB LED initialised on R=GPIO%d G=GPIO%d B=GPIO%d",
             RGB_RED_GPIO,
             RGB_GREEN_GPIO,
             RGB_BLUE_GPIO);

    return apply_rgb();
}

// -----------------------------------------------------------------------------
// Colour conversion helpers
// -----------------------------------------------------------------------------
// Matter controllers can send colour in different formats. These helper functions convert those Matter colour formats into red, green, and blue values that can be applied to the physical LED
// -----------------------------------------------------------------------------

// Converts brightness
static uint8_t matter_level_to_brightness(uint8_t matter_level)
{
    // Matter CurrentLevel is normally 0 to 254.
    // Our LED PWM brightness is 0 to 255.
    return (uint8_t)(((uint16_t)matter_level * 255) / 254);
}

// Converts a floating-point colour value into an 8-bit value (0-255)
static uint8_t clamp_float_to_u8(float value)
{
    if (value <= 0.0f) {
        return 0;
    }

    if (value >= 255.0f) {
        return 255;
    }

    return (uint8_t)(value + 0.5f);
}

// Applies gamma correction so the LED brightness appears more natural to our eyes
static float gamma_correct(float value)
{
    if (value <= 0.0f) {
        return 0.0f;
    }

    if (value >= 1.0f) {
        return 1.0f;
    }

    if (value <= 0.0031308f) {
        return 12.92f * value;
    }

    return (1.055f * powf(value, 1.0f / 2.4f)) - 0.055f;
}

static void hsv_to_rgb(uint8_t hue,
                       uint8_t saturation,
                       uint8_t value,
                       uint8_t *red,
                       uint8_t *green,
                       uint8_t *blue)
{

    float h = ((float)hue / 254.0f) * 360.0f;
    float s = (float)saturation / 254.0f;
    float v = (float)value / 255.0f;

    float c = v * s;
    float x = c * (1.0f - fabsf(fmodf(h / 60.0f, 2.0f) - 1.0f));
    float m = v - c;

    float r1 = 0.0f;
    float g1 = 0.0f;
    float b1 = 0.0f;

    if (h < 60.0f) {
        r1 = c;
        g1 = x;
        b1 = 0.0f;
    } else if (h < 120.0f) {
        r1 = x;
        g1 = c;
        b1 = 0.0f;
    } else if (h < 180.0f) {
        r1 = 0.0f;
        g1 = c;
        b1 = x;
    } else if (h < 240.0f) {
        r1 = 0.0f;
        g1 = x;
        b1 = c;
    } else if (h < 300.0f) {
        r1 = x;
        g1 = 0.0f;
        b1 = c;
    } else {
        r1 = c;
        g1 = 0.0f;
        b1 = x;
    }

    // Convert the calculated RGB values back to 0-255 and apply gamma correction
    *red   = clamp_float_to_u8(gamma_correct(r1 + m) * 255.0f);
    *green = clamp_float_to_u8(gamma_correct(g1 + m) * 255.0f);
    *blue  = clamp_float_to_u8(gamma_correct(b1 + m) * 255.0f);
}

// Converts Matter XY colour coordinates into RGB values
static void xy_to_rgb(uint16_t matter_x,
                      uint16_t matter_y,
                      uint8_t *red,
                      uint8_t *green,
                      uint8_t *blue)
{
    float x = (float)matter_x / 65535.0f;
    float y = (float)matter_y / 65535.0f;

    // Avoid division by zero if the controller sends an invalid Y value
    if (y <= 0.0f) {
        *red = 255;
        *green = 255;
        *blue = 255;
        return;
    }

    // Convert xy coordinates into XYZ colour space
    float Y = 1.0f;
    float X = (Y / y) * x;
    float Z = (Y / y) * (1.0f - x - y);

    // Convert XYZ colour space into linear RGB values
    float r = (X *  1.656492f) + (Y * -0.354851f) + (Z * -0.255038f);
    float g = (X * -0.707196f) + (Y *  1.655397f) + (Z *  0.036152f);
    float b = (X *  0.051713f) + (Y * -0.121364f) + (Z *  1.011530f);

    // Remove negative values because LED PWM cannot represent negative light
    if (r < 0.0f) {
        r = 0.0f;
    }

    if (g < 0.0f) {
        g = 0.0f;
    }

    if (b < 0.0f) {
        b = 0.0f;
    }

    float max_channel = r;

    if (g > max_channel) {
        max_channel = g;
    }

    if (b > max_channel) {
        max_channel = b;
    }

    if (max_channel > 1.0f) {
        r /= max_channel;
        g /= max_channel;
        b /= max_channel;
    }

    // Convert normalised RGB values to 8-bit PWM-compatible values
    *red   = clamp_float_to_u8(gamma_correct(r) * 255.0f);
    *green = clamp_float_to_u8(gamma_correct(g) * 255.0f);
    *blue  = clamp_float_to_u8(gamma_correct(b) * 255.0f);
}

// Converts colour temperature from mireds into RGB
// Lower mired values produce cooler/blue-white light, while higher mired values produce warmer/yellow-orange light
static void mireds_to_rgb(uint16_t mireds,
                          uint8_t *red,
                          uint8_t *green,
                          uint8_t *blue)
{

    // Clamp the value to a practical Matter colour temperature range
    if (mireds < 153) {
        mireds = 153;
    }

    if (mireds > 500) {
        mireds = 500;
    }

    // Convert mireds to Kelvin. mired = 1,000,000 / Kelvin
    float kelvin = 1000000.0f / (float)mireds;
    float kScaled = kelvin / 100.0f;

    float r, g, b;

    // Red channel
    if (kelvin <= 6600.0f) {
        r = 255.0f;
    } else {
        r = 329.698727446f * powf(kScaled - 60.0f, -0.1332047592f);
    }

    // Green channel
    if (kelvin <= 6600.0f) {
        g = 99.4708025861f * logf(kScaled) - 161.1195681661f;
    } else {
        g = 288.1221695283f * powf(kScaled - 60.0f, -0.0755148492f);
    }

    // Blue channel
    if (kelvin >= 6600.0f) {
        b = 255.0f;
    } else if (kelvin <= 1900.0f) {
        b = 0.0f;
    } else {
        b = 138.5177312231f * logf(kScaled - 10.0f) - 305.0447927307f;
    }

    *red   = clamp_float_to_u8(r);
    *green = clamp_float_to_u8(g);
    *blue  = clamp_float_to_u8(b);
}

// Updates the stored HSV colour, converts it to RGB, then applies it to the LED
static esp_err_t set_hsv(uint8_t hue, uint8_t saturation)
{
    current_hue = hue;
    current_saturation = saturation;

    hsv_to_rgb(current_hue,
               current_saturation,
               255,
               &current_red,
               &current_green,
               &current_blue);

    ESP_LOGI(TAG,
             "HSV set to H=%u S=%u -> RGB(%u, %u, %u)",
             current_hue,
             current_saturation,
             current_red,
             current_green,
             current_blue);

    return apply_rgb();
}

// Updates the stored XY colour, converts it to RGB, then applies it to the LED
static esp_err_t set_xy(uint16_t x, uint16_t y)
{
    current_x = x;
    current_y = y;

    xy_to_rgb(current_x,
              current_y,
              &current_red,
              &current_green,
              &current_blue);

    ESP_LOGI(TAG,
             "XY set to X=%u Y=%u -> RGB(%u, %u, %u)",
             current_x,
             current_y,
             current_red,
             current_green,
             current_blue);

    return apply_rgb();
}

// Updates the colour using a Matter colour-temperature value
static esp_err_t set_color_temperature(uint16_t mireds)
{
    mireds_to_rgb(mireds,
                  &current_red,
                  &current_green,
                  &current_blue);

    ESP_LOGI(TAG,
             "Colour temperature set to %u mireds -> RGB(%u, %u, %u)",
             mireds,
             current_red,
             current_green,
             current_blue);

    return apply_rgb();
}

// -----------------------------------------------------------------------------
// Matter callbacks
// -----------------------------------------------------------------------------
// Matter calls these functions when commissioning events happen, when the device is identified, or when a controller updates a Matter attribute
// -----------------------------------------------------------------------------

// Handles general Matter device events and prints useful status messages
static void app_event_cb(const ChipDeviceEvent *event, intptr_t arg)
{
    switch (event->Type) {
        case chip::DeviceLayer::DeviceEventType::kCommissioningComplete:
            ESP_LOGI(TAG, "Commissioning complete");
            break;

        case chip::DeviceLayer::DeviceEventType::kCommissioningSessionStarted:
            ESP_LOGI(TAG, "Commissioning session started");
            break;

        case chip::DeviceLayer::DeviceEventType::kCommissioningSessionStopped:
            ESP_LOGI(TAG, "Commissioning session stopped");
            break;

        case chip::DeviceLayer::DeviceEventType::kCommissioningWindowOpened:
            ESP_LOGI(TAG, "Commissioning window opened");
            break;

        case chip::DeviceLayer::DeviceEventType::kCommissioningWindowClosed:
            ESP_LOGI(TAG, "Commissioning window closed");
            break;

        case chip::DeviceLayer::DeviceEventType::kFabricRemoved:
            ESP_LOGI(TAG, "Fabric removed");
            break;

        default:
            break;
    }
}

// Handles Matter Identify commands
// Identify is normally used by smart home apps to help the user confirm which physical device they are controlling
static esp_err_t app_identification_cb(identification::callback_type_t type,
                                       uint16_t endpoint_id,
                                       uint8_t effect_id,
                                       uint8_t effect_variant,
                                       void *priv_data)
{
    ESP_LOGI(TAG,
             "Identify callback: endpoint=%u effect=%u variant=%u",
             endpoint_id,
             effect_id,
             effect_variant);

    return ESP_OK;
}

// Matter commands are translated into physical LED behaviour
static esp_err_t app_attribute_update_cb(attribute::callback_type_t type,
                                         uint16_t endpoint_id,
                                         uint32_t cluster_id,
                                         uint32_t attribute_id,
                                         esp_matter_attr_val_t *val,
                                         void *priv_data)
{
    if (type != PRE_UPDATE) {
        return ESP_OK;
    }

    if (endpoint_id != light_endpoint_id) {
        return ESP_OK;
    }

    if (cluster_id == OnOff::Id) {
        if (attribute_id == OnOff::Attributes::OnOff::Id) {
            current_power = val->val.b;
            ESP_LOGI(TAG, "Matter power: %s", current_power ? "ON" : "OFF");
            return apply_rgb();
        }
    }

    else if (cluster_id == LevelControl::Id) {
        if (attribute_id == LevelControl::Attributes::CurrentLevel::Id) {
            current_brightness = matter_level_to_brightness(val->val.u8);
            ESP_LOGI(TAG, "Matter brightness: %u", current_brightness);
            return apply_rgb();
        }
    }

    // Handle colour commands
    else if (cluster_id == ColorControl::Id) {
        if (attribute_id == ColorControl::Attributes::CurrentHue::Id) {
            return set_hsv(val->val.u8, current_saturation);
        }

        else if (attribute_id == ColorControl::Attributes::CurrentSaturation::Id) {
            return set_hsv(current_hue, val->val.u8);
        }

        else if (attribute_id == ColorControl::Attributes::CurrentX::Id) {
            return set_xy(val->val.u16, current_y);
        }

        else if (attribute_id == ColorControl::Attributes::CurrentY::Id) {
            return set_xy(current_x, val->val.u16);
        }

        else if (attribute_id == ColorControl::Attributes::ColorTemperatureMireds::Id) {
            return set_color_temperature(val->val.u16);
        }
    }

    return ESP_OK;
}

// -----------------------------------------------------------------------------
// app_main
// -----------------------------------------------------------------------------
// Entry point for the ESP-IDF application. This function initialises storage, configures the RGB LED, creates the Matter device, enables Thread support
// -----------------------------------------------------------------------------

extern "C" void app_main(void)
{
    // -------------------------------------------------------------------------
    // Initialise NVS
    // -------------------------------------------------------------------------
    // NVS stores Matter commissioning data, including fabric information
    // Without NVS, the device would not remember its commissioned smart home
    // -------------------------------------------------------------------------
    esp_err_t err = ESP_OK;
    err = nvs_flash_init();

    // If the NVS partition is full or from an incompatible version, erase it and initialise it again
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    ESP_ERROR_CHECK(init_rgb_led());

    // -------------------------------------------------------------------------
    // Create Matter node
    // -------------------------------------------------------------------------
    // The Matter node represents the physical device. Endpoints are added to this node to describe the device features
    // -------------------------------------------------------------------------
    node::config_t node_config;

    node_t *node = node::create(&node_config,
                                app_attribute_update_cb,
                                app_identification_cb);

    if (node == nullptr) {
        ESP_LOGE(TAG, "Failed to create Matter node");
        return;
    }

    // Create Matter Extended Color Light endpoint
    extended_color_light::config_t light_config;

    light_config.on_off.on_off = DEFAULT_POWER;
    light_config.on_off_lighting.start_up_on_off = nullptr;

    light_config.level_control.current_level = DEFAULT_BRIGHTNESS;
    light_config.level_control.on_level = DEFAULT_BRIGHTNESS;
    light_config.level_control_lighting.start_up_current_level = DEFAULT_BRIGHTNESS;

    light_config.color_control.color_mode =
        (uint8_t)ColorControl::ColorMode::kCurrentHueAndCurrentSaturation;

    light_config.color_control.enhanced_color_mode =
        (uint8_t)ColorControl::ColorMode::kCurrentHueAndCurrentSaturation;

    light_config.color_control_color_temperature.start_up_color_temperature_mireds = nullptr;

    endpoint_t *endpoint = extended_color_light::create(node,
                                                        &light_config,
                                                        ENDPOINT_FLAG_NONE,
                                                        nullptr);

    if (endpoint == nullptr) {
        ESP_LOGE(TAG, "Failed to create Extended Color Light endpoint");
        return;
    }

    // -------------------------------------------------------------------------
    // Create Matter RGB LED Actuator endpoint
    // -------------------------------------------------------------------------
    // The RGB LED endpoint exposes the Hue value cluster to the smart home controller
    // -------------------------------------------------------------------------
    light_endpoint_id = endpoint::get_id(endpoint);

    // Add Hue/Saturation colour support to the Color Control cluster
    // This is what allows phone apps to expose a colour wheel instead of only colour temperature control
    cluster_t *color_control_cluster = cluster::get(endpoint, ColorControl::Id);

    if (color_control_cluster == nullptr) {
        ESP_LOGE(TAG, "Failed to get Color Control cluster");
        return;
    }

    cluster::color_control::feature::hue_saturation::config_t hue_saturation_config;
    hue_saturation_config.current_hue = DEFAULT_HUE;
    hue_saturation_config.current_saturation = DEFAULT_SATURATION;

    esp_err_t hue_sat_err =
        cluster::color_control::feature::hue_saturation::add(color_control_cluster,
                                                         &hue_saturation_config);

    if (hue_sat_err != ESP_OK) {
        ESP_LOGE(TAG,
                "Failed to add Hue/Saturation feature: %s",
                esp_err_to_name(hue_sat_err));
        return;
    }

    ESP_LOGI(TAG,
            "Matter Extended Color Light created on endpoint %u",
            light_endpoint_id);

// -------------------------------------------------------------------------
// Configure Thread networking when enabled
// -------------------------------------------------------------------------
// The ESP32-H2 supports Matter-over-Thread. If Thread support is enabled in the project configuration, this section sets up the OpenThread radio, host, and port configuration before Matter is started.
// -------------------------------------------------------------------------
#if CHIP_DEVICE_CONFIG_ENABLE_THREAD
    esp_openthread_platform_config_t thread_config = {
        .radio_config = ESP_OPENTHREAD_DEFAULT_RADIO_CONFIG(),
        .host_config = ESP_OPENTHREAD_DEFAULT_HOST_CONFIG(),
        .port_config = ESP_OPENTHREAD_DEFAULT_PORT_CONFIG(),
    };

    set_openthread_platform_config(&thread_config);
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

    // Apply startup colour
    current_power = DEFAULT_POWER;
    current_brightness = DEFAULT_BRIGHTNESS;
    set_hsv(DEFAULT_HUE, DEFAULT_SATURATION);

    ESP_LOGI(TAG, "Matter RGB light started");

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}
