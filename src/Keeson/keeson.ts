import { IMQTTConnection } from '@mqtt/IMQTTConnection';
import { JsonSensor } from '@ha/JsonSensor';
import { logDebug, logError, logInfo, logWarn, logWarnDedup } from '@utils/logger';
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
import { readFileSync, writeFileSync } from 'fs';

const checks = [isKSBTSupported, isBaseI5Supported, isBaseI4Supported];
const controllerBuilders = [ksbtControllerBuilder, baseI5ControllerBuilder, baseI4ControllerBuilder];

// Persist per-bed controller preference (success/failure based, not just RSSI).
const CONTROLLER_PREFS_PATH = '/data/smartbedmqtt-keeson-controller-preferences.json';
type ControllerStats = {
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: string;
  recentFailureAts?: number[]; // rolling timestamps (ms) for last 24h
};
type BedPref = {
  _meta?: {
    pinnedController?: string; // controllerKey
  };
  controllers: Record<string, ControllerStats>;
};
type ControllerPrefsFile = Record<string, BedPref>;
let controllerPrefsLoaded = false;
let controllerPrefs: ControllerPrefsFile = {};

const ensureControllerPrefsLoaded = () => {
  if (controllerPrefsLoaded) return;
  controllerPrefsLoaded = true;
  try {
    const raw = readFileSync(CONTROLLER_PREFS_PATH, 'utf8');
    const json = JSON.parse(raw);
    if (json && typeof json === 'object') {
      // Backward compatible: older format was bedKey -> controllerKey -> stats
      const normalized: ControllerPrefsFile = {};
      for (const [bedKey, v] of Object.entries(json as any)) {
        if (!v || typeof v !== 'object') continue;
        if ((v as any).controllers && typeof (v as any).controllers === 'object') {
          normalized[bedKey] = v as any;
          continue;
        }
        normalized[bedKey] = { controllers: v as any };
      }
      controllerPrefs = normalized;
    }
    logDebug(`[Keeson] Loaded controller prefs from ${CONTROLLER_PREFS_PATH}`);
  } catch {
    // ok
  }
};

const persistControllerPrefsNow = () => {
  try {
    writeFileSync(CONTROLLER_PREFS_PATH, JSON.stringify(controllerPrefs, null, 2), 'utf8');
  } catch {
    // ok
  }
};

const controllerKeyFor = (macOrToken: string): string => {
  // Prefer 12-hex stable MAC representation when possible
  const keys = normalizeIdentifierKeys(macOrToken);
  const mac12 = keys.find((k) => k.replace(/[^0-9a-f]/g, '').length === 12);
  return (mac12 ?? keys[0] ?? macOrToken).replace(/[^0-9a-f]/g, '').toLowerCase() || String(macOrToken).toLowerCase();
};

const stableBedKeyFor = (device: any): string => {
  const configuredKeys = expandDeviceIdentifiers(device);
  return (
    configuredKeys.find((k) => k.replace(/[^0-9a-f]/g, '').length === 12) ??
    (device.name ?? '').toString().trim().toLowerCase()
  );
};

const getControllerStats = (bedKey: string, controllerKey: string): ControllerStats => {
  ensureControllerPrefsLoaded();
  controllerPrefs[bedKey] = controllerPrefs[bedKey] || { controllers: {} };
  controllerPrefs[bedKey].controllers[controllerKey] = controllerPrefs[bedKey].controllers[controllerKey] || {
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
  };
  return controllerPrefs[bedKey].controllers[controllerKey];
};

const recordControllerSuccess = (bedKey: string, controllerMac: string) => {
  const key = controllerKeyFor(controllerMac);
  const stats = getControllerStats(bedKey, key);
  stats.successes += 1;
  stats.consecutiveFailures = 0;
  stats.lastSuccessAt = Date.now();
  // Pin this controller as the "sticky" winner until it fails consecutively.
  controllerPrefs[bedKey] = controllerPrefs[bedKey] || { controllers: {} };
  controllerPrefs[bedKey]._meta = controllerPrefs[bedKey]._meta || {};
  controllerPrefs[bedKey]._meta!.pinnedController = key;
  persistControllerPrefsNow();
};

