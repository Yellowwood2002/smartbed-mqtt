import { IMQTTConnection } from '@mqtt/IMQTTConnection';
import { buildDictionary } from '@utils/buildDictionary';
import { logError, logInfo, logWarn } from '@utils/logger';
import { wait } from '@utils/wait';
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

const RETRY_DELAY_MS = 5000; // 5 seconds

const connectToDevice = async (
  mqtt: IMQTTConnection,
  bleDevice: IBLEDevice,
  device: any,
  controllerBuilder: (deviceData: any, bleDevice: IBLEDevice) => Promise<any>
): Promise<boolean> => {
  const { name, mac, address, connect, disconnect, getDeviceInfo } = bleDevice;
  const deviceData = buildMQTTDeviceData({ ...device, address }, 'Keeson');

  try {
    await connect();

    const controller = await controllerBuilder(deviceData, bleDevice);
    if (!controller) {
      await disconnect();
      return false;
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

    return true;
  } catch (error: any) {
    const errorMessage = error?.message || String(error);
    const isTimeout = errorMessage.includes('timeout') || 
                     errorMessage.includes('BluetoothGATTGetServicesDoneResponse') ||
                     errorMessage.includes('BluetoothDeviceConnectionResponse');
    
    if (isTimeout) {
      logWarn(`[Keeson] BLE timeout for device ${name} (${mac}), will retry in ${RETRY_DELAY_MS / 1000}s:`, errorMessage);
    } else {
      logWarn(`[Keeson] Connection error for device ${name} (${mac}), will retry in ${RETRY_DELAY_MS / 1000}s:`, errorMessage);
    }

    try {
      await disconnect();
    } catch (disconnectError) {
      // Ignore disconnect errors
    }

    return false;
  }
};

const setupDeviceWithRetry = async (
  mqtt: IMQTTConnection,
  esphome: IESPConnection,
  bleDevice: IBLEDevice,
  device: any,
  controllerBuilder: (deviceData: any, bleDevice: IBLEDevice) => Promise<any>
): Promise<void> => {
  const { name, mac } = bleDevice;
  
  // Retry loop - runs forever until successful
  while (true) {
    const success = await connectToDevice(mqtt, bleDevice, device, controllerBuilder);
    
    if (success) {
      logInfo(`[Keeson] Successfully connected to device ${name} (${mac})`);
      return; // Success, exit retry loop
    }

    // Wait before retrying
    logInfo(`[Keeson] Waiting ${RETRY_DELAY_MS / 1000}s before retrying connection to ${name} (${mac})...`);
    await wait(RETRY_DELAY_MS);
    
    // Re-fetch the device in case it was lost
    try {
      const refreshedDevices = await esphome.getBLEDevices([device.name.toLowerCase()]);
      if (refreshedDevices.length > 0) {
        // Update the bleDevice reference if we got a fresh one
        Object.assign(bleDevice, refreshedDevices[0]);
      }
    } catch (error) {
      // Ignore errors refreshing device list, will retry with existing device
    }
  }
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
