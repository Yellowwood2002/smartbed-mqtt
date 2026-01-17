import { Connection } from '@2colors/esphome-native-api';
import { Deferred } from '@utils/deferred';
import { logInfo, logWarn } from '@utils/logger';
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
    logInfo(`[ESPHome] Searching for device(s): ${deviceNames.join(', ')}`);
    deviceNames = deviceNames.map((name) => name.toLowerCase());
    const bleDevices: IBLEDevice[] = [];
    const complete = new Deferred<void>();
    const timedOut = await this.discoverBLEDevices(
      (bleDevice) => {
        const { name, mac } = bleDevice;
        let index = deviceNames.indexOf(mac);
        if (index === -1) index = deviceNames.indexOf(name.toLowerCase());
        if (index === -1) return;

        deviceNames.splice(index, 1);
        logInfo(`[ESPHome] Found device: ${name} (${mac})`);
        bleDevices.push(bleDevice);
        if (deviceNames.length) return;
        complete.resolve();
      },
      complete,
      nameMapper
    );

    // If discovery hangs (no advertisements ever arrive), treat as a failure so the outer retry loops can recover.
    // This prevents the add-on from getting stuck forever at "Searching for device(s): ..." with no recovery.
    if (deviceNames.length) {
      logWarn(`[ESPHome] Cound not find address for device(s): ${deviceNames.join(', ')}`);
      if (timedOut) {
        throw new Error(`[ESPHome] BLE discovery timed out after 60s. Missing: ${deviceNames.join(', ')}`);
      }
    }
    return bleDevices;
  }

  async discoverBLEDevices(
    onNewDeviceFound: (bleDevice: IBLEDevice) => void,
    complete: Promise<void>,
    nameMapper?: (name: string) => string,
    timeoutMs = 60_000
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
    let timedOut = false;
    await Promise.race([
      complete,
      wait(timeoutMs).then(() => {
        timedOut = true;
      }),
    ]);
    for (const { connection, listener } of listeners) {
      connection.off('message.BluetoothLEAdvertisementResponse', listener);
    }
    return timedOut;
  }
}
