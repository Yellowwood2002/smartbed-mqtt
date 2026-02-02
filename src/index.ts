import { connectToMQTT } from '@mqtt/connectToMQTT';
import { loadStrings } from '@utils/getString';
import { getBuildInfo } from '@utils/buildInfo';
import { logError, logInfo, logWarn, logWarnDedup } from '@utils/logger';
import { wait } from '@utils/wait';
import { getType } from '@utils/options';
import { connectToESPHome } from 'ESPHome/connectToESPHome';
import { healthMonitor } from 'Diagnostics/HealthMonitor';
import { ergomotion } from 'ErgoMotion/ergomotion';
import { ergowifi } from 'ErgoWifi/ergowifi';
import { keeson } from 'Keeson/keeson';
import { leggettplatt } from 'LeggettPlatt/leggettplatt';
import { linak } from 'Linak/linak';
import { logicdata } from 'Logicdata/logicdata';
import { motosleep } from 'MotoSleep/motosleep';
import { octo } from 'Octo/octo';
import { okimat } from 'Okimat/okimat';
import { reverie } from 'Reverie/reverie';
import { richmat } from 'Richmat/richmat';
import { scanner } from 'Scanner/scanner';
import { sleeptracker } from 'Sleeptracker/sleeptracker';
import { solace } from 'Solace/solace';

let exiting = false;
const processExit = (exitCode?: number) => {
  if (exiting) return;
  exiting = true;
  if (exitCode !== undefined && exitCode > 0) logError(`Exit code: ${exitCode}`);
  process.exit(exitCode ?? 0);
};

process.on('exit', (code) => logWarn(`Shutting down Smartbed-MQTT... (code=${code})`));
process.on('SIGINT', () => processExit(0));
process.on('SIGTERM', () => processExit(0));
process.on('uncaughtException', (err) => {
  const errorMessage = err?.message || String(err);
  const errorCode = (err as any)?.code || '';
  const isSocketError = errorCode === 'ECONNRESET' || 
                       errorCode === 'ECONNREFUSED' || 
                       errorCode === 'ETIMEDOUT' ||
                       errorMessage.includes('ECONNRESET') ||
                       errorMessage.includes('socket') ||
                       errorMessage.includes('reset') ||
                       errorMessage.includes('timeout') ||
                       errorMessage.includes('BluetoothDeviceConnectionResponse') ||
                       errorMessage.includes('BluetoothGATTGetServicesDoneResponse');
  
  if (isSocketError) {
    /**
     * Project memory:
     * Uncaught socket errors (e.g. ECONNRESET from the ESPHome API socket) can fire repeatedly.
     * Continuing after an uncaught exception is unsafe and leads to log spam and corrupted state.
     *
     * Production behavior:
     * - Rate limit the log line
     * - Exit so Supervisor restarts cleanly (it provides backoff)
     */
    logWarnDedup(
      'main:uncaught:socket',
      10_000,
      `[Main] Uncaught socket/BLE error (requesting restart): ${errorCode || errorMessage}`,
      errorMessage
    );
    // Best-effort publish health snapshot before exit
    healthMonitor.requestRestart({ kind: 'ble', reason: 'uncaught socket/BLE error', error: errorCode || errorMessage });
    processExit(1);
  } else {
    logError('[Main] Uncaught exception:', err);
    processExit(2);
  }
});

process.on('unhandledRejection', (reason: any, _promise: Promise<any>) => {
  const errorMessage = reason?.message || String(reason);
  const errorCode = reason?.code || '';
  const isSocketError = errorCode === 'ECONNRESET' || 
                       errorCode === 'ECONNREFUSED' || 
                       errorCode === 'ETIMEDOUT' ||
                       errorMessage.includes('ECONNRESET') ||
                       errorMessage.includes('socket') ||
                       errorMessage.includes('reset') ||
                       errorMessage.includes('timeout') ||
                       errorMessage.includes('BluetoothDeviceConnectionResponse') ||
                       errorMessage.includes('BluetoothGATTGetServicesDoneResponse');
  
  if (isSocketError) {
    logWarnDedup(
      'main:unhandledRejection:socket',
      10_000,
      `[Main] Unhandled promise rejection (socket/BLE error, requesting restart): ${errorCode || errorMessage}`,
      errorMessage
    );
    healthMonitor.requestRestart({
      kind: 'ble',
      reason: 'unhandled promise rejection (socket/BLE error)',
      error: errorCode || errorMessage,
    });
    processExit(1);
  } else {
    logError('[Main] Unhandled promise rejection:', reason);
    // For non-socket errors, log but don't exit - let the monitoring loop handle recovery
  }
});

