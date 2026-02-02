import { BluetoothGATTService, Connection } from '@2colors/esphome-native-api';
import { Dictionary } from '@utils/Dictionary';
import { BLEAdvertisement } from './BLEAdvertisement';
import { BLEDeviceInfo } from './BLEDeviceInfo';
import { IBLEDevice } from './IBLEDevice';
import { logDebug, logInfo, logWarn } from '@utils/logger';

// Static registry to track active BLEDevice instances by address+connection
// This allows us to clean up old listeners when new instances are created
type DeviceKey = string;
const deviceRegistry = new Map<DeviceKey, BLEDevice>();
// Heuristic memory: some devices/proxies behave better when connecting WITHOUT cache.
// Keyed by (proxy host + address) so once we learn "without cache fixes services=0",
// we try that first next time to reduce flakiness and startup time.
const preferWithoutCacheByDeviceKey = new Map<DeviceKey, boolean>();

function getDeviceKey(connection: Connection, address: number): DeviceKey {
  return `${connection.host || 'unknown'}:${address}`;
}

export class BLEDevice implements IBLEDevice {
  private connected = false;
  private paired = false;

  private servicesList?: BluetoothGATTService[];
  private serviceCache: Dictionary<BluetoothGATTService | null> = {};

  private deviceInfo?: BLEDeviceInfo;
  
  // Store listener reference for cleanup - use bound method for stable reference
  private connectionResponseListener: (data: { address: number; connected: boolean }) => void;
  private notifyDataListeners: Map<number, (message: any) => void> = new Map();
  private deviceKey: DeviceKey;
  
  // Connection mutex to prevent simultaneous connection attempts
  private connectingPromise: Promise<void> | null = null;

  public mac: string;
  public get address() {
    return this.advertisement.address;
  }
  public get host(): string | undefined {
    return this.connection.host;
  }
  public get manufacturerDataList() {
    return this.advertisement.manufacturerDataList;
  }
  public get serviceUuidsList() {
    return this.advertisement.serviceUuidsList;
  }

  constructor(public name: string, public advertisement: BLEAdvertisement, private connection: Connection) {
    this.mac = this.address.toString(16).padStart(12, '0');
    this.deviceKey = getDeviceKey(connection, this.address);
    
    // CRITICAL: Clean up any existing BLEDevice instance for this address+connection
    // This prevents listener accumulation during retries
    const existingDevice = deviceRegistry.get(this.deviceKey);
    if (existingDevice && existingDevice !== this) {
      // Explicitly clean up the old instance's listeners BEFORE creating new ones
      // This removes the listener using .off() which is the proper way to remove it
      existingDevice.cleanup();
    }
    
    // Register this instance
    deviceRegistry.set(this.deviceKey, this);
    
    // Use bound method for stable reference - this ensures .off() can successfully remove it
    this.connectionResponseListener = this.handleConnectionResponse.bind(this);
    
    // Remove our specific listener if it exists (idempotent)
    // This ensures we don't add duplicate listeners if constructor is called multiple times
    this.connection.off('message.BluetoothDeviceConnectionResponse', this.connectionResponseListener);
    
    // Add our listener
    this.connection.on('message.BluetoothDeviceConnectionResponse', this.connectionResponseListener);
  }
  
  // Bound method handler for connection responses - stable reference for listener management
  private handleConnectionResponse = (data: { address: number; connected: boolean }) => {
    if (this.address !== data.address || this.connected === data.connected) return;
    void this.connect();
  };
  
  // Cleanup method to remove all listeners
  cleanup(): void {
    if (this.connectionResponseListener) {
      this.connection.off('message.BluetoothDeviceConnectionResponse', this.connectionResponseListener);
    }
    
    // Remove all notify data listeners
    for (const [_handle, listener] of this.notifyDataListeners.entries()) {
      this.connection.off('message.BluetoothGATTNotifyDataResponse', listener);
    }
    this.notifyDataListeners.clear();
    
    // Remove from registry
    const registered = deviceRegistry.get(this.deviceKey);
    if (registered === this) {
      deviceRegistry.delete(this.deviceKey);
    }
  }

  pair = async () => {
    const { paired } = await this.connection.pairBluetoothDeviceService(this.address);
    this.paired = paired;
  };

