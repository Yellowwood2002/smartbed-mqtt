import { BluetoothGATTService, Connection } from '@2colors/esphome-native-api';
import { Dictionary } from '@utils/Dictionary';
import { BLEAdvertisement } from './BLEAdvertisement';
import { BLEDeviceInfo } from './BLEDeviceInfo';
import { IBLEDevice } from './IBLEDevice';
import { logInfo, logWarn } from '@utils/logger';

// Static registry to track active BLEDevice instances by address+connection
// This allows us to clean up old listeners when new instances are created
type DeviceKey = string;
const deviceRegistry = new Map<DeviceKey, BLEDevice>();

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
        await this.connection.connectBluetoothDeviceService(this.address, addressType);
        this.connected = true;
        if (this.paired) await this.pair();
      } finally {
        // Clear the promise once connection succeeds or fails
        this.connectingPromise = null;
      }
    })();
    
    return this.connectingPromise;
  };

  disconnect = async () => {
    this.connected = false;
    await this.connection.disconnectBluetoothDeviceService(this.address);
  };

  writeCharacteristic = async (handle: number, bytes: Uint8Array, response = true) => {
    await this.connection.writeBluetoothGATTCharacteristicService(this.address, handle, bytes, response);
  };

  getServices = async () => {
    if (!this.servicesList) {
      try {
        const { servicesList } = await this.connection.listBluetoothGATTServicesService(this.address);
        this.servicesList = servicesList;
      } catch (error: any) {
        // Clear cache on error so we can retry
        this.servicesList = undefined;
        const errorMessage = error?.message || String(error);
        if (errorMessage.includes('timeout') || errorMessage.includes('BluetoothGATTGetServicesDoneResponse')) {
          logWarn(`[BLE] Timeout getting services for device ${this.name} (${this.mac}):`, errorMessage);
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
      writeLogs && logInfo('[BLE] Could not find expected service for device:', serviceUuid, this.name);
      return undefined;
    }

    const characteristic = service?.characteristicsList?.find((c) => c.uuid === characteristicUuid);
    if (!characteristic) {
      writeLogs && logInfo('[BLE] Could not find expected characteristic for device:', characteristicUuid, this.name);
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
