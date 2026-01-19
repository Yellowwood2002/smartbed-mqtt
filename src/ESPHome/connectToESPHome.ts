import { Connection } from '@2colors/esphome-native-api';
import { logInfo, logWarnDedup } from '@utils/logger';
import { retryWithBackoff, isSocketOrBLETimeoutError } from '@utils/retryWithBackoff';
import { ESPConnection } from './ESPConnection';
import { IESPConnection } from './IESPConnection';
import { connect } from './connect';
import { getProxies } from './options';
import EventEmitter from 'events';

const isServerNameMismatch = (error: any) => {
  const msg = error?.message || String(error);
  return msg.includes('Server name mismatch');
};

const extractServerNameMismatch = (error: any): { expected?: string; got?: string } => {
  const msg = error?.message || String(error);
  // Example: "Server name mismatch, expected 10.0.0.111, got m5stack-atom-lite-fdb45c"
  const m = msg.match(/Server name mismatch,\s*expected\s*(.+?),\s*got\s*(.+)\s*$/i);
  if (!m) return {};
  return { expected: m[1]?.trim(), got: m[2]?.trim() };
};

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
    // Mutable expectedServerName allows us to correct a common misconfig safely.
    // If the proxy presents a different server name than expected, we can pin to the presented name.
    let expectedServerName = config.expectedServerName;
    
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
        
        const newConnection = new Connection({ ...config, expectedServerName });
        try {
          // connect() will throw on failure, triggering retry
          return await connect(newConnection);
        } catch (error) {
          // Project memory:
          // Users often set expectedServerName to an IP (or copy host into it). ESPHome actually
          // presents the node name (e.g. "m5stack-atom-lite-xxxx"). When this mismatches, we will
          // never connect. In production, pin to the presented node name so encryption remains
          // name-verified, but we recover automatically.
          if (isServerNameMismatch(error)) {
            const { expected, got } = extractServerNameMismatch(error);
            if (got && got !== expectedServerName) {
              logWarnDedup(
                `esphome:serverNameMismatch:${config.host}:${config.port || 6053}`,
                60_000,
                `[ESPHome] Server name mismatch. Updating expectedServerName to '${got}' (was '${expectedServerName ?? ''}')`
              );
              expectedServerName = got;
            }
          }
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
        // Socket resets are retryable; server-name mismatch is retryable because we can correct it above.
        isRetryableError: (error: any) => isSocketOrBLETimeoutError(error) || isServerNameMismatch(error),
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