  connect = async () => {
    // Connection mutex: if already connecting, return the existing promise
    if (this.connectingPromise) {
      return this.connectingPromise;
    }
    
    // Create new connection promise
    this.connectingPromise = (async () => {
      try {
        const { addressType } = this.advertisement;
        const preferWithoutCache = preferWithoutCacheByDeviceKey.get(this.deviceKey) === true;

        const connectOnce = async (withoutCache: boolean) => {
          if (withoutCache && typeof (this.connection as any).connectBluetoothDeviceServiceWithoutCache === 'function') {
            return await (this.connection as any).connectBluetoothDeviceServiceWithoutCache(this.address, addressType);
          }
          return await this.connection.connectBluetoothDeviceService(this.address, addressType);
        };

        // Try preferred mode first, then fall back once.
        let response: any;
        try {
          response = await connectOnce(preferWithoutCache);
        } catch (e) {
          response = undefined;
          // If the preferred mode threw, try the other mode once before failing.
          try {
            response = await connectOnce(!preferWithoutCache);
            // If fallback worked, remember it.
            preferWithoutCacheByDeviceKey.set(this.deviceKey, !preferWithoutCache);
          } catch {
            throw e;
          }
        }

        const connected = response?.connected === true;
        const errorCode = response?.error;
        const mtu = response?.mtu;

        logDebug(
          `[BLE] Proxy connect response for ${this.name} (${this.mac}): connected=${String(connected)} error=${String(
            errorCode
          )} mtu=${String(mtu)} addressType=${String(addressType)}`
        );

        // IMPORTANT: don't claim success unless the proxy confirms it.
        if (!connected) {
          // If we haven't tried the other mode yet, do so once (proxy cache can be poisoned).
          if (!preferWithoutCacheByDeviceKey.has(this.deviceKey)) {
            try {
              const retry: any = await connectOnce(true);
              if (retry?.connected === true) {
                preferWithoutCacheByDeviceKey.set(this.deviceKey, true);
                logWarn(
                  `[BLE] Connect succeeded only with WITHOUT cache for ${this.name} (${this.mac}); pinning preference`
                );
                this.connected = true;
                logInfo(
                  `[BLE] Successfully connected to device ${this.name} (${this.mac}) (mtu=${retry?.mtu ?? 'n/a'})`
                );
                if (this.paired) await this.pair();
                return;
              }
            } catch {}
          }
          throw new Error(
            `ESPHome proxy connect failed (connected=${String(response?.connected)} error=${String(errorCode)} mtu=${String(
              mtu
            )})`
          );
        }

        if (typeof errorCode === 'number' && errorCode !== 0) {
          logWarn(
            `[BLE] Proxy reported non-zero connect error for ${this.name} (${this.mac}) (error=${errorCode} mtu=${mtu})`
          );
        }

        if ((mtu ?? 0) === 0) {
          logWarn(
            `[BLE] Proxy reported mtu=0 for ${this.name} (${this.mac}) — treating as suspicious (ESP32 status=133/0x100 patterns)`
          );
        }

        this.connected = true;
        logInfo(`[BLE] Successfully connected to device ${this.name} (${this.mac}) (mtu=${mtu ?? 'n/a'})`);
        if (this.paired) await this.pair();
      } catch (error: any) {
        logWarn(
          `[BLE] Failed to connect to device ${this.name} (${this.mac}):`,
          error?.message || String(error)
        );
        this.connected = false;
        throw error;
      } finally {
        // Clear the promise once connection succeeds or fails
        this.connectingPromise = null;
      }
    })();
    
    return this.connectingPromise;
  };

  disconnect = async () => {
    this.connected = false;
    try {
      await this.connection.disconnectBluetoothDeviceService(this.address);
      logInfo(`[BLE] Successfully disconnected device ${this.name} (${this.mac})`);
    } catch (error: any) {
      // Don't log as error - disconnect failures are often harmless (device already disconnected)
      const errorMessage = error?.message || String(error);
      if (!errorMessage.includes('Not connected') && !errorMessage.includes('not connected')) {
        logWarn(`[BLE] Error disconnecting device ${this.name} (${this.mac}):`, errorMessage);
      }
      // Don't re-throw - disconnect failures shouldn't crash the process
    }
  };

