#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_adc/adc_oneshot.h"

void app_main(void)
{
    adc_oneshot_unit_handle_t adc_handle;

    adc_oneshot_unit_init_cfg_t init_config = {
        .unit_id = ADC_UNIT_1,
    };
    adc_oneshot_new_unit(&init_config, &adc_handle);

    adc_oneshot_chan_cfg_t config = {
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };

    // GPIO 4 uses Channel 3 on the ESP32-H2
    adc_channel_t channel = ADC_CHANNEL_3;

    adc_oneshot_config_channel(adc_handle, channel, &config);

    int val = 0;

    while (1)
    {
        adc_oneshot_read(adc_handle, channel, &val);

        printf("Light level: %d\n", val);

        vTaskDelay(pdMS_TO_TICKS(500));
    }
}