const recordControllerFailure = (bedKey: string, controllerMac: string, error: any) => {
  const key = controllerKeyFor(controllerMac);
  const stats = getControllerStats(bedKey, key);
  stats.failures += 1;
  stats.consecutiveFailures += 1;
  stats.lastFailureAt = Date.now();
  stats.lastError = (error?.message || String(error)).slice(0, 500);
  // rolling 24h window for failures
  const now = Date.now();
  const windowMs = 24 * 60 * 60 * 1000;
  stats.recentFailureAts = (stats.recentFailureAts || []).filter((t) => now - t < windowMs);
  stats.recentFailureAts.push(now);
  persistControllerPrefsNow();
};

const getPinnedControllerKey = (bedKey: string): string | undefined => {
  ensureControllerPrefsLoaded();
  return controllerPrefs[bedKey]?._meta?.pinnedController;
};

const getRecentFailureCounts = (stats: ControllerStats) => {
  const now = Date.now();
  const arr = stats.recentFailureAts || [];
  const last1h = arr.filter((t) => now - t < 60 * 60 * 1000).length;
  const last24h = arr.filter((t) => now - t < 24 * 60 * 60 * 1000).length;
  return { last1h, last24h };
};

const scoreController = (bedKey: string, bleDevice: IBLEDevice): number => {
  const rssi = bleDevice.advertisement?.rssi ?? -999;
  const stats = getControllerStats(bedKey, controllerKeyFor(bleDevice.mac));
  const now = Date.now();
  let score = rssi;
  // If it worked recently, strongly prefer it (RSSI is noisy).
  if (stats.lastSuccessAt) {
    const ageMs = now - stats.lastSuccessAt;
    if (ageMs < 6 * 60 * 60 * 1000) score += 60;
    else if (ageMs < 24 * 60 * 60 * 1000) score += 25;
  }
  // Penalize consecutive failures heavily.
  if (stats.consecutiveFailures > 0) score -= Math.min(90, stats.consecutiveFailures * 30);
  // Slight penalty if it's generally failing more than succeeding.
  if (stats.failures > stats.successes + 2) score -= 15;
  // Penalize frequent recent failures
  const recent = getRecentFailureCounts(stats);
  score -= Math.min(40, recent.last1h * 10);
  return score;
};

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
  const bedKey = stableBedKeyFor(device);

  // Diagnostics sensor (HA entity_category=diagnostic)
  const configuredKeys = expandDeviceIdentifiers(device);
  const stableId = bedKey;
  const deviceData = buildMQTTDeviceData(
    {
      ...device,
      address: stableId,
      ids: [...new Set([stableId, ...configuredKeys, primary?.mac].filter(Boolean))],
    },
    'Keeson'
  );
  const diag = new JsonSensor<any>(mqtt, deviceData, {
    description: 'BLE Diagnostics',
    category: 'diagnostic',
    icon: 'mdi:bluetooth',
    valueField: 'status',
  });

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
          diag.setState({
            status: 'connecting',
            bed: bedName,
            bedKey,
            pinnedController: getPinnedControllerKey(bedKey) ?? null,
            attempting: { name, mac, rssi: bleDevice.advertisement?.rssi },
            order: candidates.map((c) => ({
              name: c.name,
              mac: c.mac,
              rssi: c.advertisement?.rssi,
              score: scoreController(bedKey, c),
              stats: getControllerStats(bedKey, controllerKeyFor(c.mac)),
            })),
          });
          await connectToDevice(mqtt, bleDevice, device, controllerBuilder);
          logInfo(`[Keeson] Successfully connected to '${bedName}' via ${name} (${mac})`);
          recordControllerSuccess(bedKey, mac);
          diag.setState({
            status: 'connected',
            bed: bedName,
            bedKey,
            pinnedController: getPinnedControllerKey(bedKey) ?? null,
            connectedVia: { name, mac, rssi: bleDevice.advertisement?.rssi },
            ble: (bleDevice as any).__bleDiag,
            controllerStats: getControllerStats(bedKey, controllerKeyFor(mac)),
            controllerFailures: getRecentFailureCounts(getControllerStats(bedKey, controllerKeyFor(mac))),
          });
          return;
        } catch (error: any) {
          lastError = error;
          const msg = error?.message || String(error);
          recordControllerFailure(bedKey, mac, error);
          diag.setState({
            status: 'failed',
            bed: bedName,
            bedKey,
            pinnedController: getPinnedControllerKey(bedKey) ?? null,
            failedVia: { name, mac, rssi: bleDevice.advertisement?.rssi },
            error: msg,
            ble: (bleDevice as any).__bleDiag,
            controllerStats: getControllerStats(bedKey, controllerKeyFor(mac)),
            controllerFailures: getRecentFailureCounts(getControllerStats(bedKey, controllerKeyFor(mac))),
          });
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
    const bedKey = stableBedKeyFor(device);
    // Order candidates by success/failure history first, RSSI second.
    const scored = [...candidates]
      .map((c) => ({ c, score: scoreController(bedKey, c), key: controllerKeyFor(c.mac) }))
      .sort((a, b) => b.score - a.score);

    // Sticky selection: if a pinned controller exists and hasn't failed twice consecutively, prefer it.
    const pinnedKey = getPinnedControllerKey(bedKey);
    const pinnedCandidate =
      pinnedKey ? scored.find((x) => x.key === pinnedKey && getControllerStats(bedKey, x.key).consecutiveFailures < 2) : undefined;

    const sorted = (pinnedCandidate
      ? [pinnedCandidate, ...scored.filter((x) => x !== pinnedCandidate)]
      : scored
    ).map((x) => x.c);

    const chosen = sorted[0];
    const fallback = sorted[1];

    if (fallback) {
      logInfo(
        `[Keeson] Multiple controllers discovered for '${device.friendlyName}'. Choosing ${chosen.name} (${chosen.mac}) ` +
          `rssi=${chosen.advertisement?.rssi} score=${scoreController(bedKey, chosen)}; ` +
          `next=${fallback.name} (${fallback.mac}) rssi=${fallback.advertisement?.rssi} score=${scoreController(
            bedKey,
            fallback
          )}`
      );
    } else {
      logInfo(
        `[Keeson] Controller selected for '${device.friendlyName}': ${chosen.name} (${chosen.mac}) ` +
          `rssi=${chosen.advertisement?.rssi} score=${scoreController(bedKey, chosen)}`
      );
    }

    // Pick a controller builder based on the *first supported* candidate (sometimes the "chosen" MAC is asleep
    // but the other linked controller is awake and still identifies the same model).
    const supportedCandidate = sorted.find((c) => checks.some((check) => check(c))) ?? chosen;
    const controllerBuilder = checks
      .map((check, index) => (check(supportedCandidate) ? controllerBuilders[index] : undefined))
      .filter((check) => check)[0];

    if (controllerBuilder === undefined) {
      const {
        advertisement: { manufacturerDataList, serviceUuidsList },
      } = supportedCandidate;
      logWarn(
        '[Keeson] Device not supported, please contact me on Discord',
        supportedCandidate.name,
        JSON.stringify({
          name: supportedCandidate.name,
          address: supportedCandidate.address,
          manufacturerDataList,
          serviceUuidsList,
        })
      );
      continue;
    }

    // Setup each logical bed in parallel with retry logic + linked-controller failover
    setupPromises.push(setupDeviceWithRetry(mqtt, esphome, sorted, device, controllerBuilder));
  }

  // Wait for all devices to be set up (they will retry forever if needed)
  await Promise.all(setupPromises);
};
