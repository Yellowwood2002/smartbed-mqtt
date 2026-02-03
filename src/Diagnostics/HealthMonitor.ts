import { IMQTTConnection } from '@mqtt/IMQTTConnection';
import { safeId } from '@utils/safeId';
import { Deferred } from '@utils/deferred';
import { getUnixEpoch } from '@utils/getUnixEpoch';
import { isSocketOrBLETimeoutError } from '@utils/retryWithBackoff';
import { logInfo, logWarn } from '@utils/logger';
import { getRootOptions } from '@utils/options';

type RestartReason =
  | { kind: 'manual'; reason: string }
  | { kind: 'maintenance'; reason: string }
  | { kind: 'ble'; reason: string; deviceName?: string; error?: string };

type BleErrorSnapshot = {
  at: number;
  deviceName?: string;
  message: string;
  retryable: boolean;
};

/**
 * Central health/diagnostics hub.
 *
 * Why this exists:
 * - Many entity handlers catch/log BLE errors, which prevents outer retry loops from running.
 * - This monitor can publish telemetry to MQTT and request a controlled reconnect when BLE
 *   connectivity is clearly broken.
 */
class HealthMonitor {
  private mqtt?: IMQTTConnection;
  private type?: string;

  private startedAt = Date.now();
  private heartbeatTimer?: NodeJS.Timeout;
  private maintenanceTimer?: NodeJS.Timeout;

  private restartSignal = new Deferred<RestartReason>();
  private restartRequested = false;
  private restartReason?: RestartReason;

  private lastBleSuccessAt?: number;
  private consecutiveBleFailures = 0;
  private lastBleError?: BleErrorSnapshot;

  private lastCommandAt?: number;
  private lastCommandDeviceName?: string;
  private lastCommandName?: string;
  
  private proxyStatus = new Map<string, any>();
  private proxyRebootCooldownUntilByHost = new Map<string, number>();

  // Safety: don't hammer a relay/proxy reboot repeatedly if the scanner is wedged.
  // Keep this fairly long; the proxy needs time to fully reboot and start scanning again.
  private readonly proxyRebootCooldownMs = 10 * 60_000; // 10 minutes

  // If we see repeated retryable BLE/socket errors, request a reconnect.
  private readonly bleFailureTripCount = 3;

  // Maintenance reconnect policy (project memory):
  // Some BLE stacks degrade over long uptimes even if the device is used infrequently.
  // A controlled reconnect after a long idle period is a common industrial uptime strategy.
  private readonly maintenanceCheckIntervalMs = 5 * 60_000; // 5 minutes
  private readonly maintenanceIdleMs = 12 * 60 * 60_000; // 12 hours since last command
  private readonly maintenanceMinUptimeMs = 30 * 60_000; // don't thrash immediately after startup

  init(mqtt: IMQTTConnection, type: string) {
    this.mqtt = mqtt;
    this.type = type;

    // Reset run state whenever we (re)initialize
    this.startedAt = Date.now();
    this.lastBleSuccessAt = undefined;
    this.consecutiveBleFailures = 0;
    this.lastBleError = undefined;
    this.lastCommandAt = undefined;
    this.lastCommandDeviceName = undefined;
    this.lastCommandName = undefined;
    this.resetRestartSignal();

    // Heartbeat every 30s
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.publishHeartbeat(), 30_000);
    // Publish one immediately
    this.publishHeartbeat();
    this.publishDegradedState();

    // Maintenance check
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = setInterval(() => this.maybeRequestMaintenanceRestart(), this.maintenanceCheckIntervalMs);
    
    const { bleProxies } = getRootOptions();
    if (bleProxies) {
      for (const proxy of bleProxies) {
        const topic = `smartbed-mqtt/proxy/${proxy.host}/status`;
        mqtt.subscribe(topic);
        mqtt.on(topic, (message: string) => {
          try {
            const status = JSON.parse(message);
            this.proxyStatus.set(proxy.host, status);
          } catch (e) {
            const msg = (e as any)?.message || String(e);
            logWarn(`[Health] Error parsing proxy status for ${proxy.host}: ${msg}`);
          }
        });
      }
    }

