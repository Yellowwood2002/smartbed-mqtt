import { BluetoothGATTService, Connection } from '@2colors/esphome-native-api';
import { Dictionary } from '@utils/Dictionary';
import { BLEAdvertisement } from './BLEAdvertisement';
import { BLEDeviceInfo } from './BLEDeviceInfo';
import { IBLEDevice } from './IBLEDevice';
import { logDebug, logInfo, logWarn } from '@utils/logger';
import { readFileSync, writeFileSync } from 'fs';

// Static registry to track active BLEDevice instances by address+connection
// This allows us to clean up old listeners when new instances are created
type DeviceKey = string;
const deviceRegistry = new Map<DeviceKey, BLEDevice>();
// Global connect mutex keyed by device+proxy.
// We can end up with multiple BLEDevice instances for the same deviceKey during scan/retry loops,
// and the per-instance mutex is not sufficient. Overlapping connects manifest as proxy logs like:
// "Connection request ignored, state: IDLE/CONNECTING/ESTABLISHED" and ESP-IDF GATT_BUSY.
const connectInFlightByDeviceKey = new Map<DeviceKey, Promise<void>>();
// Per-device cooldown after hard ESP-IDF failures (status=133 / reason 0x100 patterns).
const cooldownUntilByDeviceKey = new Map<DeviceKey, number>();
const ignoredConnectsByDeviceKey = new Map<DeviceKey, number>();
// Slow-connect protection: temporarily force without-cache if connects are slow/ignored/time out.
const forceWithoutCacheUntilByDeviceKey = new Map<DeviceKey, number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const formatMacForProxyLog = (mac12hex: string) =>
  mac12hex
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '')
    .padStart(12, '0')
    .match(/.{1,2}/g)
    ?.join(':')
    .toUpperCase() ?? mac12hex;

/**
 * Wait for the underlying ESPHome API connection to be ready.
 *
 * Why:
 * - The ESPHome native API client can transiently drop and reconnect (ping failures / wifi blips).
 * - During that window, BLE operations throw fast with "Not connected" / "Not authorized" and our
 *   connect attempts finish in ~0ms, causing command failures.
 *
 * Strategy:
 * - Wait a short, bounded window for (connected && authorized) before attempting BLE requests.
 * - If it doesn't recover quickly, fail fast so higher-level self-heal can reconnect cleanly.
 */
const awaitESPHomeReady = async (connection: Connection, timeoutMs: number): Promise<void> => {
  const anyConn = connection as any;
  if (anyConn?.connected && anyConn?.authorized) return;

  await new Promise<void>((resolve, reject) => {
    let timeout: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      try {
        (connection as any).off?.('authorized', onAuthorized);
        (connection as any).off?.('connected', onConnected);
        (connection as any).off?.('error', onError);
      } catch {}
    };
    const done = () => {
      const c = (connection as any)?.connected;
      const a = (connection as any)?.authorized;
      if (c && a) {
        cleanup();
        resolve();
      }
    };
    const onAuthorized = () => done();
    const onConnected = () => done();
    const onError = (e: any) => {
      cleanup();
      reject(e);
    };

    try {
      (connection as any).on?.('authorized', onAuthorized);
      (connection as any).on?.('connected', onConnected);
      (connection as any).on?.('error', onError);
    } catch {}

    timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`ESPHome API not ready after ${timeoutMs}ms`));
    }, timeoutMs);

    // Check once immediately after attaching listeners.
    done();
  });
};

type ConnectPreference = {
  // Prefer CONNECT_V3_WITHOUT_CACHE
  withoutCache?: boolean;
};

// Persist learned preferences across restarts (in add-on data dir).
const PREFS_PATH = '/data/smartbedmqtt-ble-preferences.json';
const connectPrefsByDeviceKey = new Map<DeviceKey, ConnectPreference>();

