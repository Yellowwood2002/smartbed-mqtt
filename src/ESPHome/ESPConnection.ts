import { Connection } from '@2colors/esphome-native-api';
import { Deferred } from '@utils/deferred';
import { logInfo, logInfoDedup, logWarnDedup } from '@utils/logger';
import { wait } from '@utils/wait';
import { DiscoveredBLEAdvertisement, IESPConnection } from './IESPConnection';
import { connect } from './connect';
import { BLEAdvertisement } from './types/BLEAdvertisement';
import { BLEDevice } from './types/BLEDevice';
import { IBLEDevice } from './types/IBLEDevice';

interface BLEProxy {
  host: string;
  port: number | undefined;
  password: string | undefined;
  encryptionKey: string | undefined;
  expectedServerName: string | undefined;
}

export class ESPConnection implements IESPConnection {
  constructor(private connections: Connection[], private proxies: BLEProxy[]) {}

  async reconnect(): Promise<void> {
    this.disconnect();
    logInfo('[ESPHome] Reconnecting...');
    this.connections = await Promise.all(this.proxies.map((proxy) => connect(new Connection(proxy))));
  }

  disconnect(): void {
    logInfo('[ESPHome] Disconnecting...');

    for (const connection of this.connections) {
      connection.disconnect();
      connection.connected = false;
    }
  }

  async getBLEDevices(deviceNames: string[], nameMapper?: (name: string) => string): Promise<IBLEDevice[]> {
    return await this.getBLEDevicesInternal(deviceNames, nameMapper, false);
  }