    logInfo(`[Health] Initialized for type=${type}`);
  }

  /**
   * Await this after successful setup. When a restart is requested (e.g. repeated BLE failures),
   * this promise resolves and you should trigger reconnection logic.
   */
  async waitForRestartRequest(): Promise<RestartReason> {
    return await this.restartSignal;
  }

  resetRestartSignal() {
    this.restartRequested = false;
    this.restartReason = undefined;
    this.restartSignal = new Deferred<RestartReason>();
  }

  requestRestart(reason: RestartReason) {
    if (this.restartRequested) return;
    this.restartRequested = true;
    this.restartReason = reason;

    const msg =
      reason.kind === 'manual' || reason.kind === 'maintenance'
        ? reason.reason
        : `${reason.reason}${reason.deviceName ? ` (device=${reason.deviceName})` : ''}${
            reason.error ? `: ${reason.error}` : ''
          }`;

    logWarn(`[Health] Restart requested: ${msg}`);
    this.publishHeartbeat(); // snapshot immediately at failure point

    this.restartSignal.resolve(reason);
  }

  recordBleSuccess(deviceName: string) {
    this.lastBleSuccessAt = Date.now();
    this.consecutiveBleFailures = 0;
    this.lastBleError = undefined;

    this.publishDeviceHealth(deviceName);
    this.publishDegradedState();
  }

  recordBleFailure(deviceName: string, error: any, proxyHost?: string) {
    const message = error?.message || String(error);
    const retryable = isSocketOrBLETimeoutError(error);

    this.lastBleError = {
      at: Date.now(),
      deviceName,
      message,
      retryable,
    };

    if (retryable) {
      this.consecutiveBleFailures += 1;
      if (this.consecutiveBleFailures >= this.bleFailureTripCount) {
        if (proxyHost) {
          logWarn(`[Health] Requesting reboot of proxy ${proxyHost} due to repeated BLE failures.`);
          this.requestProxyReboot(proxyHost);
          // Also force a SmartbedMQTT reconnect so we drop/recreate the ESPHome API session.
          // Otherwise we can stay wedged even after the proxy power-cycle.
          this.requestRestart({
            kind: 'ble',
            reason: `Proxy reboot requested after repeated BLE/socket failures (${this.consecutiveBleFailures})`,
            deviceName,
            error: message,
          });
          this.consecutiveBleFailures = 0; // Reset after escalating
        } else {
          this.requestRestart({
            kind: 'ble',
            reason: `Repeated BLE/socket failures (${this.consecutiveBleFailures})`,
            deviceName,
            error: message,
          });
        }
      }
    } else {
      // Non-retryable errors should not necessarily trigger restart logic
      this.consecutiveBleFailures = 0;
    }

    this.publishDeviceHealth(deviceName);
    this.publishHeartbeat();
    this.publishDegradedState();
  }

  requestProxyReboot(proxyHost: string) {
    if (!this.mqtt) return;
    const now = Date.now();
    const cooldownUntil = this.proxyRebootCooldownUntilByHost.get(proxyHost) ?? 0;
    if (cooldownUntil > now) {
      const remainingSec = Math.ceil((cooldownUntil - now) / 1000);
      logWarn(`[Health] Proxy reboot suppressed by cooldown for ${proxyHost} (retry in ~${remainingSec}s)`);
      // Breadcrumb topic (safe namespace) so HA can display that we *wanted* to reboot.
      try {
        this.mqtt.publish(`smartbedmqtt/proxy/${proxyHost}/reboot_suppressed`, {
          ts: getUnixEpoch(),
          host: proxyHost,
          cooldownRemainingSec: remainingSec,
        });
      } catch {}
      return;
    }

    const topic = `smartbed-mqtt/proxy/${proxyHost}/command`;
    this.mqtt.publish(topic, 'REBOOT');
    this.proxyRebootCooldownUntilByHost.set(proxyHost, now + this.proxyRebootCooldownMs);

    // Breadcrumb (safe namespace) so you can prove the add-on requested the reboot.
    // This does NOT affect other MQTT processes.
    try {
      this.mqtt.publish(`smartbedmqtt/proxy/${proxyHost}/reboot_requested`, {
        ts: getUnixEpoch(),
        host: proxyHost,
      });
    } catch {}
  }

  /**
   * Record that we attempted to execute a command.
   *
   * Project memory:
   * - We use this for idle-based "maintenance reconnect" decisions.
   * - This is NOT a guarantee the bed moved; it's a best-effort marker for operator visibility.
   */
  recordCommand(deviceName: string, commandName?: string) {
    this.lastCommandAt = Date.now();
    this.lastCommandDeviceName = deviceName;
    this.lastCommandName = commandName;
    this.publishHeartbeat();
  }

  private isDegraded(): boolean {
    return this.consecutiveBleFailures > 0 || this.restartRequested;
  }

  private publishDegradedState() {
    if (!this.mqtt) return;
    this.mqtt.publish('smartbedmqtt/status/degraded', this.isDegraded() ? 'true' : 'false', {
      qos: 1,
      retain: true,
    });
  }

  private publishHeartbeat() {
    if (!this.mqtt) return;
    const proxyStatus = Object.fromEntries(this.proxyStatus);
    const payload = {
      type: this.type,
      ts: getUnixEpoch(),
      startedAt: Math.floor(this.startedAt / 1000),
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      ble: {
        lastSuccessAt: this.lastBleSuccessAt ? Math.floor(this.lastBleSuccessAt / 1000) : null,
        consecutiveFailures: this.consecutiveBleFailures,
        lastError: this.lastBleError
          ? {
              at: Math.floor(this.lastBleError.at / 1000),
              deviceName: this.lastBleError.deviceName,
              message: this.lastBleError.message,
              retryable: this.lastBleError.retryable,
            }
          : null,
      },
      commands: {
        lastCommandAt: this.lastCommandAt ? Math.floor(this.lastCommandAt / 1000) : null,
        lastCommandDeviceName: this.lastCommandDeviceName ?? null,
        lastCommandName: this.lastCommandName ?? null,
      },
      proxyStatus,
      degraded: this.isDegraded(),
      restart: this.restartReason ? this.restartReason : null,
    };

    this.mqtt.publish('smartbedmqtt/health', payload);
  }

  private publishDeviceHealth(deviceName: string) {
    if (!this.mqtt) return;
    const topic = `smartbedmqtt/health/${safeId(deviceName)}`;
    const payload = {
      type: this.type,
      ts: getUnixEpoch(),
      deviceName,
      ble: {
        lastSuccessAt: this.lastBleSuccessAt ? Math.floor(this.lastBleSuccessAt / 1000) : null,
        consecutiveFailures: this.consecutiveBleFailures,
        lastError: this.lastBleError
          ? {
              at: Math.floor(this.lastBleError.at / 1000),
              message: this.lastBleError.message,
              retryable: this.lastBleError.retryable,
            }
          : null,
      },
    };

    this.mqtt.publish(topic, payload);
  }

  private maybeRequestMaintenanceRestart() {
    if (this.restartRequested) return;
    if (!this.lastCommandAt) return;
    const now = Date.now();
    if (now - this.startedAt < this.maintenanceMinUptimeMs) return;
    if (now - this.lastCommandAt < this.maintenanceIdleMs) return;

    const idleHours = Math.floor((now - this.lastCommandAt) / (60 * 60_000));
    this.requestRestart({
      kind: 'maintenance',
      reason: `Maintenance reconnect after ${idleHours}h idle`,
    });
  }
}

export const healthMonitor = new HealthMonitor();

