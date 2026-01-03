import { Connection } from '@2colors/esphome-native-api';
import { logError, logInfo, logWarn } from '@utils/logger';

export const connect = (connection: Connection) => {
  return new Promise<Connection>((resolve, reject) => {
    const errorHandler = (error: any) => {
      logError('[ESPHome] Failed Connecting:', error);
      reject(error);
    };
    connection.once('authorized', async () => {
      logInfo('[ESPHome] Connected:', connection.host);
      connection.off('error', errorHandler);
      
      // Add persistent socket error handler for ECONNRESET and other socket errors
      const socketErrorHandler = (error: any) => {
        const errorMessage = error?.message || String(error);
        const errorCode = error?.code || '';
        const isSocketError = errorCode === 'ECONNRESET' || 
                             errorCode === 'ECONNREFUSED' || 
                             errorCode === 'ETIMEDOUT' ||
                             errorMessage.includes('ECONNRESET') ||
                             errorMessage.includes('socket') ||
                             errorMessage.includes('reset');
        
        if (isSocketError) {
          logWarn(`[ESPHome] Socket error on ${connection.host} (${errorCode || errorMessage}), connection will be re-established:`, errorMessage);
          // Don't reject here - let the reconnection logic handle it
          // The error will be caught by the retry mechanism
        } else {
          logWarn(`[ESPHome] Connection error on ${connection.host}:`, errorMessage);
        }
      };
      
      // Listen for socket errors on the underlying connection
      connection.on('error', socketErrorHandler);
      
      // Also try to access the socket directly if available
      if ((connection as any).socket) {
        const socket = (connection as any).socket;
        socket.on('error', socketErrorHandler);
        socket.on('close', () => {
          logWarn(`[ESPHome] Socket closed on ${connection.host}, will attempt reconnection`);
        });
      }
      
      // TODO: Fix next two lines after new version of esphome-native-api is released
      const deviceInfo = await connection.deviceInfoService();
      const { bluetoothProxyFeatureFlags } = deviceInfo as any;
      if (!bluetoothProxyFeatureFlags) {
        logError('[ESPHome] No Bluetooth proxy features detected:', connection.host);
        return reject();
      }
      resolve(connection);
    });
    const doConnect = (handler: (error: any) => void) => {
      try {
        connection.once('error', handler);
        connection.connect();
        connection.off('error', handler);
        connection.once('error', errorHandler);
      } catch (err) {
        errorHandler(err);
      }
    };
    const retryHandler = (error: any) => {
      logError('[ESPHome] Failed Connecting (will retry):', error);
      doConnect(errorHandler);
    };
    doConnect(retryHandler);
  });
};
