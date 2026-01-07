import { IMQTTConnection } from '@mqtt/IMQTTConnection';
import { buildDictionary } from '@utils/buildDictionary';
import { logError, logInfo, logWarn } from '@utils/logger';
import { retryWithBackoff, isSocketOrBLETimeoutError } from '@utils/retryWithBackoff';
import { setupDeviceInfoSensor } from 'BLE/setupDeviceInfoSensor';
import { buildMQTTDeviceData } from 'Common/buildMQTTDeviceData';
import { IESPConnection } from 'ESPHome/IESPConnection';
import { IBLEDevice } from 'ESPHome/types/IBLEDevice';
import { getDevices } from './options';
import { setupMassageButtons } from './setupMassageButtons';
import { setupPresetButtons } from './setupPresetButtons';
import { setupMotorEntities } from './setupMotorEntities';
import { isSupported as isKSBTSupported } from './KSBT/isSupported';
import { controllerBuilder as ksbtControllerBuilder } from './KSBT/controllerBuilder';
import { isSupported as isBaseI5Supported } from './BaseI5/isSupported';
import { controllerBuilder as baseI5ControllerBuilder } from './BaseI5/controllerBuilder';
import { isSupported as isBaseI4Supported } from './BaseI4/isSupported';
import { controllerBuilder as baseI4ControllerBuilder } from './BaseI4/controllerBuilder';

const checks = [isKSBTSupported, isBaseI5Supported, isBaseI4Supported];
const controllerBuilders = [ksbtControllerBuilder, baseI5ControllerBuilder, baseI4ControllerBuilder];

const connectToDevice = async (
  mqtt: IMQTTConnection,
  bleDevice: IBLEDevice,
  device: any,
  controllerBuilder: (deviceData: any, bleDevice: IBLEDevice) => Promise<any>
): Promise<void> => {
  const { name, mac: _mac, address, connect, disconnect, getDeviceInfo } = bleDevice;
  const deviceData = buildMQTTDeviceData({ ...device, address }, 'Keeson');

  // CRITICAL: Use try/finally to ensure cleanup happens even on errors
  try {
    await connect();

    const controller = await controllerBuilder(deviceData, bleDevice);
    if (!controller) {
      // Cleanup on failure
      await disconnect();
      throw new Error(`Failed to build controller for device ${name}`);
    }

    logInfo('[Keeson] Setting up entities for device:', name);
    setupPresetButtons(mqtt, controller);
    setupMassageButtons(mqtt, controller);
    setupMotorEntities(mqtt, controller);

    try {
      const deviceInfo = await getDeviceInfo();
      if (deviceInfo) setupDeviceInfoSensor(mqtt, controller, deviceInfo);
    } catch (error: any) {
      logWarn(`[Keeson] Failed to get device info for ${name}, continuing anyway:`, error?.message || error);
    }

    // Success - device is connected and set up
    return;
  } catch (error: any) {
    // Ensure cleanup on any error
    try {
      await disconnect();
    } catch (disconnectError) {
      // Ignore disconnect errors - device may already be disconnected
    }
    
    // Re-throw the error so retry logic can handle it
    throw error;
  }
};

const setupDeviceWithRetry = async (
  mqtt: IMQTTConnection,
  esphome: IESPConnection,
  initialBleDevice: IBLEDevice,
  device: any,
  controllerBuilder: (deviceData: any, bleDevice: IBLEDevice) => Promise<any>
): Promise<void> => {
  const { name, mac } = initialBleDevice;
  let bleDevice = initialBleDevice;
  
  // Use retryWithBackoff for centralized retry logic
  // Infinite retries (maxRetries = undefined) for persistent connection attempts
  await retryWithBackoff(
    async () => {
      // CRITICAL: Clean up any old device instances before attempting connection
      // This prevents listener accumulation
      try {
        // Try to refresh device list, but don't fail if it doesn't work
        const refreshedDevices = await esphome.getBLEDevices([device.name.toLowerCase()]);
        if (refreshedDevices.length > 0) {
          // If we got a fresh device, the old one will be cleaned up by the registry
          // in the BLEDevice constructor, so we can safely use the new one
          bleDevice = refreshedDevices[0];
        }
      } catch (error) {
        // If refresh fails, continue with existing device
        // The cleanup in connectToDevice's finally block will handle disconnection
      }
      
      // Attempt connection - this will throw on failure, triggering retry
      await connectToDevice(mqtt, bleDevice, device, controllerBuilder);
      
      // Success - log and return
      logInfo(`[Keeson] Successfully connected to device ${name} (${mac})`);
    },
    {
      maxRetries: undefined, // Infinite retries
      initialDelayMs: 5000, // 5 seconds initial delay
      maxDelayMs: 30000, // Max 30 seconds between retries
      backoffMultiplier: 1.5, // Gradual backoff
      isRetryableError: isSocketOrBLETimeoutError,
      onRetry: (error: any, attempt: number, delayMs: number) => {
        const errorMessage = error?.message || String(error);
        logWarn(
          `[Keeson] Connection attempt ${attempt} failed for device ${name} (${mac}), retrying in ${delayMs / 1000}s:`,
          errorMessage
        );
      },
    }
  );
};

export const keeson = async (mqtt: IMQTTConnection, esphome: IESPConnection): Promise<void> => {
  const devices = getDevices();
  if (!devices.length) return logInfo('[Keeson] No devices configured');

  const devicesMap = buildDictionary(devices, (device) => ({ key: device.name.toLowerCase(), value: device }));
  const deviceNames = Object.keys(devicesMap);

  if (deviceNames.length !== devices.length) return logError('[Keeson] Duplicate name detected in configuration');

  const bleDevices = await esphome.getBLEDevices(deviceNames);
  const setupPromises: Promise<void>[] = [];

  for (const bleDevice of bleDevices) {
    const { name, mac } = bleDevice;
    const device = devicesMap[mac] || devicesMap[name.toLowerCase()];

    if (!device) {
      logInfo(`[Keeson] Device not found in configuration for MAC: ${mac} or Name: ${name}`);
      continue;
    }
    
    const controllerBuilder = checks
      .map((check, index) => (check(bleDevice) ? controllerBuilders[index] : undefined))
      .filter((check) => check)[0];
      
    if (controllerBuilder === undefined) {
      const {
        advertisement: { manufacturerDataList, serviceUuidsList },
      } = bleDevice;
      logWarn(
        '[Keeson] Device not supported, please contact me on Discord',
        name,
        JSON.stringify({ name, address: bleDevice.address, manufacturerDataList, serviceUuidsList })
      );
      continue;
    }

    // Setup each device in parallel with retry logic
    setupPromises.push(setupDeviceWithRetry(mqtt, esphome, bleDevice, device, controllerBuilder));
  }

  // Wait for all devices to be set up (they will retry forever if needed)
  await Promise.all(setupPromises);
};
