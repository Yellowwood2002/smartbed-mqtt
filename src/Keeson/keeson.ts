import { IMQTTConnection } from '@mqtt/IMQTTConnection';
import { logError, logInfo, logWarn, logWarnDedup } from '@utils/logger';
import { retryWithBackoff, isSocketOrBLETimeoutError } from '@utils/retryWithBackoff';
import { setupDeviceInfoSensor } from 'BLE/setupDeviceInfoSensor';
import { buildMQTTDeviceData } from 'Common/buildMQTTDeviceData';
import { IESPConnection } from 'ESPHome/IESPConnection';
import { IBLEDevice } from 'ESPHome/types/IBLEDevice';
import { getDevices } from './options';
import { setupMassageButtons } from './setupMassageButtons';
import { setupPresetButtons } from './setupPresetButtons';
import { setupMotorEntities } from './setupMotorEntities';
import { isSupported as isKSBTSupported } from './KSBT/isSupported';
import { controllerBuilder as ksbtControllerBuilder } from './KSBT/controllerBuilder';
import { isSupported as isBaseI5Supported } from './BaseI5/isSupported';
import { controllerBuilder as baseI5ControllerBuilder } from './BaseI5/controllerBuilder';
import { isSupported as isBaseI4Supported } from './BaseI4/isSupported';
import { controllerBuilder as baseI4ControllerBuilder } from './BaseI4/controllerBuilder';

const checks = [isKSBTSupported, isBaseI5Supported, isBaseI4Supported];
const controllerBuilders = [ksbtControllerBuilder, baseI5ControllerBuilder, baseI4ControllerBuilder];

/**
 * Normalize user-provided identifiers into stable match keys.
 *
 * Why:
 * - Users commonly provide BLE MACs with colons (e.g. "D2:A3:..."), while ESPHome advertisements are
 *   matched using a 12-hex lowercase string (e.g. "d2a33c41a072").
 * - Some controllers advertise as "KSBT<hex>" while users configure just the hex, or vice-versa.
 *
 * How:
 * - Keep the original lowercased token.
 * - Additionally, if the token contains a 12-hex sequence, also add the extracted 12-hex form.
 */
const normalizeIdentifierKeys = (value: string): string[] => {
  const token = (value ?? '').trim().toLowerCase();
  if (!token) return [];

  const keys = new Set<string>();
  keys.add(token);

  // Extract just hex characters; if it's exactly 12, treat it as a MAC without separators.
  const hexOnly = token.replace(/[^0-9a-f]/g, '');
  if (hexOnly.length === 12) keys.add(hexOnly);

  // Also support cases where a prefix/suffix wraps the MAC-like portion (e.g. "ksbt04c0...").
  const m = hexOnly.match(/[0-9a-f]{12}/);
  if (m?.[0]) keys.add(m[0]);

  return [...keys];
};

const expandDeviceIdentifiers = (device: any): string[] => {
  const base = normalizeIdentifierKeys(device.name);
  const aliasesRaw = (device.aliases ?? '') as string;
  const aliasTokens = aliasesRaw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const aliases = aliasTokens.flatMap(normalizeIdentifierKeys);
  return [...new Set([...base, ...aliases])];
};

const connectToDevice = async (
  mqtt: IMQTTConnection,
  bleDevice: IBLEDevice,
  device: any,
  controllerBuilder: (deviceData: any, bleDevice: IBLEDevice, stayConnected?: boolean) => Promise<any>
): Promise<void> => {
  const { name, mac: _mac, connect, disconnect, getDeviceInfo } = bleDevice;
  /**
   * Stable identity (project memory):
   *
   * Why:
   * - Some beds expose multiple linked BLE controllers (two MACs / two KSBT names) that can both control the bed.
   * - If we use the *current* BLE address for MQTT discovery topics, HA may see duplicated discovery configs
   *   over time as the add-on "chooses" the other controller after a reconnect.
   *
   * How:
   * - Derive a stable ID from the configured `device.name` (prefer 12-hex MAC without separators, else the token).
   * - Publish HA discovery under that stable topic, but still keep the *runtime* BLE numeric address attached
   *   to the controller for actual BLE operations.
   */
  const configuredKeys = expandDeviceIdentifiers(device);
  const stableId =
    configuredKeys.find((k) => k.replace(/[^0-9a-f]/g, '').length === 12) ??
    (device.name ?? '').toString().trim().toLowerCase();
  const deviceData = buildMQTTDeviceData(
    {
      ...device,
      // Stable identifier for MQTT discovery topics (do NOT use runtime BLE address here).
      address: stableId,
      // HA device IDs: include stable id + all configured identifiers + runtime mac (best effort).
      ids: [...new Set([stableId, ...configuredKeys, bleDevice.mac])],
    },
    'Keeson'
  );
  const stayConnected = device.stayConnected ?? false;

  // CRITICAL: Use try/finally to ensure cleanup happens even on errors
  try {
    await connect();

    const controller = await controllerBuilder(deviceData, bleDevice, stayConnected);
    if (!controller) {
      // Cleanup on failure - only disconnect if not staying connected
      if (!stayConnected) {
        await disconnect();
      }
      throw new Error(`Failed to build controller for device ${name}`);
    }

    logInfo('[Keeson] Setting up entities for device:', name);
    setupPresetButtons(mqtt, controller);
    setupMassageButtons(mqtt, controller);
    setupMotorEntities(mqtt, controller);

    try {
      const deviceInfo = await getDeviceInfo();
      if (deviceInfo) setupDeviceInfoSensor(mqtt, controller, deviceInfo);
    } catch (error: any) {
      logWarn(`[Keeson] Failed to get device info for ${name}, continuing anyway:`, error?.message || error);
    }

    // Respect stayConnected flag - don't disconnect if it's true
    if (!stayConnected) {
      await disconnect();
    }

    // Success - device is connected and set up
    return;
  } catch (error: any) {
    // Ensure cleanup on any error - only disconnect if not staying connected
    if (!stayConnected) {
      try {
        await disconnect();
      } catch (_disconnectError) {
        // Ignore disconnect errors - device may already be disconnected
      }
    }
    
    // Re-throw the error so retry logic can handle it
    throw error;
  }
};