  writeCharacteristic = async (handle: number, bytes: Uint8Array, response = true) => {
    await this.connection.writeBluetoothGATTCharacteristicService(this.address, handle, bytes, response);
  };

  getServices = async () => {
    if (!this.servicesList) {
      const startedAt = Date.now();
      try {
        logDebug(
          `[BLE] Requesting GATT services for ${this.name} (${this.mac}) via proxy=${this.connection.host} addressType=${this.advertisement.addressType}`
        );
        const { servicesList } = await this.connection.listBluetoothGATTServicesService(this.address);
        this.servicesList = servicesList;
        logDebug(
          `[BLE] GATT services ready for ${this.name} (${this.mac}) in ${Date.now() - startedAt}ms (services=${servicesList.length})`
        );

        // Probe: a "connected" device returning zero services is almost always a proxy-side issue.
        // Try a short delay and one retry; then clear cache + connect without cache + retry once.
        if (this.servicesList.length === 0) {
          logWarn(
            `[BLE] GATT services returned empty for ${this.name} (${this.mac}) ` +
              `rssi=${this.advertisement.rssi} addressType=${this.advertisement.addressType} ` +
              `advUuids=${(this.advertisement.serviceUuidsList || []).join(',') || 'none'}`
          );

          // quick retry after small delay
          await new Promise((r) => setTimeout(r, 400));
          const retry1 = await this.connection.listBluetoothGATTServicesService(this.address);
          this.servicesList = retry1.servicesList;
          logWarn(
            `[BLE] GATT services retry-after-delay for ${this.name} (${this.mac}) ` +
              `(services=${this.servicesList.length})`
          );
        }

        if (this.servicesList.length === 0) {
          try {
            logWarn(`[BLE] Probing cache-clear + connect-without-cache for ${this.name} (${this.mac})`);
            await (this.connection as any).clearBluetoothDeviceCacheService?.(this.address);
            await this.disconnect();
            await (this.connection as any).connectBluetoothDeviceServiceWithoutCache?.(
              this.address,
              this.advertisement.addressType
            );
            await new Promise((r) => setTimeout(r, 600));
            const retry2 = await this.connection.listBluetoothGATTServicesService(this.address);
            this.servicesList = retry2.servicesList;
            logWarn(
              `[BLE] GATT services after cache-clear probe for ${this.name} (${this.mac}) (services=${this.servicesList.length})`
            );
            if (this.servicesList.length > 0) {
              // If cache-clear + without-cache fixed discovery, prefer without-cache next time.
              preferWithoutCacheByDeviceKey.set(this.deviceKey, true);
            }
          } catch (e: any) {
            logWarn(
              `[BLE] Cache-clear probe failed for ${this.name} (${this.mac})`,
              e?.message || String(e)
            );
          }
        }
      } catch (error: any) {
        // Clear cache on error so we can retry
        this.servicesList = undefined;
        const errorMessage = error?.message || String(error);
        if (errorMessage.includes('timeout') || errorMessage.includes('BluetoothGATTGetServicesDoneResponse')) {
          logWarn(`[BLE] Timeout getting services for device ${this.name} (${this.mac}):`, errorMessage);
          /**
           * Recovery ladder (project memory):
           * ESPHome proxies sometimes get "stuck" in a bad cached state for a given BLE device.
           * When services discovery times out, try:
           * - clear proxy cache for the device
           * - reconnect without cache
           * - retry services once
           */
          try {
            logWarn(`[BLE] Clearing proxy cache and retrying services once for ${this.name} (${this.mac})`);
            await (this.connection as any).clearBluetoothDeviceCacheService?.(this.address);
            await this.disconnect();
            await (this.connection as any).connectBluetoothDeviceServiceWithoutCache?.(
              this.address,
              this.advertisement.addressType
            );
            const { servicesList } = await this.connection.listBluetoothGATTServicesService(this.address);
            this.servicesList = servicesList;
            logInfo(
              `[BLE] GATT services recovered after cache clear for ${this.name} (${this.mac}) (services=${servicesList.length})`
            );
            return this.servicesList;
          } catch (recoveryError: any) {
            const msg = recoveryError?.message || String(recoveryError);
            logWarn(`[BLE] Services recovery failed for ${this.name} (${this.mac})`, msg);
          }
          throw new Error(`BLE timeout: ${errorMessage}`);
        }
        throw error;
      }
    }
    return this.servicesList;
  };