const loadPrefs = () => {
  try {
    const raw = readFileSync(PREFS_PATH, 'utf8');
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object') return;
    for (const [k, v] of Object.entries(json)) {
      if (!k || typeof v !== 'object' || v === null) continue;
      const pref: ConnectPreference = {};
      if (typeof (v as any).withoutCache === 'boolean') pref.withoutCache = (v as any).withoutCache;
      connectPrefsByDeviceKey.set(k, pref);
    }
  } catch {
    // ok
  }
};

let prefsLoaded = false;
const ensurePrefsLoaded = () => {
  if (prefsLoaded) return;
  prefsLoaded = true;
  loadPrefs();
  if (connectPrefsByDeviceKey.size) {
    logDebug(`[BLE] Loaded connect prefs from ${PREFS_PATH} (count=${connectPrefsByDeviceKey.size})`);
  } else {
    logDebug(`[BLE] No persisted connect prefs found at ${PREFS_PATH}`);
  }
};

const persistPrefsNow = () => {
  try {
    const obj: Record<string, ConnectPreference> = {};
    for (const [k, v] of connectPrefsByDeviceKey.entries()) obj[k] = v;
    writeFileSync(PREFS_PATH, JSON.stringify(obj, null, 2), 'utf8');
    logDebug(`[BLE] Saved connect prefs to ${PREFS_PATH} (count=${connectPrefsByDeviceKey.size})`);
  } catch (e: any) {
    logWarn(`[BLE] Failed saving connect prefs to ${PREFS_PATH}`, e?.message || String(e));
  }
};

