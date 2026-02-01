#!/usr/bin/env bashio

# Project memory (forensics):
# Home Assistant Supervisor shows add-on logs, but crash-looping containers can make it hard
# to capture the first exception/stack trace. Persist a rolling log file in /data so we can
# retrieve the exact failure that caused a restart, even after the container exits.
#
# Notes:
# - /data is the add-on data directory (persisted by Supervisor).
# - We keep logging to stdout/stderr (Supervisor UI) AND tee to /data.
# - We preserve Node's exit code so Supervisor can still detect failures correctly.
# Primary persisted log location (Supervisor add-on data directory)
LOG_FILE="/data/smartbedmqtt.log"
# Optional secondary location: write a copy into /config so it can be retrieved via the HA File Editor
# and via your mapped `/Volumes/config` without needing to query Supervisor for logs.
LOG_FILE_CONFIG="/config/smartbedmqtt-addon.log"
MAX_LOG_BYTES=$((5 * 1024 * 1024)) # 5 MiB

rotate_log() {
    local file="$1"
    if [ -f "${file}" ]; then
        local size
        size="$(stat -c %s "${file}" 2>/dev/null || wc -c < "${file}" 2>/dev/null || echo 0)"
        if [ "${size}" -gt "${MAX_LOG_BYTES}" ]; then
            rm -f "${file}.2" 2>/dev/null || true
            mv -f "${file}.1" "${file}.2" 2>/dev/null || true
            mv -f "${file}" "${file}.1" 2>/dev/null || true
        fi
    fi
}

rotate_log "${LOG_FILE}"
if touch "${LOG_FILE_CONFIG}" 2>/dev/null; then
    rotate_log "${LOG_FILE_CONFIG}"
    LOG_TEE_TARGETS=("${LOG_FILE}" "${LOG_FILE_CONFIG}")
else
    LOG_TEE_TARGETS=("${LOG_FILE}")
fi

echo "=== SmartbedMQTT start $(date -u +"%Y-%m-%dT%H:%M:%SZ") ===" | tee -a "${LOG_TEE_TARGETS[@]}"

export MQTTHOST=$(bashio::config "mqtt_host")
export MQTTPORT=$(bashio::config "mqtt_port")
export MQTTUSER=$(bashio::config "mqtt_user")
export MQTTPASSWORD=$(bashio::config "mqtt_password")

if [ $MQTTHOST = '<auto_detect>' ]; then
    if bashio::services.available 'mqtt'; then
        MQTTHOST=$(bashio::services mqtt "host")
	if [ $MQTTHOST = 'localhost' ] || [ $MQTTHOST = '127.0.0.1' ]; then
	    echo "Discovered invalid value for MQTT host: ${MQTTHOST}"
	    echo "Overriding with default alias for Mosquitto MQTT addon"
	    MQTTHOST="core-mosquitto"
	fi
        echo "Using discovered MQTT Host: ${MQTTHOST}"
    else
    	echo "No Home Assistant MQTT service found, using defaults"
        MQTTHOST="172.30.32.1"
        echo "Using default MQTT Host: ${MQTTHOST}"
    fi
else
    echo "Using configured MQTT Host: ${MQTTHOST}"
fi

if [ $MQTTPORT = '<auto_detect>' ]; then
    if bashio::services.available 'mqtt'; then
        MQTTPORT=$(bashio::services mqtt "port")
        echo "Using discovered MQTT Port: ${MQTTPORT}"
    else
        MQTTPORT="1883"
        echo "Using default MQTT Port: ${MQTTPORT}"
    fi
else
    echo "Using configured MQTT Port: ${MQTTPORT}"
fi

if [ $MQTTUSER = '<auto_detect>' ]; then
    if bashio::services.available 'mqtt'; then
        MQTTUSER=$(bashio::services mqtt "username")
        echo "Using discovered MQTT User: ${MQTTUSER}"
    else
        MQTTUSER=""
        echo "Using anonymous MQTT connection"
    fi
else
    echo "Using configured MQTT User: ${MQTTUSER}"
fi

if [ $MQTTPASSWORD = '<auto_detect>' ]; then
    if bashio::services.available 'mqtt'; then
        MQTTPASSWORD=$(bashio::services mqtt "password")
        echo "Using discovered MQTT password: <hidden>"
    else
        MQTTPASSWORD=""
    fi
else
    echo "Using configured MQTT password: <hidden>"
fi

set -o pipefail
node index.js 2>&1 | tee -a "${LOG_TEE_TARGETS[@]}"
exit "${PIPESTATUS[0]}"
