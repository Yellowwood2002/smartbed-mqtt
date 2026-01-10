import { Connection } from '@2colors/esphome-native-api';
import { logInfo } from '@utils/logger';
import { retryWithBackoff, isSocketOrBLETimeoutError } from '@utils/retryWithBackoff';
import { ESPConnection } from './ESPConnection';
import { IESPConnection } from './IESPConnection';
import { connect } from './connect';
import { getProxies } from './options';
import EventEmitter from 'events';

export const connectToESPHome = async (): Promise<IESPConnection> => {
  logInfo('[ESPHome] Connecting...');

  const proxies = getProxies();
  if (proxies.length === 0) {
    return new ESPConnection([]);
  }

  // Use retryWithBackoff for each proxy connection
  const connections: Connection[] = [];
  
  for (const config of proxies) {
    let failedConnection: Connection | null = null;
    
    // CRITICAL: Use retryWithBackoff with infinite retries for each proxy
    // This ensures we keep trying to connect even after socket errors
    const connection = await retryWithBackoff(
      async () => {
        // Clean up previous failed connection before creating a new one
        // This prevents orphan listeners from accumulating on dead socket objects
        if (failedConnection) {
          try {
            // Connection extends EventEmitter internally, so we can cast and call removeAllListeners
            (failedConnection as unknown as EventEmitter).removeAllListeners();
          } catch (e) {
            // Ignore errors during cleanup
          }
          failedConnection = null;
        }
        
        const newConnection = new Connection(config);
        try {
          // connect() will throw on failure, triggering retry
          return await connect(newConnection);
        } catch (error) {
          // Store failed connection for cleanup on next attempt
          failedConnection = newConnection;
          throw error;
        }
      },
      {
        maxRetries: undefined, // Infinite retries
        initialDelayMs: 5000, // 5 seconds initial delay
        maxDelayMs: 30000, // Max 30 seconds between retries
        backoffMultiplier: 1.5, // Gradual backoff
        isRetryableError: isSocketOrBLETimeoutError,
        onRetry: (error: any, attempt: number, delayMs: number) => {
          const errorMessage = error?.message || String(error);
          const errorCode = error?.code || '';
          logInfo(
            `[ESPHome] Connection attempt ${attempt} to ${config.host}:${config.port || 6053} failed, retrying in ${delayMs / 1000}s:`,
            errorCode || errorMessage
          );
        },
      }
    );
    
    connections.push(connection);
  }
  
  return new ESPConnection(connections);
};
