import { Connection } from '@2colors/esphome-native-api';
import { logDebug, logError, logInfo, logWarn, logWarnDedup } from '@utils/logger';

/**
 * Establish an ESPHome native API connection robustly.
 *
 * Project memory / Why:
 * - The previous implementation attached an 'error' handler, called `connection.connect()`,
 *   and then immediately removed the handler. Because the actual socket handshake is async,
 *   this could miss connection errors entirely and leave callers thinking they are connected
 *   while subscriptions silently stop delivering data.
 *
 * How:
 * - Resolve only after 'authorized' and successful bluetooth proxy feature validation.
 * - Reject on the first 'error' or on a hard timeout.
 * - Always remove listeners on resolve/reject to avoid leaks.
 */
export const connect = (connection: Connection) => {
  const CONNECT_TIMEOUT_MS = 30_000;

  return new Promise<Connection>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      connection.off('authorized', onAuthorized);
      connection.off('error', onError);
    };

    const fail = (error: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      const errorMsg = error?.message || String(error);
      const errorCode = error?.code || '';
      const errorStack = (error?.stack || '').split('\n').slice(0, 3).join(' | ');
      logError(
        `[ESPHome] Failed connecting to ${connection.host} (code=${errorCode || 'n/a'}): ${errorMsg}${
          errorStack ? ` | ${errorStack}` : ''
        }`
      );
      reject(error);
    };

    const onError = (error: any) => {
      // Surface socket errors to the outer retry loop (connectToESPHome handles retries).
      fail(error);
    };

    const socketErrorHandler = (error: any) => {
      const errorMessage = error?.message || String(error);
      const errorCode = error?.code || '';
      const key = `esphome:socket:${connection.host}:${errorCode || errorMessage}`;
      const isSocketError =
        errorCode === 'ECONNRESET' ||
        errorCode === 'ECONNREFUSED' ||
        errorCode === 'ETIMEDOUT' ||
        errorMessage.includes('ECONNRESET') ||
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('ETIMEDOUT') ||
        errorMessage.toLowerCase().includes('socket') ||
        errorMessage.toLowerCase().includes('reset') ||
        errorMessage.toLowerCase().includes('timeout');

      logWarnDedup(
        key,
        2_000,
        isSocketError
          ? `[ESPHome] Socket error on ${connection.host} (code=${errorCode || 'n/a'}): ${errorMessage}`
          : `[ESPHome] Connection error on ${connection.host} (code=${errorCode || 'n/a'}): ${errorMessage}`
      );
      // Do not reject here; once connected, higher-level code decides when to reconnect.
    };

    const onAuthorized = async () => {
      if (settled) return;
      try {
        // Validate this is actually a BLE proxy.
        // TODO: Fix after new version of esphome-native-api is released (bluetoothProxyFeatureFlags typing).
        const deviceInfo = await connection.deviceInfoService();
        const { bluetoothProxyFeatureFlags } = deviceInfo as any;
        if (!bluetoothProxyFeatureFlags) {
          throw new Error(`No Bluetooth proxy features detected for ${connection.host}`);
        }

        settled = true;
        cleanup();

        // After the handshake is complete, attach persistent error logging.
        connection.on('error', socketErrorHandler);
        connection.on('unknownMessage', (id: any) => {
          const payload = typeof id === 'object' ? id : { id };
          const msgId = payload?.id ?? id;
          const len = payload?.length;
          const bytes = payload?.bytes;
          logWarnDedup(
            `esphome:unknownMessage:${connection.host}:${String(msgId)}`,
            10_000,
            `[ESPHome] Unknown message id from ${connection.host}: ${String(msgId)}${
              len ? ` len=${String(len)}` : ''
            }${bytes ? ` bytes[0..16]=${String(bytes)}` : ''}`
          );
        });

        // Verbose probes (only when LOG_LEVEL is debug/trace): subscribe to proxy logs + connection slot telemetry
        const logLevel = String(process.env.LOG_LEVEL || '').toLowerCase();
        if (logLevel === 'debug' || logLevel === 'trace') {
          try {
            (connection as any).subscribeBluetoothConnectionsFreeService?.();
            connection.on('message.BluetoothConnectionsFreeResponse', (msg: any) => {
              logDebug(
                `[ESPHome] BLE connections free on ${connection.host}: free=${msg?.free} limit=${msg?.limit}`
              );
            });
          } catch {}

          try {
            (connection as any).subscribeLogsService?.();
            connection.on('message.SubscribeLogsResponse', (msg: any) => {
              const line = String(msg?.message ?? '').trim();
              if (!line) return;
              const lower = line.toLowerCase();
              if (
                lower.includes('bluetooth') ||
                lower.includes('gatt') ||
                lower.includes('proxy') ||
                lower.includes('error') ||
                lower.includes('warn')
              ) {
                logDebug(`[ESPHome][ProxyLog ${connection.host}] ${line}`);
              }
            });
          } catch {}
        }
        if ((connection as any).socket) {
          const socket = (connection as any).socket;
          socket.on('error', socketErrorHandler);
          socket.on('close', () => {
            logWarn(`[ESPHome] Socket closed on ${connection.host}`);
          });
        }

        logInfo('[ESPHome] Connected:', connection.host);
        resolve(connection);
      } catch (e) {
        fail(e);
      }
    };

    timeout = setTimeout(() => fail(new Error(`ESPHome connect timeout after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS);

    // Attach listeners BEFORE connect() so we don't miss early errors.
    connection.once('authorized', onAuthorized);
    connection.once('error', onError);

    try {
      connection.connect();
    } catch (e) {
      fail(e);
    }
  });
};