const isGattServicesTimeout = (error: any): boolean => {
  const msg = (error?.message || String(error)).toLowerCase();
  return msg.includes('gatt') && msg.includes('services') && msg.includes('timeout') ||
    msg.includes('bluetoothgattgetservicesdoneresponse') ||
    msg.includes('ble timeout');
};

const setupDeviceWithRetry = async (
  mqtt: IMQTTConnection,
  _esphome: IESPConnection,
  candidates: IBLEDevice[],
  device: any,
  controllerBuilder: (deviceData: any, bleDevice: IBLEDevice) => Promise<any>
): Promise<void> => {
  const primary = candidates[0];
  const bedName = device?.friendlyName ?? primary?.name ?? 'unknown';

  /**
   * Failover strategy (project memory):
   * Some Keeson/Purple installations expose two linked controllers (two MACs) that can *both*
   * control the same bed. In the field, one can be flakier than the other (RSSI, placement, firmware).
   *
   * If we get stuck in "Timeout getting services" for the chosen controller, try the other controller
   * before backing off/retrying the whole setup loop. This reduces the need to restart the add-on.
   */
  await retryWithBackoff(
    async () => {
      let lastError: any;
      for (const bleDevice of candidates) {
        const { name, mac } = bleDevice;
        try {
          await connectToDevice(mqtt, bleDevice, device, controllerBuilder);
          logInfo(`[Keeson] Successfully connected to '${bedName}' via ${name} (${mac})`);
          return;
        } catch (error: any) {
          lastError = error;
          const msg = error?.message || String(error);
          // If this smells like a GATT/services timeout, try the next candidate controller immediately.
          if (isGattServicesTimeout(error)) {
            logWarn(`[Keeson] GATT/services timeout on ${name} (${mac}); trying next linked controller if available...`, msg);
            continue;
          }
          // Other errors: still allow failover once (linked controllers can recover intermittent connect issues),
          // but log it clearly so we can diagnose patterns.
          logWarn(`[Keeson] Failed connecting via ${name} (${mac}); trying next linked controller if available...`, msg);
        }
      }
      throw lastError ?? new Error(`Failed to connect to '${bedName}' (no candidates)`);
    },
    {
      maxRetries: undefined,
      initialDelayMs: 5000,
      maxDelayMs: 30000,
      backoffMultiplier: 1.5,
      // Keep retrying on socket/BLE transient errors. GATT/services timeouts are handled via failover above,
      // but are still retryable at the outer layer too.
      isRetryableError: (e: any) => isSocketOrBLETimeoutError(e) || isGattServicesTimeout(e),
      onRetry: (error: any, attempt: number, delayMs: number) => {
        const errorMessage = error?.message || String(error);
        logWarn(
          `[Keeson] Setup attempt ${attempt} failed for '${bedName}', retrying in ${delayMs / 1000}s:`,
          errorMessage
        );
      },
    }
  );
};

