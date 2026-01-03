import { connectToMQTT } from '@mqtt/connectToMQTT';
import { loadStrings } from '@utils/getString';
import { logError, logWarn } from '@utils/logger';
import { wait } from '@utils/wait';
import { getType } from '@utils/options';
import { connectToESPHome } from 'ESPHome/connectToESPHome';
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

const processExit = (exitCode?: number) => {
  if (exitCode && exitCode > 0) {
    logError(`Exit code: ${exitCode}`);
  }
  process.exit();
};

process.on('exit', () => {
  logWarn('Shutting down Smartbed-MQTT...');
  processExit(0);
});
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
    logWarn(`[Main] Uncaught socket/BLE error (will be handled by retry logic): ${errorCode || errorMessage}`, errorMessage);
    // Don't exit - let the retry logic handle it
    // The error will be caught by the retry mechanism in start()
  } else {
    logError('[Main] Uncaught exception:', err);
    processExit(2);
  }
});

const start = async () => {
  await loadStrings();

  const mqtt = await connectToMQTT();

  // http/udp
  switch (getType()) {
    case 'sleeptracker':
      return void (await sleeptracker(mqtt));
    case 'ergowifi':
      return void (await ergowifi(mqtt));
    case 'logicdata':
      return void (await logicdata(mqtt));
    case 'ergomotion':
      return void (await ergomotion(mqtt));
  }
  // bluetooth - wrap in retry loop to handle socket errors and connection failures
  const RETRY_DELAY_MS = 5000; // 5 seconds
  while (true) {
    try {
      const esphome = await connectToESPHome();
      
      switch (getType()) {
        case 'richmat':
          await richmat(mqtt, esphome);
          return; // Success, exit retry loop
        case 'linak':
          await linak(mqtt, esphome);
          return;
        case 'solace':
          await solace(mqtt, esphome);
          return;
        case 'motosleep':
          await motosleep(mqtt, esphome);
          return;
        case 'reverie':
          await reverie(mqtt, esphome);
          return;
        case 'leggettplatt':
          await leggettplatt(mqtt, esphome);
          return;
        case 'okimat':
          await okimat(mqtt, esphome);
          return;
        case 'keeson':
          await keeson(mqtt, esphome);
          return;
        case 'octo':
          await octo(mqtt, esphome);
          return;
        case 'scanner':
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
        logWarn(`[Main] Socket/BLE error in ${getType()} (will retry in ${RETRY_DELAY_MS / 1000}s):`, errorCode || errorMessage);
      } else {
        logWarn(`[Main] Error in ${getType()} (will retry in ${RETRY_DELAY_MS / 1000}s):`, errorMessage);
      }
      
      await wait(RETRY_DELAY_MS);
      // Loop will retry
    }
  }
};
void start();
