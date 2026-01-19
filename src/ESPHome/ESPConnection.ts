import { Connection } from '@2colors/esphome-native-api';
import { Deferred } from '@utils/deferred';
import { logInfo, logInfoDedup, logWarn, logWarnDedup } from '@utils/logger';
import { wait } from '@utils/wait';
import { IESPConnection } from './IESPConnection';
import { connect } from './connect';
import { BLEAdvertisement } from './types/BLEAdvertisement';
import { BLEDevice } from './types/BLEDevice';
import { IBLEDevice } from './types/IBLEDevice';

export class ESPConnection implements IESPConnection {
  constructor(private connections: Connection[]) {}

  async reconnect(): Promise<void> {
    this.disconnect();
    logInfo('[ESPHome] Reconnecting...');
    this.connections = await Promise.all(
      this.connections.map((connection) =>
        connect(new Connection({ host: connection.host, port: connection.port, password: connection.password }))
      )
    );
  }

  disconnect(): void {
    logInfo('[ESPHome] Disconnecting...');

    for (const connection of this.connections) {
      connection.disconnect();
      connection.connected = false;
    }
  }

  async getBLEDevices(deviceNames: string[], nameMapper?: (name: string) => string): Promise<IBLEDevice[]> {
    // Rate limit repetitive scan logs (device may be asleep/out of range).
    const searchKey = `esphome:search:${deviceNames.map((d) => d.toLowerCase()).sort().join(',')}`;
    logInfoDedup(searchKey, 60_000, `[ESPHome] Searching for device(s): ${deviceNames.join(', ')}`);
    deviceNames = deviceNames.map((name) => name.toLowerCase());
    const bleDevices: IBLEDevice[] = [];
    const complete = new Deferred<void>();
    const timeoutMs = 30_000;
    const stop = Promise.race([complete.then(() => 'complete' as const), wait(timeoutMs).then(() => 'timeout' as const)]);
    await this.discoverBLEDevices(
      (bleDevice) => {
        const { name, mac } = bleDevice;
        const lowerName = name.toLowerCase();
        /**
         * Matching strategy (battle-tested for BLE proxy + consumer devices):
         * - Some devices advertise as "KSBT<mac>" (Keeson/Purple), while we often want to configure just "<mac>".
         * - Names can have null padding and/or suffixes; nameMapper can normalize, but we still need tolerant matching.
         * - We prefer exact matches, but allow safe derived matches (prefix/suffix vs mac) to avoid "can't find device"
         *   despite the proxy seeing it.
         */
        const index = deviceNames.findIndex((deviceName) => {
          // Exact identifiers
          if (deviceName === mac) return true;
          if (deviceName === lowerName) return true;
          // Prefix/suffix tolerance (e.g. "ksbt<mac>" vs "<mac>")
          if (lowerName.startsWith(deviceName)) return true;
          if (lowerName.endsWith(deviceName)) return true;
          if (deviceName.endsWith(mac)) return true;
          return false;
        });
        if (index === -1) return;

        deviceNames.splice(index, 1);
        logInfo(`[ESPHome] Found device: ${name} (${mac})`);
        bleDevices.push(bleDevice);
        if (deviceNames.length) return;
        complete.resolve();
      },
      stop.then(() => undefined),
      nameMapper
    );
    const stopReason = await stop;
    if (deviceNames.length) {
      const suffix = stopReason === 'timeout' ? ` (timed out after ${timeoutMs / 1000}s)` : '';
      const missKey = `esphome:miss:${deviceNames.sort().join(',')}`;
      logWarnDedup(missKey, 60_000, `[ESPHome] Could not find address for device(s): ${deviceNames.join(', ')}${suffix}`);
    }
    return bleDevices;
  }

  async discoverBLEDevices(
    onNewDeviceFound: (bleDevice: IBLEDevice) => void,
    complete: Promise<void>,
    nameMapper?: (name: string) => string
  ) {
    const seenAddresses: number[] = [];
    const listenerBuilder = (connection: Connection) => ({
      connection,
      listener: (advertisement: BLEAdvertisement) => {
        let { name } = advertisement;
        const { address } = advertisement;

        if (seenAddresses.includes(address) || !name) return;
        seenAddresses.push(address);

        if (nameMapper) name = nameMapper(name);
        onNewDeviceFound(new BLEDevice(name, advertisement, connection));
      },
    });
    const listeners = this.connections.map(listenerBuilder);
    for (const { connection, listener } of listeners) {
      connection.on('message.BluetoothLEAdvertisementResponse', listener).subscribeBluetoothAdvertisementService();
    }
    await complete;
    for (const { connection, listener } of listeners) {
      connection.off('message.BluetoothLEAdvertisementResponse', listener);
    }
  }
}
