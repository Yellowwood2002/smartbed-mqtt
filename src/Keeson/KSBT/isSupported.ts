import { IBLEDevice } from 'ESPHome/types/IBLEDevice';

export const isSupported = ({ name }: IBLEDevice) => {
  // Trust the device name match for KSBT devices, even if advertisement data (manufacturerDataList, serviceUuidsList) is empty
  // This avoids dropping devices when advertisement packets are incomplete
  return name?.startsWith('KSBT') ?? false;
};
