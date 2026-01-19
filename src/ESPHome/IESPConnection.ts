import { IBLEDevice } from './types/IBLEDevice';
import { BLEAdvertisement } from './types/BLEAdvertisement';
import { Connection } from '@2colors/esphome-native-api';

export type DiscoveredBLEAdvertisement = {
  name: string;
  mac: string;
  address: number;
  advertisement: BLEAdvertisement;
  connection: Connection;
};

export interface IESPConnection {
  disconnect(): void;
  reconnect(): Promise<void>;
  getBLEDevices(deviceNames: string[], nameMapper?: (name: string) => string): Promise<IBLEDevice[]>;
  discoverBLEDevices(
    onNewDeviceFound: (device: DiscoveredBLEAdvertisement) => void,
    complete: Promise<void>,
    nameMapper?: (name: string) => string
  ): Promise<void>;
}
