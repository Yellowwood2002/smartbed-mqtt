import { getRootOptions } from '@utils/options';

export interface KeesonDevice {
  friendlyName: string;
  name: string;
  stayConnected?: boolean;
  /**
   * Optional additional identifiers for the same physical bed/controller.
   *
   * Why:
   * - Some Keeson/Purple setups expose two BLE MACs that can both control the same bed (linked controllers).
   * - Adding two separate `keesonDevices` entries would create duplicate Home Assistant entities
   *   because entity `unique_id` is based on `friendlyName` (device name), not the BLE address.
   *
   * How:
   * - Provide a comma/space separated list of identifiers (MACs with or without colons, or advertised names).
   * - The runtime will normalize these into match keys during BLE discovery so either identifier can be used.
   *
   * Example:
   * - name: "D2:A3:3C:41:A0:72"
   *   aliases: "F0:1D:DF:BB:16:DE"
   */
  aliases?: string;
}

interface OptionsJson {
  keesonDevices: KeesonDevice[];
}

const options: OptionsJson = getRootOptions();

export const getDevices = () => {
  const devices = options.keesonDevices;
  if (Array.isArray(devices)) {
    return devices;
  }
  return [];
};
