idf_component_register(
    SRC_DIRS
        "."
        "drivers"
    INCLUDE_DIRS
        "."
        "drivers"
    PRIV_REQUIRES
        esp_adc
        nvs_flash
        esp_matter
        chip
)

target_compile_options(${COMPONENT_LIB} PRIVATE "-DCHIP_HAVE_CONFIG_H")