  /**
   * Internal implementation that can "self-heal" a dead ESPHome subscription.
   *
   * Why:
   * - When the ESPHome API socket is half-open or subscriptions silently stop delivering,
   *   scanning will time out with **zero** advertisements seen. Retrying the scan in a loop
   *   never recovers; a reconnect is required.
   *
   * How:
   * - If a scan times out and we saw 0 advertisements from all proxies, force a reconnect
   *   (once) and retry the scan.
   */
  private async getBLEDevicesInternal(
    deviceNames: string[],
    nameMapper?: (name: string) => string,
    reconnectAttempted: boolean = false
  ): Promise<IBLEDevice[]> {
    // Rate limit repetitive scan logs (device may be asleep/out of range).
    const originalDeviceNames = [...deviceNames];
    const searchKey = `esphome:search:${originalDeviceNames.map((d) => d.toLowerCase()).sort().join(',')}`;
    logInfoDedup(searchKey, 60_000, `[ESPHome] Searching for device(s): ${originalDeviceNames.join(', ')}`);

    // Work on a mutable normalized copy.
    let remaining = originalDeviceNames.map((name) => name.toLowerCase());
    const bleDevices: IBLEDevice[] = [];
    const complete = new Deferred<void>();
    const timeoutMs = 30_000;
    const stop = Promise.race([complete.then(() => 'complete' as const), wait(timeoutMs).then(() => 'timeout' as const)]);

    // Diagnostics: track whether the proxy delivered *any* advertisements during the scan window.
    // This helps distinguish "bed not advertising" from "proxy/socket is dead".
    let advertisementsSeen = 0;
    const advertisementsSeenByHost: Record<string, number> = {};

    await this.discoverBLEDevices(
      (device) => {
        const { name, mac, advertisement, connection } = device;
        advertisementsSeen += 1;
        const host = connection.host || 'unknown';
        advertisementsSeenByHost[host] = (advertisementsSeenByHost[host] || 0) + 1;
        const lowerName = name.toLowerCase();
        /**
         * Matching strategy (battle-tested for BLE proxy + consumer devices):
         * - Some devices advertise as "KSBT<mac>" (Keeson/Purple), while we often want to configure just "<mac>".
         * - Names can have null padding and/or suffixes; nameMapper can normalize, but we still need tolerant matching.
         * - We prefer exact matches, but allow safe derived matches (prefix/suffix vs mac) to avoid "can't find device"
         *   despite the proxy seeing it.
         */
        const matches = (deviceName: string) => {
          const dn = deviceName.toLowerCase().trim();
          if (!dn) return false;

          // Exact identifiers
          if (dn === mac) return true;
          if (dn === lowerName) return true;

          // Normalize MAC-like tokens (e.g. "d2:a3:..." or "d2a33c...")
          const dnMac = dn.replace(/[^a-f0-9]/g, '');
          if (dnMac.length === 12 && dnMac === mac) return true;

          // Prefix/suffix tolerance (e.g. "ksbt<...>" vs "<...>")
          if (lowerName.startsWith(dn)) return true;
          if (lowerName.endsWith(dn)) return true;
          if (dn.endsWith(mac)) return true;

          /**
           * Project memory:
           * Users often configure partial identifiers (aliases) like `b04c06002764`
           * that are substrings of the advertised name `KSBT04C060027642`.
           * Allow safe substring matching for reasonably-long tokens.
           */
          if (dn.length >= 6 && lowerName.includes(dn)) return true;
          if (dn.length >= 7 && dn.startsWith('b') && lowerName.includes(dn.slice(1))) return true;

          return false;
        };

        /**
         * Project memory:
         * A single physical controller can match multiple configured identifiers:
         * - aliases (multiple tokens)
         * - colon-MAC vs 12-hex
         * - KSBT prefix variants
         *
         * If we only remove the *first* match, discovery won't complete early and will
         * wait for the full timeout, then emit a misleading "Could not find address..."
         * warning even though we already found the device.
         *
         * Fix: remove *all* identifiers satisfied by this advertisement.
         */
        const before = remaining.length;
        remaining = remaining.filter((deviceName) => !matches(deviceName));
        if (remaining.length === before) return;

        logInfo(`[ESPHome] Found device: ${name} (${mac})`);
        // IMPORTANT: only create BLEDevice instances for matched devices to avoid accumulating
        // EventEmitter listeners for every advertisement seen during scanning.
        bleDevices.push(new BLEDevice(name, advertisement, connection));
        if (remaining.length) return;
        complete.resolve();
      },
      stop.then(() => undefined),
      nameMapper
    );
    const stopReason = await stop;

    // If the scan timed out AND we saw zero advertisements from all proxies, the most likely
    // cause is an ESPHome API subscription/socket issue. Reconnect once and retry.
    if (
      stopReason === 'timeout' &&
      !reconnectAttempted &&
      this.connections.length > 0 &&
      advertisementsSeen === 0
    ) {
      const diag = Object.entries(advertisementsSeenByHost)
        .map(([host, count]) => `${host}=${count}`)
        .join(', ');
      logWarnDedup(
        `esphome:scanSilent:${searchKey}`,
        60_000,
        `[ESPHome] Scan timed out with 0 advertisements seen. Reconnecting ESPHome proxy API and retrying once. (${diag || 'no hosts'})`
      );
      await this.reconnect();
      return await this.getBLEDevicesInternal(originalDeviceNames, nameMapper, true);
    }

    if (remaining.length) {
      const suffix = stopReason === 'timeout' ? ` (timed out after ${timeoutMs / 1000}s)` : '';
      const missKey = `esphome:miss:${remaining.sort().join(',')}`;
      const proxyDiag =
        advertisementsSeen > 0
          ? ` (advertisementsSeen=${advertisementsSeen})`
          : ' (advertisementsSeen=0; proxy may be disconnected or not scanning)';
      logWarnDedup(
        missKey,
        60_000,
        `[ESPHome] Could not find address for device(s): ${remaining.join(', ')}${suffix}${proxyDiag}`
      );
    }
    return bleDevices;
  }

  async discoverBLEDevices(
    onNewDeviceFound: (device: DiscoveredBLEAdvertisement) => void,
    complete: Promise<void>,
    nameMapper?: (name: string) => string
  ) {
    const seenAddresses: number[] = [];
    const listenerBuilder = (connection: Connection) => ({
      connection,
      listener: (advertisement: BLEAdvertisement) => {
        /**
         * Project memory:
         * Many BLE devices (including some bed controllers) advertise without a local name.
         * If we drop unnamed advertisements, discovery-by-MAC can never work and the add-on
         * will loop forever saying "device not discovered" even though the proxy sees it.
         *
         * Strategy:
         * - Always accept advertisements (named or unnamed).
         * - Use the 12-hex derived address as a stable fallback name when advertisement.name is empty.
         */
        let name = advertisement.name ?? '';
        const { address } = advertisement;

        if (seenAddresses.includes(address)) return;
        seenAddresses.push(address);

        if (name && nameMapper) name = nameMapper(name);
        if (!name) name = address.toString(16).padStart(12, '0');
        const mac = address.toString(16).padStart(12, '0');
        onNewDeviceFound({ name, mac, address, advertisement, connection });
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
