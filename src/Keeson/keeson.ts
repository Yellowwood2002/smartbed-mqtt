import { IMQTTConnection } from '@mqtt/IMQTTConnection';
import { buildDictionary } from '@utils/buildDictionary';
import { logError, logInfo, logWarn, logWarnDedup } from '@utils/logger';
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
  controllerBuilder: (deviceData: any, bleDevice: IBLEDevice, stayConnected?: boolean) => Promise<any>
): Promise<void> => {
  const { name, mac: _mac, address, connect, disconnect, getDeviceInfo } = bleDevice;
  const deviceData = buildMQTTDeviceData({ ...device, address }, 'Keeson');
  const stayConnected = device.stayConnected ?? false;

  // CRITICAL: Use try/finally to ensure cleanup happens even on errors
  try {
    await connect();

    const controller = await controllerBuilder(deviceData, bleDevice, stayConnected);
    if (!controller) {
      // Cleanup on failure - only disconnect if not staying connected
      if (!stayConnected) {
        await disconnect();
      }
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

    // Respect stayConnected flag - don't disconnect if it's true
    if (!stayConnected) {
      await disconnect();
    }

    // Success - device is connected and set up
    return;
  } catch (error: any) {
    // Ensure cleanup on any error - only disconnect if not staying connected
    if (!stayConnected) {
      try {
        await disconnect();
      } catch (_disconnectError) {
        // Ignore disconnect errors - device may already be disconnected
      }
    }
    
    // Re-throw the error so retry logic can handle it
    throw error;
  }
};

const setupDeviceWithRetry = async (
  mqtt: IMQTTConnection,
  _esphome: IESPConnection,
  initialBleDevice: IBLEDevice,
  device: any,
  controllerBuilder: (deviceData: any, bleDevice: IBLEDevice) => Promise<any>
): Promise<void> => {
  const { name, mac } = initialBleDevice;
  const bleDevice = initialBleDevice;
  
  // Use retryWithBackoff for centralized retry logic
  // Infinite retries (maxRetries = undefined) for persistent connection attempts
  await retryWithBackoff(
    async () => {
      // CRITICAL: Reuse the same device instance - don't refresh unnecessarily
      // Refreshing creates new BLEDevice instances which adds more listeners
      // The existing device instance can be reused for retries
      
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

  /**
   * Discovery backoff (project memory)
   *
   * Why:
   * - When the bed/controller is asleep or out of range, discovery often fails repeatedly.
   * - Throwing immediately caused a tight retry loop in the main setup, spamming logs.
   *
   * How:
   * - Keep retrying discovery *inside* Keeson setup with exponential backoff and rate-limited logs.
   * - This is safer for long-term operation and keeps HA logs readable.
   */
  const bleDevices = await retryWithBackoff(
    async () => {
      // Keeson/Purple controllers commonly advertise names with null padding; normalize it.
      const found = await esphome.getBLEDevices(deviceNames, (name) => name?.replace(/\0/g, ''));
      if (found.length === 0) throw new Error('No Keeson BLE devices discovered');
      return found;
    },
    {
      maxRetries: undefined, // Keep trying until the bed is awake / in range.
      initialDelayMs: 10_000,
      maxDelayMs: 120_000,
      backoffMultiplier: 1.5,
      // Discovery failures are effectively retryable; allow socket/BLE transient errors too.
      isRetryableError: () => true,
      onRetry: (_error: any, attempt: number, delayMs: number) => {
        const key = `keeson:discover:${deviceNames.sort().join(',')}`;
        logWarnDedup(
          key,
          60_000,
          `[Keeson] No BLE devices discovered for: ${deviceNames.join(', ')} (attempt ${attempt}, retry in ${Math.round(
            delayMs / 1000
          )}s)`
        );
      },
    }
  );
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
