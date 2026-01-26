import { IDeviceData } from '@ha/IDeviceData';
import { safeId } from '@utils/safeId';

type Device = { friendlyName: string; name: string; address: number | string; ids?: string[] };

export const buildMQTTDeviceData = (
  { friendlyName, name, address, ids }: Device,
  manufacturer: string
): IDeviceData => {
  /**
   * Project memory:
   * Home Assistant "device" identity should be stable across reconnects and across
   * multiple equivalent identifiers (e.g. linked BLE controllers).
   *
   * Callers may provide `ids` to make this stable; otherwise we fall back to the address.
   */
  return {
    deviceTopic: `${safeId(manufacturer)}/${safeId(address.toString())}`,
    device: {
      ids: Array.isArray(ids) && ids.length ? ids : [`${address}`],
      name: friendlyName,
      mf: manufacturer,
      mdl: name,
    },
  };
};