export const keeson = async (mqtt: IMQTTConnection, esphome: IESPConnection): Promise<void> => {
  const devices = getDevices();
  if (!devices.length) return logInfo('[Keeson] No devices configured');

  /**
   * Device mapping strategy (project memory):
   *
   * Why:
   * - Entity unique_id is based on `friendlyName`, so configuring two entries for two linked MACs
   *   will create duplicate entities and unstable behavior.
   * - We therefore allow one "logical bed" config entry to match multiple BLE identifiers via `aliases`.
   *
   * How:
   * - Build a dictionary of identifier -> device config, where identifier is normalized (colon MACs, KSBT prefixes, etc.).
   * - Validate that no identifier maps to two different config entries.
   */
  const devicesMap: Record<string, any> = {};
  for (const device of devices) {
    for (const key of expandDeviceIdentifiers(device)) {
      const existing = devicesMap[key];
      if (existing && existing !== device) {
        return logError(`[Keeson] Duplicate/overlapping identifier detected in configuration: ${key}`);
      }
      devicesMap[key] = device;
    }
  }
  const deviceNames = Object.keys(devicesMap);

  // Note: `deviceNames.length` can be > `devices.length` because a single device can have aliases.

  /**
   * Discovery backoff (project memory)
   *
   * Why:
   * - When the bed/controller is asleep or out of range, discovery often fails repeatedly.
   * - Throwing immediately caused a tight retry loop in the main setup, spamming logs.
   *
   * How:
   * - Keep retrying discovery *inside* Keeson setup with exponential backoff and rate-limited logs.
   * - This is safer for long-term operation and keeps HA logs readable.
   */
  const bleDevices = await retryWithBackoff(
    async () => {
      // Keeson/Purple controllers commonly advertise names with null padding; normalize it.
      const found = await esphome.getBLEDevices(deviceNames, (name) => name?.replace(/\0/g, ''));
      if (found.length === 0) throw new Error('No Keeson BLE devices discovered');
      return found;
    },
    {
      maxRetries: undefined, // Keep trying until the bed is awake / in range.
      initialDelayMs: 10_000,
      maxDelayMs: 120_000,
      backoffMultiplier: 1.5,
      // Discovery failures are effectively retryable; allow socket/BLE transient errors too.
      isRetryableError: () => true,
      onRetry: (_error: any, attempt: number, delayMs: number) => {
        const key = `keeson:discover:${deviceNames.sort().join(',')}`;
        logWarnDedup(
          key,
          60_000,
          `[Keeson] No BLE devices discovered for: ${deviceNames.join(', ')} (attempt ${attempt}, retry in ${Math.round(
            delayMs / 1000
          )}s)`
        );
      },
    }
  );
  const setupPromises: Promise<void>[] = [];

  /**
   * Deduplicate multiple discovered controllers that map to the same logical bed.
   *
   * Why:
   * - Your bed advertises two linked controllers (two MACs / two KSBT names) that can both control the bed.
   * - If we set up both, we will publish duplicate HA entities for the same physical bed and create command races.
   *
   * How:
   * - Group discovered BLE devices by the config entry they map to.
   * - Select the "best" candidate for setup using RSSI (higher is better, e.g. -73 > -90).
   * - Log which one we chose so failures are diagnosable.
   */
  const grouped = new Map<any, IBLEDevice[]>();
  for (const bleDevice of bleDevices) {
    const { name, mac } = bleDevice;
    const macKeys = normalizeIdentifierKeys(mac);
    const nameKeys = normalizeIdentifierKeys(name);
    const device =
      macKeys.map((k) => devicesMap[k]).find(Boolean) || nameKeys.map((k) => devicesMap[k]).find(Boolean);

    if (!device) {
      logInfo(`[Keeson] Device not found in configuration for MAC: ${mac} or Name: ${name}`);
      continue;
    }
    const list = grouped.get(device) ?? [];
    list.push(bleDevice);
    grouped.set(device, list);
  }

  for (const [device, candidates] of grouped.entries()) {
    // Pick the strongest RSSI candidate; if RSSI missing, treat as very weak.
    const sorted = [...candidates].sort((a, b) => (b.advertisement?.rssi ?? -999) - (a.advertisement?.rssi ?? -999));
    const chosen = sorted[0];
    const fallback = sorted[1];

    if (fallback) {
      logInfo(
        `[Keeson] Multiple controllers discovered for '${device.friendlyName}'. Choosing ${chosen.name} (${chosen.mac}) rssi=${chosen.advertisement?.rssi}, ignoring ${fallback.name} (${fallback.mac}) rssi=${fallback.advertisement?.rssi}`
      );
    } else {
      logInfo(
        `[Keeson] Controller selected for '${device.friendlyName}': ${chosen.name} (${chosen.mac}) rssi=${chosen.advertisement?.rssi}`
      );
    }

    const controllerBuilder = checks
      .map((check, index) => (check(chosen) ? controllerBuilders[index] : undefined))
      .filter((check) => check)[0];

    if (controllerBuilder === undefined) {
      const {
        advertisement: { manufacturerDataList, serviceUuidsList },
      } = chosen;
      logWarn(
        '[Keeson] Device not supported, please contact me on Discord',
        chosen.name,
        JSON.stringify({ name: chosen.name, address: chosen.address, manufacturerDataList, serviceUuidsList })
      );
      continue;
    }

    // Setup each logical bed in parallel with retry logic + linked-controller failover
    setupPromises.push(setupDeviceWithRetry(mqtt, esphome, sorted, device, controllerBuilder));
  }

  // Wait for all devices to be set up (they will retry forever if needed)
  await Promise.all(setupPromises);
};