  getCharacteristic = async (serviceUuid: string, characteristicUuid: string, writeLogs = true) => {
    const service = await this.getService(serviceUuid);

    if (!service) {
      if (writeLogs) {
        const services = await this.getServices().catch(() => undefined);
        const uuids = services?.map((s) => s.uuid).filter(Boolean) ?? [];
        const sample = uuids.slice(0, 8).join(', ');
        logWarn(
          `[BLE] Missing expected service on ${this.name} (${this.mac}) expected=${serviceUuid} ` +
            `foundCount=${uuids.length}${sample ? ` foundSample=[${sample}]` : ''}`
        );
      }
      return undefined;
    }

    const characteristic = service?.characteristicsList?.find((c) => c.uuid === characteristicUuid);
    if (!characteristic) {
      writeLogs &&
        logWarn(
          `[BLE] Missing expected characteristic on ${this.name} (${this.mac}) ` +
            `service=${serviceUuid} expectedChar=${characteristicUuid} ` +
            `foundChars=${service?.characteristicsList?.length ?? 0}`
        );
      return undefined;
    }

    return characteristic;
  };

  subscribeToCharacteristic = async (handle: number, notify: (data: Uint8Array) => void) => {
    // Remove existing listener for this handle if it exists
    const existingListener = this.notifyDataListeners.get(handle);
    if (existingListener) {
      this.connection.off('message.BluetoothGATTNotifyDataResponse', existingListener);
    }
    
    // Create and store new listener
    const listener = (message: any) => {
      if (message.address != this.address || message.handle != handle) return;
      notify(new Uint8Array([...Buffer.from(message.data, 'base64')]));
    };
    this.notifyDataListeners.set(handle, listener);
    
    this.connection.on('message.BluetoothGATTNotifyDataResponse', listener);
    await this.connection.notifyBluetoothGATTCharacteristicService(this.address, handle);
  };

  readCharacteristic = async (handle: number) => {
    const response = await this.connection.readBluetoothGATTCharacteristicService(this.address, handle);
    return new Uint8Array([...Buffer.from(response.data, 'base64')]);
  };

  getDeviceInfo = async () => {
    if (this.deviceInfo) return this.deviceInfo;
    const services = await this.getServices();
    const service = services.find((s) => s.uuid === '0000180a-0000-1000-8000-00805f9b34fb');
    if (!service) return undefined;

    const deviceInfo: BLEDeviceInfo = (this.deviceInfo = {});
    const setters: Dictionary<(value: string) => void> = {
      '00002a24-0000-1000-8000-00805f9b34fb': (value: string) => (deviceInfo.modelNumber = value),
      '00002a25-0000-1000-8000-00805f9b34fb': (value: string) => (deviceInfo.serialNumber = value),
      '00002a26-0000-1000-8000-00805f9b34fb': (value: string) => (deviceInfo.firmwareRevision = value),
      '00002a27-0000-1000-8000-00805f9b34fb': (value: string) => (deviceInfo.hardwareRevision = value),
      '00002a28-0000-1000-8000-00805f9b34fb': (value: string) => (deviceInfo.softwareRevision = value),
      '00002a29-0000-1000-8000-00805f9b34fb': (value: string) => (deviceInfo.manufacturerName = value),
    };
    for (const { uuid, handle } of service.characteristicsList) {
      const setter = setters[uuid];
      if (!setter) continue;
      try {
        const value = await this.readCharacteristic(handle);
        setter(Buffer.from(value).toString());
      } catch {}
    }

    return this.deviceInfo;
  };

  private getService = async (serviceUuid: string) => {
    const cachedService = this.serviceCache[serviceUuid];
    if (cachedService !== undefined) return cachedService;

    const services = await this.getServices();
    const service = services.find((s) => s.uuid === serviceUuid) || null;
    this.serviceCache[serviceUuid] = service;
    return service;
  };
}
