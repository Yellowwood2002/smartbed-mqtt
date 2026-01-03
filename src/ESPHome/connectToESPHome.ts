import { Connection } from '@2colors/esphome-native-api';
import { logInfo, logWarn } from '@utils/logger';
import { wait } from '@utils/wait';
import { ESPConnection } from './ESPConnection';
import { IESPConnection } from './IESPConnection';
import { connect } from './connect';
import { getProxies } from './options';

const RETRY_DELAY_MS = 5000; // 5 seconds

export const connectToESPHome = async (): Promise<IESPConnection> => {
  logInfo('[ESPHome] Connecting...');

  const proxies = getProxies();
  if (proxies.length === 0) {
    return new ESPConnection([]);
  }

  // Retry loop for each proxy connection
  const connections: Connection[] = [];
  
  for (const config of proxies) {
    let connected = false;
    while (!connected) {
      try {
        const connection = new Connection(config);
        const connectedConnection = await connect(connection);
        connections.push(connectedConnection);
        connected = true;
      } catch (error: any) {
        const errorMessage = error?.message || String(error);
        const errorCode = error?.code || '';
        const isSocketError = errorCode === 'ECONNRESET' || 
                             errorCode === 'ECONNREFUSED' || 
                             errorCode === 'ETIMEDOUT' ||
                             errorMessage.includes('ECONNRESET') ||
                             errorMessage.includes('socket') ||
                             errorMessage.includes('reset') ||
                             errorMessage.includes('timeout');
        
        if (isSocketError) {
          logWarn(`[ESPHome] Socket error connecting to ${config.host}:${config.port || 6053} (${errorCode || errorMessage}), retrying in ${RETRY_DELAY_MS / 1000}s...`);
        } else {
          logWarn(`[ESPHome] Connection error to ${config.host}:${config.port || 6053}, retrying in ${RETRY_DELAY_MS / 1000}s:`, errorMessage);
        }
        
        await wait(RETRY_DELAY_MS);
        // Loop will retry
      }
    }
  }
  
  return new ESPConnection(connections);
};
