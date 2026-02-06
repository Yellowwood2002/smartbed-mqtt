import { IDeviceData } from '@ha/IDeviceData';
import { Dictionary } from '@utils/Dictionary';
import { Timer } from '@utils/Timer';
import { loopWithWait } from '@utils/loopWithWait';
import { IBLEDevice } from 'ESPHome/types/IBLEDevice';
import EventEmitter from 'events';
import { IController } from '../Common/IController';
import { IEventSource } from '../Common/IEventSource';
import { arrayEquals } from '@utils/arrayEquals';
import { deepArrayEquals } from '@utils/deepArrayEquals';
import { logError, logInfo, logWarn } from '@utils/logger';
import { healthMonitor } from 'Diagnostics/HealthMonitor';
import { isSocketOrBLETimeoutError } from '@utils/retryWithBackoff';
import { wait } from '@utils/wait';

export class BLEController<TCommand> extends EventEmitter implements IEventSource, IController<TCommand> {
  cache: Dictionary<Object> = {};
  get notifyNames() {
    return Object.keys(this.notifyHandles);
  }
  private timer?: Timer;
  private notifyValues: Dictionary<Uint8Array> = {};
  private disconnectTimeout?: NodeJS.Timeout;
  private lastCommands?: number[][];
  private connectMutex: Promise<void> | null = null;
  private commandQueue: Promise<void> = Promise.resolve();

    constructor(
      public deviceData: IDeviceData,
      private bleDevice: IBLEDevice,
      private handle: number,
      private commandBuilder: (command: TCommand) => number[],
      private notifyHandles: Dictionary<number> = {},
      private stayConnected: boolean = false,
      public proxyHost?: string
    ) {
      super();
      Object.entries(notifyHandles).forEach(([key, handle]) => {
        this.stayConnected ||= true;
        void this.bleDevice.subscribeToCharacteristic(handle, (data) => {
          const previous = this.notifyValues[key];
          if (previous && arrayEquals(data, previous)) return;
          this.emit(key, data);
        });
      });
    }
  
    private disconnect = async () => {
      try {
        await this.bleDevice.disconnect();
        logInfo(`[BLE] Successfully disconnected from device ${this.deviceData.device.name}`);
      } catch (error: any) {
        // Don't log as error - disconnect failures are often harmless (device already disconnected)
        // Only log if it's not a "Not connected" error
        const errorMessage = error?.message || String(error);
        if (!errorMessage.includes('Not connected') && !errorMessage.includes('not connected')) {
          logError(`[BLE] Error disconnecting from device ${this.deviceData.device.name}:`, errorMessage);
        }
      }
    };
  
    /**
     * Determine whether an error is likely transient and worth a fast reconnect+retry.
     * 
     * Real-world behavior (project memory):
     * - ESPHome BLE proxy sometimes returns transient socket errors (ECONNRESET/timeout) even when the device is fine.
     * - BLE GATT writes can fail if the controller dropped the connection between connect() and write().
     * - Retrying once after a forced disconnect/reconnect is a common industrial pattern for flaky BLE links.
     * 
     * Guardrails:
     * - We only do a small bounded retry (1 reconnect+retry) to avoid “infinite retries per command”
     *   which would make HA buttons feel unresponsive.
     */
    private isTransientBleError = (error: any): boolean => {
      if (isSocketOrBLETimeoutError(error)) return true;
      const msg = (error?.message || String(error)).toLowerCase();
      return (
        msg.includes('not connected') ||
        msg.includes('disconnected') ||
        msg.includes('gatt') ||
        msg.includes('timeout') ||
        msg.includes('busy') ||
        msg.includes('reset')
      );
    };
  
    private ensureConnected = async (): Promise<void> => {
      if (this.connectMutex) return this.connectMutex;
      this.connectMutex = (async () => {
        await this.bleDevice.connect();
      })();
      try {
        await this.connectMutex;
      } finally {
        this.connectMutex = null;
      }
    };
  