const setConnectPref = (key: DeviceKey, patch: ConnectPreference) => {
  ensurePrefsLoaded();
  const prev = connectPrefsByDeviceKey.get(key) ?? {};
  const next = { ...prev, ...patch };
  connectPrefsByDeviceKey.set(key, next);
  persistPrefsNow();
};

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
  
  // Instance-local mutex (kept as a secondary guard; global mutex is primary)
  private connectingPromise: Promise<void> | null = null;
  // Diagnostics counters (best-effort, surfaced via Keeson diagnostics sensor)
  private ignoredConnectCount = 0;

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

    // Best-effort: observe proxy disconnect reasons for this device (only if SubscribeLogsResponse is available).
    // This helps expose disconnect reason codes (0x08, 0x16, 0x100, etc.) in the HA diagnostics sensor.
    const proxyMac = formatMacForProxyLog(this.mac);
    const proxyLogHandler = (msg: any) => {
      const line = String(msg?.message ?? '').trim();
      if (!line) return;
      if (!line.includes(`[${proxyMac}]`)) return;
      const lower = line.toLowerCase();
      if (lower.includes('disconnect') || lower.includes('close')) {
        const m = line.match(/reason\s*=?\s*(0x[0-9a-f]+)/i);
        (this as any).__bleDiag = {
          ...(this as any).__bleDiag,
          lastDisconnectAt: Date.now(),
          lastDisconnectLine: line,
          ...(m?.[1] ? { lastDisconnectReason: m[1].toLowerCase() } : {}),
        };
      }
    };
    try {
      this.connection.on('message.SubscribeLogsResponse', proxyLogHandler);
      // Store for cleanup
      (this as any).__proxyLogHandler = proxyLogHandler;
    } catch {}
  }
  
  // Bound method handler for connection responses - stable reference for listener management
  private handleConnectionResponse = (data: { address: number; connected: boolean }) => {
    if (this.address !== data.address) return;
    if (this.connected === data.connected) return;

    // IMPORTANT:
    // Do NOT auto-call connect() here.
    // ESPHome BLE proxy can emit connection responses while already CONNECTING/ESTABLISHED.
    // Auto-connecting causes repeated "Connection request ignored" messages and can trigger ESP-IDF
    // errors like GATT_BUSY (ConfigureMTU busy) and spurious disconnects.
    this.connected = data.connected;
    if (!data.connected) {
      // If we got disconnected, clear cached services so the next explicit connect/retry will re-discover.
      this.servicesList = undefined;
      this.serviceCache = {};
    }
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

    // Remove proxy log handler if present
    try {
      const h = (this as any).__proxyLogHandler;
      if (h) this.connection.off('message.SubscribeLogsResponse', h);
    } catch {}
    
    // Remove from registry
    const registered = deviceRegistry.get(this.deviceKey);
    if (registered === this) {
      deviceRegistry.delete(this.deviceKey);
    }
  }

  // Used by process telemetry diagnostics
  static getGlobalBleCounters() {
    return {
      deviceRegistrySize: deviceRegistry.size,
      connectInFlightSize: connectInFlightByDeviceKey.size,
      cooldownSize: cooldownUntilByDeviceKey.size,
      forceWithoutCacheSize: forceWithoutCacheUntilByDeviceKey.size,
    };
  }

  pair = async () => {
    const { paired } = await this.connection.pairBluetoothDeviceService(this.address);
    this.paired = paired;
  };

  connect = async () => {
    // Global mutex first: avoid overlapping connects across BLEDevice instances
    const globalInFlight = connectInFlightByDeviceKey.get(this.deviceKey);
    if (globalInFlight) return globalInFlight;

    // Cooldown gate: after hard failures, pause briefly to avoid thrash.
    const now = Date.now();
    const cooldownUntil = cooldownUntilByDeviceKey.get(this.deviceKey) ?? 0;
    if (cooldownUntil > now) {
      await sleep(cooldownUntil - now);
    }

    // Instance mutex: if already connecting, return the existing promise
    if (this.connectingPromise) return this.connectingPromise;

    const connectPromise = (async () => {
      const connectStartedAt = Date.now();
      try {
        // If the ESPHome API client is in the middle of an internal reconnect, wait briefly so
        // we don't fail instantly with "Not connected" / "Not authorized" and drop commands.
        await awaitESPHomeReady(this.connection, 5_000).catch((e: any) => {
          // Surface a clearer error message for diagnostics/self-heal.
          const msg = e?.message || String(e);
          throw new Error(`ESPHome API not ready: ${msg}`);
        });

        ensurePrefsLoaded();
        const advAddressType = this.advertisement.addressType;
        const pref = connectPrefsByDeviceKey.get(this.deviceKey) ?? {};
        const proxyMac = formatMacForProxyLog(this.mac);

        // If we've recently seen slow connects or ignored requests, force without-cache for a while.
        const forceUntil = forceWithoutCacheUntilByDeviceKey.get(this.deviceKey) ?? 0;
        const forceWithoutCache = Date.now() < forceUntil;

        const withTimeout = async <T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> => {
          const startedAt = Date.now();
          let timeoutHandle: NodeJS.Timeout | undefined;
          try {
            return await Promise.race([
              fn(),
              new Promise<T>((_resolve, reject) => {
                timeoutHandle = setTimeout(() => {
                  reject(new Error(`Timeout ${label} after ${ms}ms`));
                }, ms);
              }),
            ]);
          } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            logDebug(`[BLE] Connect attempt ${label} finished in ${Date.now() - startedAt}ms`);
          }
        };

        const raceProxyLogsToAbort = (label: string) => {
          // Only effective if connect.ts has subscribed to proxy logs (LOG_LEVEL debug/trace).
          let cleanup = () => {};
          const promise = new Promise<any>((resolve, reject) => {
            const handler = (msg: any) => {
              const line = String(msg?.message ?? '').trim();
              if (!line) return;
              // Match only log lines for this MAC.
              if (!line.includes(`[${proxyMac}]`)) return;

              const lower = line.toLowerCase();
              // Proxy explicitly tells us it ignored the request. Waiting for connect timeout wastes time.
              if (lower.includes('connection request ignored')) {
                // Special-case: if the proxy says ESTABLISHED, we're already connected and should NOT
                // force a disconnect/reconnect loop. Treat as success and short-circuit.
                if (lower.includes('state: established')) {
                  (this as any).__bleDiag = {
                    ...(this as any).__bleDiag,
                    lastIgnoredEstablishedAt: Date.now(),
                    lastIgnoredEstablishedLine: line,
                    lastIgnoredEstablishedAttempt: label,
                  };
                  resolve({
                    connected: true,
                    error: 0,
                    mtu: undefined,
                    __fromProxyIgnoredEstablished: true,
                  });
                  return;
                }
                const nextCount = (ignoredConnectsByDeviceKey.get(this.deviceKey) ?? 0) + 1;
                ignoredConnectsByDeviceKey.set(this.deviceKey, nextCount);
                this.ignoredConnectCount = nextCount;
                (this as any).__bleDiag = {
                  ...(this as any).__bleDiag,
                  ignoredConnects: nextCount,
                  lastIgnoredAt: Date.now(),
                  lastIgnoredLine: line,
                  lastIgnoredAttempt: label,
                };
                reject(new Error(`Proxy ignored connection request (${label})`));
                return;
              }

              // Hard failure patterns (ESP-IDF status=133 / reason 0x100) -> cooldown to avoid thrashing.
              if (lower.includes('status=133') || lower.includes('reason 0x100') || lower.includes('reason=0x100')) {
                const until = Date.now() + 3_000;
                cooldownUntilByDeviceKey.set(this.deviceKey, until);
                (this as any).__bleDiag = {
                  ...(this as any).__bleDiag,
                  cooldownUntil: until,
                  lastHardFailureAt: Date.now(),
                  lastHardFailureLine: line,
                  lastHardFailureAttempt: label,
                };
                reject(new Error(`Proxy reported hard BLE failure (${label})`));
              }
            };
            cleanup = () => {
              try {
                this.connection.off('message.SubscribeLogsResponse', handler);
              } catch {}
            };
            try {
              this.connection.on('message.SubscribeLogsResponse', handler);
            } catch {}
          });
          return { promise, cleanup };
        };

        const connectOnce = async (withoutCache: boolean, label: string) => {
          // DO NOT omit addressType: the proxy log shows "Missing address type in connect request" and refuses.
          const addressType = advAddressType;
          const ms = 12_000;
          const { promise: abortPromise, cleanup } = raceProxyLogsToAbort(label);
          if (withoutCache && typeof (this.connection as any).connectBluetoothDeviceServiceWithoutCache === 'function') {
            return await withTimeout(`${label}:without-cache`, ms, async () => {
              try {
                return await Promise.race([
                  (this.connection as any).connectBluetoothDeviceServiceWithoutCache(this.address, addressType),
                  abortPromise,
                ]);
              } finally {
                cleanup();
              }
            });
          }
          return await withTimeout(`${label}:with-cache`, ms, async () => {
            try {
              return await Promise.race([this.connection.connectBluetoothDeviceService(this.address, addressType), abortPromise]);
            } finally {
              cleanup();
            }
          });
        };

        const attempts: Array<[boolean, string]> = [];
        const firstWithoutCache = forceWithoutCache ? true : pref.withoutCache === true;
        attempts.push([firstWithoutCache, 'preferred']);
        attempts.push([!firstWithoutCache, 'flip-cache']);

        let response: any;
        let usedWithoutCache = firstWithoutCache;
        let lastError: any;
        for (const [withoutCache, label] of attempts) {
          usedWithoutCache = withoutCache;
          try {
            response = await connectOnce(withoutCache, label);
            if (response?.connected === true) break;
            lastError = new Error(
              `ESPHome proxy connect not connected (connected=${String(response?.connected)} error=${String(
                response?.error
              )} mtu=${String(response?.mtu)}) [${label}]`
            );
          } catch (e) {
            lastError = e;
            const msg = (e as any)?.message || String(e);
            const lower = String(msg).toLowerCase();
            if (
              lower.includes('proxy ignored connection request') ||
              lower.includes('timeout preferred') ||
              lower.includes('timeout flip-cache')
            ) {
              // Force without-cache for 15 minutes after ignored/timeout patterns.
              forceWithoutCacheUntilByDeviceKey.set(this.deviceKey, Date.now() + 15 * 60_000);
              (this as any).__bleDiag = {
                ...(this as any).__bleDiag,
                forceWithoutCacheUntil: forceWithoutCacheUntilByDeviceKey.get(this.deviceKey),
                lastForceWithoutCacheReason: msg,
                lastForceWithoutCacheAt: Date.now(),
              };
            }
            // Best-effort cleanup between attempts; helps when proxy gets stuck in an intermediate state.
            try {
              await this.connection.disconnectBluetoothDeviceService(this.address);
            } catch {}
            try {
              await (this.connection as any).clearBluetoothDeviceCacheService?.(this.address);
            } catch {}
            await new Promise((r) => setTimeout(r, 250));
          }
        }
        if (!response?.connected) throw lastError ?? new Error('ESPHome proxy connect failed (no response)');

        const connected = response?.connected === true;
        const errorCode = response?.error;
        const mtu = response?.mtu;

        logDebug(
          `[BLE] Proxy connect response for ${this.name} (${this.mac}): connected=${String(connected)} error=${String(
            errorCode
          )} mtu=${String(mtu)} addressType=${String(advAddressType)} usedWithoutCache=${String(
            usedWithoutCache
          )}`
        );

        // Remember successful non-default choices for next time (persisted).
        if (usedWithoutCache !== (pref.withoutCache === true)) {
          setConnectPref(this.deviceKey, { withoutCache: usedWithoutCache });
        }

        if (typeof errorCode === 'number' && errorCode !== 0) {
          logWarn(
            `[BLE] Proxy reported non-zero connect error for ${this.name} (${this.mac}) (error=${errorCode} mtu=${mtu})`
          );
        }

        // Only warn when proxy explicitly reports mtu=0 (ESP32 stack failure patterns).
        // If MTU is undefined (e.g. we treated "state: ESTABLISHED" as already connected),
        // do not warn.
        if (typeof mtu === 'number' && mtu === 0) {
          logWarn(
            `[BLE] Proxy reported mtu=0 for ${this.name} (${this.mac}) — treating as suspicious (ESP32 status=133/0x100 patterns)`
          );
          const until = Date.now() + 2_000;
          cooldownUntilByDeviceKey.set(this.deviceKey, until);
        }

        this.connected = true;
        // If we previously set a cooldown due to a hard failure, clear it on a successful connect.
        // This keeps diagnostics from showing stale cooldowns after recovery.
        cooldownUntilByDeviceKey.delete(this.deviceKey);
        const connectDurationMs = Date.now() - connectStartedAt;
        if (connectDurationMs > 8000) {
          // Slow connect: force without-cache for a while going forward.
          forceWithoutCacheUntilByDeviceKey.set(this.deviceKey, Date.now() + 15 * 60_000);
        }
        (this as any).__bleDiag = {
          ...(this as any).__bleDiag,
          deviceKey: this.deviceKey,
          proxyHost: this.connection.host,
          mac: this.mac,
          proxyMac,
          addressType: advAddressType,
          usedWithoutCache,
          mtu,
          errorCode,
          ignoredConnects: ignoredConnectsByDeviceKey.get(this.deviceKey) ?? this.ignoredConnectCount,
          cooldownUntil: cooldownUntilByDeviceKey.get(this.deviceKey) ?? 0,
          forceWithoutCacheUntil: forceWithoutCacheUntilByDeviceKey.get(this.deviceKey) ?? 0,
          connectDurationMs,
          lastConnectedAt: Date.now(),
        };
        logInfo(`[BLE] Successfully connected to device ${this.name} (${this.mac}) (mtu=${mtu ?? 'n/a'})`);
        if (this.paired) await this.pair();
      } catch (error: any) {
        const msg =
          error?.message ||
          (typeof error === 'string' ? error : '') ||
          (error?.code ? `code=${String(error.code)}` : '') ||
          String(error);
        // NOTE: pino doesn't reliably print "extra args" unless you use format specifiers.
        // Always include the message in the primary string so it shows up in HA add-on logs.
        logWarn(`[BLE] Failed to connect to device ${this.name} (${this.mac}): ${msg}`);
        // After failures that look like proxy/stack instability, temporarily force without-cache.
        const lowerMsg = String(msg).toLowerCase();
        if (
          lowerMsg.includes('proxy ignored connection request') ||
          lowerMsg.includes('timeout') ||
          lowerMsg.includes('status=133') ||
          lowerMsg.includes('0x100') ||
          lowerMsg.includes('gatt_busy')
        ) {
          forceWithoutCacheUntilByDeviceKey.set(this.deviceKey, Date.now() + 15 * 60_000);
        }
        const lower = String(msg).toLowerCase();
        if (
          lower.includes('status=133') ||
          lower.includes('0x100') ||
          lower.includes('gatt_busy') ||
          lower.includes('write after end') ||
          // Project memory: when the ESPHome API socket is dead, connect attempts can fail immediately.
          // Treat these as retryable so HealthMonitor can trip and force a reconnect.
          lower.includes('not connected') ||
          lower.includes('not authorized') ||
          lower.includes('socket is not connected')
        ) {
          const until = Date.now() + 3_000;
          cooldownUntilByDeviceKey.set(this.deviceKey, until);
          (this as any).__bleDiag = { ...(this as any).__bleDiag, cooldownUntil: until, lastHardFailureAt: Date.now(), lastError: msg };
        } else {
          (this as any).__bleDiag = { ...(this as any).__bleDiag, lastError: msg, lastFailedAt: Date.now() };
        }
        this.connected = false;
        throw error;
      } finally {
        (this as any).__bleDiag = { ...(this as any).__bleDiag, lastConnectAttemptEndedAt: Date.now() };
        // Clear the promise once connection succeeds or fails
        this.connectingPromise = null;
      }
    })();

    this.connectingPromise = connectPromise;
    connectInFlightByDeviceKey.set(this.deviceKey, connectPromise);
    try {
      return await connectPromise;
    } finally {
      const cur = connectInFlightByDeviceKey.get(this.deviceKey);
      if (cur === connectPromise) connectInFlightByDeviceKey.delete(this.deviceKey);
    }
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
        (this as any).__bleDiag = {
          ...(this as any).__bleDiag,
          lastServicesDurationMs: Date.now() - startedAt,
          lastServicesCount: servicesList.length,
          lastServicesAt: Date.now(),
        };
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
          const retry1StartedAt = Date.now();
          const retry1 = await this.connection.listBluetoothGATTServicesService(this.address);
          this.servicesList = retry1.servicesList;
          (this as any).__bleDiag = {
            ...(this as any).__bleDiag,
            lastServicesRetry1At: Date.now(),
            lastServicesRetry1DurationMs: Date.now() - retry1StartedAt,
            lastServicesCount: this.servicesList.length,
            lastServicesAt: Date.now(),
          };
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
            const retry2StartedAt = Date.now();
            const retry2 = await this.connection.listBluetoothGATTServicesService(this.address);
            this.servicesList = retry2.servicesList;
            (this as any).__bleDiag = {
              ...(this as any).__bleDiag,
              lastServicesProbeAt: Date.now(),
              lastServicesProbeDurationMs: Date.now() - retry2StartedAt,
              lastServicesCount: this.servicesList.length,
              lastServicesAt: Date.now(),
              lastServicesRecovered: this.servicesList.length > 0,
            };
            logWarn(
              `[BLE] GATT services after cache-clear probe for ${this.name} (${this.mac}) (services=${this.servicesList.length})`
            );
            if (this.servicesList.length > 0) {
              // If cache-clear + without-cache fixed discovery, prefer without-cache next time (persisted).
              setConnectPref(this.deviceKey, { withoutCache: true });
            }
          } catch (e: any) {
            logWarn(
              `[BLE] Cache-clear probe failed for ${this.name} (${this.mac})`,
              e?.message || String(e)
            );
            (this as any).__bleDiag = {
              ...(this as any).__bleDiag,
              lastServicesProbeError: e?.message || String(e),
              lastServicesRecovered: false,
            };
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
