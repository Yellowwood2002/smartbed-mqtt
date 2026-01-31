# Testing Guide for smartbed-mqtt-fork

This document provides instructions on how to test the `smartbed-mqtt-fork` addon and the resilient BLE proxy.

## 1. Project Overview

This project is a fork of `smartbed-mqtt` that adds a more advanced, cooperative self-healing mechanism between the `smartbed-mqtt` add-on and the ESPHome BLE proxy.

The goal is to improve the resilience of the system and reduce the need for hard reboots of the BLE proxy.

## 2. Testing Environment Setup

To test the new changes, you will need the following:

*   A Home Assistant instance with the ESPHome add-on.
*   An M5Stack Atom Lite (or a similar ESP32 device) to act as the BLE proxy.
*   An MQTT broker.
*   A smart bed that is compatible with this add-on.

## 3. Testing the Resilient BLE Proxy

### 3.1. Flashing the Firmware

**Important:** You do not upload the YAML file to the esphome.io website. You must use the ESPHome dashboard, which is an add-on inside your Home Assistant.

1.  **Open Home Assistant.**
2.  Go to **Settings** > **Add-ons**.
3.  Open the **ESPHome** add-on. If you don't have it installed, you'll need to install it from the add-on store.
4.  Inside the ESPHome dashboard, click the **"+ NEW DEVICE"** button in the bottom right.
5.  A dialog will appear. Click on the three dots in the top right and select **"Manually create a new device"**.
6.  Give your device a name (e.g., `smartbed-proxy`).
7.  In the next step, you will be presented with a text editor. **Delete the default content and paste the content of the `m5stack-atom-lite-resilient.yaml` file.**
8.  **Customize the following fields in the YAML:**
    *   `mqtt.broker`: The IP address or hostname of your MQTT broker.
    *   `mqtt.username`: Your MQTT username.
    *   `mqtt.password`: Your MQTT password.
    *   `wifi.ssid`: Your Wi-Fi network SSID.
    *   `wifi.password`: Your Wi-Fi network password.
9.  Click **"SAVE"**.
10. Click **"INSTALL"**. You will be given the option to install wirelessly (OTA) or by connecting the device via USB. If this is the first time you are flashing the device, you will need to connect it via USB.

### 3.2. Configuring the Add-on

1.  Install the `smartbed-mqtt-fork` add-on in Home Assistant.
2.  Configure the add-on with your bed's details.
3.  **Ensure that the `bleProxies` configuration in your `config.json` matches the `host` of your M5Stack Atom Lite.**

### 3.3. Testing the Self-Healing Mechanism

1.  **Start the `smartbed-mqtt` add-on.**
2.  **Monitor the MQTT messages.** You can use a tool like MQTT Explorer to subscribe to the `smartbed-mqtt/proxy/#` and `smartbed-mqtt/health` topics.
3.  You should see status messages from the proxy on the `smartbed-mqtt/proxy/<proxy_name>/status` topic.
4.  **Simulate a BLE failure.** You can do this by unplugging the power supply of your smart bed.
5.  **Observe the behavior.**
    *   The `smartbed-mqtt` add-on should detect the BLE failure and record it in the `HealthMonitor`.
    *   After a few consecutive failures, the `HealthMonitor` should request a reboot of the BLE proxy by publishing a `REBOOT` command to the `smartbed-mqtt/proxy/<proxy_name>/command` topic.
    *   The ESPHome proxy should receive the `REBOOT` command and gracefully reboot.
    *   The proxy should then come back online and re-establish the connection.
    *   The `smartbed-mqtt` add-on should then be able to reconnect to the bed.

## 4. Testing the `smartbed-mqtt` Addon

1.  Configure the add-on for your specific bed type.
2.  Verify that all the entities (covers, buttons, sensors) for your bed are created in Home Assistant.
3.  Test each entity to ensure that it is working correctly.
4.  Check the Home Assistant logs and the add-on logs for any errors.