    private ensureConnectedWithRetry = async (): Promise<void> => {
      try {
        await this.ensureConnected();
        logInfo(`[BLE] Connected to device ${this.deviceData.device.name} for command execution`);
        return;
      } catch (error: any) {
        // NOTE: pass the error object as the first arg so pino prints stack/details.
        logError({ err: error }, `[BLE] Failed to connect to device ${this.deviceData.device.name}`);
        healthMonitor.recordBleFailure(this.deviceData.device.name, error, this.proxyHost);

        // Special-case: ESPHome API reconnect window.
        // During transient reconnects the underlying Connection may be temporarily "not connected/authorized".
        // If we immediately force a full SmartbedMQTT reconnect here, we drop user commands (HA button presses)
        // even though the socket would have recovered within a couple seconds.
        const firstMsg = String(error?.message || error).toLowerCase();
        const isApiReconnectingWindow =
          firstMsg.includes('esphome api not ready') ||
          firstMsg.includes('not connected') ||
          firstMsg.includes('not authorized') ||
          firstMsg.includes('socket is not connected');

        if (isApiReconnectingWindow) {
          logWarn(
            `[BLE] ESPHome API not ready for ${this.deviceData.device.name}; waiting briefly and retrying connect (to avoid dropping command).`
          );
          // Bounded local retries: ~1s + 2s + 4s = 7s additional wait.
          // If this doesn't recover, the normal escalation path below will request a reconnect.
          let lastErr: any = error;
          for (const delayMs of [1000, 2000, 4000]) {
            await wait(delayMs);
            try {
              await this.ensureConnected();
              logInfo(`[BLE] Connected to device ${this.deviceData.device.name} after ESPHome API recovery wait`);
              return;
            } catch (e: any) {
              lastErr = e;
              const msg = String(e?.message || e).toLowerCase();
              // If the error changed into something else, break and handle it normally.
              if (
                !(
                  msg.includes('esphome api not ready') ||
                  msg.includes('not connected') ||
                  msg.includes('not authorized') ||
                  msg.includes('socket is not connected')
                )
              ) {
                break;
              }
            }
          }
          // Continue into escalation logic with the latest error.
          error = lastErr;
        }

        // If the ESPHome API socket is broken (e.g. ECONNRESET / write-after-end), a local reconnect loop
        // is often not enough — we need to force the higher-level ESPHome reconnect.
        const code = error?.code || '';
        const msg = String(error?.message || error).toLowerCase();
        const isDeadApiSocket =
          code === 'ECONNRESET' ||
          code === 'ERR_STREAM_WRITE_AFTER_END' ||
          msg.includes('write after end') ||
          msg.includes('bad format') ||
          msg.includes('unknown protocol selected by server');

        if (isDeadApiSocket) {
          healthMonitor.requestRestart({
            kind: 'ble',
            reason: 'ESPHome socket error during command execution (forcing reconnect)',
            deviceName: this.deviceData.device.name,
            error: `${code || 'socket'}: ${error?.message || String(error)}`,
          });
          throw error;
        }

        // Force a clean disconnect and retry once for transient link issues.
        if (!this.isTransientBleError(error)) throw error;
        try {
          await this.disconnect();
        } catch {}
        await wait(300);
        await this.ensureConnected();
        logInfo(`[BLE] Connected to device ${this.deviceData.device.name} after retry`);
      }
    };
  
    private write = async (command: number[]) => {
      if (this.disconnectTimeout) {
        clearTimeout(this.disconnectTimeout);
        this.disconnectTimeout = undefined;
      }
      try {
        await this.bleDevice.writeCharacteristic(this.handle, new Uint8Array(command));
        logInfo(`[BLE] Successfully wrote command to device ${this.deviceData.device.name}`);
        // Record last attempted command time for idle-based maintenance reconnect decisions.
        healthMonitor.recordCommand(this.deviceData.device.name);
        healthMonitor.recordBleSuccess(this.deviceData.device.name);
      } catch (e) {
        // Retry once after forced reconnect if this looks transient.
        if (this.isTransientBleError(e)) {
          logError(
            `[BLE] Write failed for ${this.deviceData.device.name} (transient). Forcing reconnect and retrying once.`,
            e
          );
          try {
            await this.disconnect();
          } catch {}
          await wait(300);
          try {
            await this.ensureConnected();
            await this.bleDevice.writeCharacteristic(this.handle, new Uint8Array(command));
            logInfo(`[BLE] Successfully wrote command to device ${this.deviceData.device.name} after retry`);
            healthMonitor.recordCommand(this.deviceData.device.name);
            healthMonitor.recordBleSuccess(this.deviceData.device.name);
            // Schedule disconnect if we're not staying connected.
            if (!this.stayConnected) this.disconnectTimeout = setTimeout(this.disconnect, 60_000);
            return;
          } catch (retryError) {
            logError(`[BLE] Retry write failed for device ${this.deviceData.device.name}`, retryError);
            healthMonitor.recordBleFailure(this.deviceData.device.name, retryError, this.proxyHost);
            throw retryError;
          }
        }
        logError(`[BLE] Failed to write characteristic to device ${this.deviceData.device.name}`, e);
        healthMonitor.recordBleFailure(this.deviceData.device.name, e, this.proxyHost);
        throw e; // Re-throw so callers know the write failed
      }
      if (this.stayConnected) return;
  
      this.disconnectTimeout = setTimeout(this.disconnect, 60_000);
    };
  writeCommand = (command: TCommand, count: number = 1, waitTime?: number) =>
    this.writeCommands([command], count, waitTime);

  writeCommands = async (commands: TCommand[], count: number = 1, waitTime?: number) => {
    /**
     * Project memory (BLE hardening):
     * Home Assistant can fire multiple service calls concurrently (button mashing, automation bursts).
     * ESPHome BLE proxy / GATT stacks are sensitive to overlapping connect/write sequences.
     *
     * Strategy:
     * - Serialize all command executions per controller instance via a FIFO promise queue.
     * - This prevents overlapping writes and reduces "GATT busy / services timeout" flakiness.
     */
    const run = async () => {
      const commandList = commands.map(this.commandBuilder).filter((command) => command.length > 0);
      if (commandList.length === 0) return;

      await this.ensureConnectedWithRetry();

      const onTick =
        commandList.length === 1 ? () => this.write(commandList[0]) : () => loopWithWait(commandList, this.write);
      if (count === 1 && !waitTime) return await onTick();

      if (this.timer && this.lastCommands) {
        if (deepArrayEquals(commandList, this.lastCommands)) return void this.timer.extendCount(count);
        await this.cancelCommands();
      }

      this.lastCommands = commandList;
      const onFinish = () => {
        this.timer = undefined;
        this.lastCommands = undefined;
      };
      this.timer = new Timer(onTick, count, waitTime, onFinish);
      await this.timer.start();
    };

    const op = this.commandQueue.then(run);
    // Ensure the queue continues even if this operation fails.
    this.commandQueue = op.then(
      () => undefined,
      () => undefined
    );
    return await op;
  };

  cancelCommands = async () => {
    await this.timer?.cancel();
  };

  on = (eventName: string, handler: (data: Uint8Array) => void): this => {
    this.addListener(eventName, handler);
    return this;
  };
}
