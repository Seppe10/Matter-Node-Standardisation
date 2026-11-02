idf_component_register(SRCS "rgb_led.cpp"
                       INCLUDE_DIRS "."
                       REQUIRES esp_driver_ledc esp_driver_gpio)