// Self-healing wrapper for device functions that monitors and restarts on failure
// BLE device functions like keeson() use Promise.all() which completes when all devices are set up.
// This is NORMAL behavior - the function sets up devices and completes. Devices are then controlled via MQTT.
// If connections fail later (MQTT disconnect, ESPHome failure, etc.), we need to restart the entire setup.
// This wrapper only restarts on actual errors, not on successful completion.
const runWithSelfHealing = async (
  deviceFunction: (mqtt: any, esphome: any) => Promise<void>,
  mqtt: any,
  esphome: any
): Promise<void> => {
  const RETRY_DELAY_MS = 10000; // 10 seconds between recovery attempts
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 5;
  
  while (true) {
    try {
      // Reset failure counter on success
      consecutiveFailures = 0;
      
      // Run the device function - for BLE devices, this sets up all devices and completes successfully
      // This is expected behavior - the function completes after setup, and devices are controlled via MQTT
      await deviceFunction(mqtt, esphome);
      
      // If we get here, the function completed successfully - this is NORMAL for BLE device setup
      // Log success and wait - if connections fail later, commands will fail and trigger recovery
      logInfo(`[Main] Device function ${getType()} completed setup successfully. Devices are ready for commands.`);

      // Wait until diagnostics requests a reconnect (e.g. repeated BLE errors).
      // This is the missing link: many MQTT entity handlers catch/log errors, so we need a central
      // place to decide when "it's broken enough" to reconnect ESPHome/MQTT.
      const reason = await healthMonitor.waitForRestartRequest();
      const reasonText =
        reason.kind === 'manual' || reason.kind === 'maintenance'
          ? reason.reason
          : `${reason.reason}${reason.deviceName ? ` (device=${reason.deviceName})` : ''}`;
      logWarn(`[Main] Reconnect requested by health monitor: ${reasonText}`);

      // Reset for the next setup run.
      healthMonitor.resetRestartSignal();

      // Trigger outer loop reconnect.
      throw new Error(reasonText);
    } catch (error: any) {
      consecutiveFailures++;
      const errorMessage = error?.message || String(error);
      const errorCode = error?.code || '';
      const isSocketError = errorCode === 'ECONNRESET' || 
                           errorCode === 'ECONNREFUSED' || 
                           errorCode === 'ETIMEDOUT' ||
                           errorMessage.includes('ECONNRESET') ||
                           errorMessage.includes('socket') ||
                           errorMessage.includes('reset') ||
                           errorMessage.includes('timeout') ||
                           errorMessage.includes('BluetoothDeviceConnectionResponse') ||
                           errorMessage.includes('BluetoothGATTGetServicesDoneResponse');
      
      if (isSocketError) {
        logWarn(`[Main] Socket/BLE error in ${getType()} (failure ${consecutiveFailures}, will retry in ${RETRY_DELAY_MS / 1000}s):`, errorCode || errorMessage);
      } else {
        logWarn(`[Main] Error in ${getType()} (failure ${consecutiveFailures}, will retry in ${RETRY_DELAY_MS / 1000}s):`, errorMessage);
      }
      
      // If we have too many consecutive failures, wait longer before retrying
      const delay = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES 
        ? RETRY_DELAY_MS * 3  // 30 seconds for persistent failures
        : RETRY_DELAY_MS;

      // CRITICAL: Ensure we drop the ESPHome API connection before retrying.
      // Otherwise we can end up with multiple overlapping BLE subscriptions, which ESPHome rejects:
      // "Only one API subscription is allowed at a time".
      try {
        esphome?.disconnect?.();
      } catch {}
      // Give the proxy a moment to release the previous subscription/slot.
      await wait(1000);

      await wait(delay);
      // Re-throw to trigger outer loop to reconnect MQTT/ESPHome
      throw error;
    }
  }
};

