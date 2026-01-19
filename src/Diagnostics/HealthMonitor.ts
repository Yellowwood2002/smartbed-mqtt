import { IMQTTConnection } from '@mqtt/IMQTTConnection';
import { safeId } from '@utils/safeId';
import { Deferred } from '@utils/deferred';
import { getUnixEpoch } from '@utils/getUnixEpoch';
import { isSocketOrBLETimeoutError } from '@utils/retryWithBackoff';
import { logInfo, logWarn } from '@utils/logger';

type RestartReason =
  | { kind: 'manual'; reason: string }
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

  private restartSignal = new Deferred<RestartReason>();
  private restartRequested = false;
  private restartReason?: RestartReason;

  private lastBleSuccessAt?: number;
  private consecutiveBleFailures = 0;
  private lastBleError?: BleErrorSnapshot;

  // If we see repeated retryable BLE/socket errors, request a reconnect.
  private readonly bleFailureTripCount = 3;

  init(mqtt: IMQTTConnection, type: string) {
    this.mqtt = mqtt;
    this.type = type;

    // Reset run state whenever we (re)initialize
    this.startedAt = Date.now();
    this.lastBleSuccessAt = undefined;
    this.consecutiveBleFailures = 0;
    this.lastBleError = undefined;
    this.resetRestartSignal();

    // Heartbeat every 30s
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.publishHeartbeat(), 30_000);
    // Publish one immediately
    this.publishHeartbeat();

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
      reason.kind === 'manual'
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
  }

  recordBleFailure(deviceName: string, error: any) {
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
        this.requestRestart({
          kind: 'ble',
          reason: `Repeated BLE/socket failures (${this.consecutiveBleFailures})`,
          deviceName,
          error: message,
        });
      }
    } else {
      // Non-retryable errors should not necessarily trigger restart logic
      this.consecutiveBleFailures = 0;
    }

    this.publishDeviceHealth(deviceName);
    this.publishHeartbeat();
  }

  private publishHeartbeat() {
    if (!this.mqtt) return;
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
}

export const healthMonitor = new HealthMonitor();