const start = async () => {
  await loadStrings();

  /**
   * Project memory (runtime fingerprint):
   * Home Assistant add-on rebuilds/reinstalls can accidentally keep pointing at an upstream repo
   * or a cached build. This explicit startup log makes it unambiguous which fork is running.
   */
  logInfo('Forked By Yellowwood2002');
  const build = getBuildInfo();
  logInfo(
    `[Build] fork=${build.fork} version=${build.version ?? 'unknown'} git=${build.gitSha} built=${build.buildTime}`
  );

  // http/udp devices - these complete and exit, so no self-healing needed
  const type = getType();
  switch (type) {
    case 'sleeptracker':
      return void (await sleeptracker(await connectToMQTT()));
    case 'ergowifi':
      return void (await ergowifi(await connectToMQTT()));
    case 'logicdata':
      return void (await logicdata(await connectToMQTT()));
    case 'ergomotion':
      return void (await ergomotion(await connectToMQTT()));
  }
  
  // bluetooth devices - these need self-healing with connection monitoring
  const RETRY_DELAY_MS = 5000; // 5 seconds
  while (true) {
    let mqtt: any = null;
    let esphome: any = null;
    
    try {
      // Reconnect MQTT if needed (self-healing)
      mqtt = await connectToMQTT();
      healthMonitor.init(mqtt, type);
      
      // Reconnect ESPHome if needed (self-healing)
      esphome = await connectToESPHome();
      
      // Run device function with self-healing wrapper
      switch (type) {
        case 'richmat':
          await runWithSelfHealing(richmat, mqtt, esphome);
          return; // Should not reach here, but safety exit
        case 'linak':
          await runWithSelfHealing(linak, mqtt, esphome);
          return;
        case 'solace':
          await runWithSelfHealing(solace, mqtt, esphome);
          return;
        case 'motosleep':
          await runWithSelfHealing(motosleep, mqtt, esphome);
          return;
        case 'reverie':
          await runWithSelfHealing(reverie, mqtt, esphome);
          return;
        case 'leggettplatt':
          await runWithSelfHealing(leggettplatt, mqtt, esphome);
          return;
        case 'okimat':
          await runWithSelfHealing(okimat, mqtt, esphome);
          return;
        case 'keeson':
          await runWithSelfHealing(keeson, mqtt, esphome);
          return;
        case 'octo':
          await runWithSelfHealing(octo, mqtt, esphome);
          return;
        case 'scanner':
          // Scanner doesn't need self-healing - it's a one-time scan operation
          await scanner(esphome);
          return;
      }
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      const errorCode = error?.code || '';
      const isSocketError = errorCode === 'ECONNRESET' || 
                           errorCode === 'ECONNREFUSED' || 
                           errorCode === 'ETIMEDOUT' ||
                           errorMessage.includes('ECONNRESET') ||
                           errorMessage.includes('socket') ||
                           errorMessage.includes('reset') ||
                           errorMessage.includes('timeout') ||
                           errorMessage.includes('BluetoothDeviceConnectionResponse') ||
                           errorMessage.includes('BluetoothGATTGetServicesDoneResponse');
      
      if (isSocketError) {
        logWarn(`[Main] Socket/BLE error during setup in ${type} (will retry in ${RETRY_DELAY_MS / 1000}s):`, errorCode || errorMessage);
      } else {
        logWarn(`[Main] Error during setup in ${type} (will retry in ${RETRY_DELAY_MS / 1000}s):`, errorMessage);
      }

      // Best-effort cleanup before retrying: avoid overlapping ESPHome connections/subscriptions.
      try {
        esphome?.disconnect?.();
      } catch {}
      
      await wait(RETRY_DELAY_MS);
      // Loop will retry
    }
  }
};
void start();
