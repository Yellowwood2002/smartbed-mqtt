import { logError, logInfo, logWarn } from '@utils/logger';
import mqtt from 'mqtt';
import { IMQTTConnection } from './IMQTTConnection';
import MQTTConfig from './MQTTConfig';
import { MQTTConnection } from './MQTTConnection';

export const connectToMQTT = (): Promise<IMQTTConnection> => {
  logInfo('[MQTT] Connecting...');
  
  // Try connecting with the configured host first
  const tryConnect = (config: typeof MQTTConfig): Promise<IMQTTConnection> => {
    return new Promise((resolve, reject) => {
      // Configure MQTT client with auto-reconnect enabled
      const client = mqtt.connect({
        ...config,
        reconnectPeriod: 5000, // Reconnect every 5 seconds
        connectTimeout: 30000, // 30 second connection timeout
      } as any); // Type assertion needed because config may have string port/username/password from env
      
      const cleanup = () => {
        client.removeAllListeners();
      };
      
      client.once('connect', () => {
        cleanup();
        logInfo('[MQTT] Connected');
        
        // Set up reconnection monitoring
        client.on('close', () => {
          logWarn('[MQTT] Connection closed, will attempt to reconnect...');
        });
        
        client.on('offline', () => {
          logWarn('[MQTT] Client went offline, will attempt to reconnect...');
        });
        
        client.on('error', (error: any) => {
          const errorMessage = error?.message || String(error);
          logError('[MQTT] Connection error (client will attempt to reconnect):', errorMessage);
        });
        
        resolve(new MQTTConnection(client));
      });
      
      client.once('error', (error: any) => {
        cleanup();
        const errorMessage = error?.message || String(error);
        const errorCode = error?.code || '';
        
        // Check if it's a DNS resolution error
        const isDNSError = errorCode === 'ENOTFOUND' || 
                          errorCode === 'EAI_AGAIN' ||
                          errorMessage.includes('Try again') ||
                          errorMessage.includes('ENOTFOUND') ||
                          errorMessage.includes('getaddrinfo');
        
        if (isDNSError && config.host === 'core-mosquitto') {
          logWarn(`[MQTT] DNS resolution failed for ${config.host}, falling back to IP 172.30.32.1`);
          // Fallback to IP address
          const fallbackConfig = { ...config, host: '172.30.32.1' };
          tryConnect(fallbackConfig).then(resolve).catch(reject);
        } else {
          logError('[MQTT] Connect Error', error);
          reject(error);
        }
      });
    });
  };
  
  return tryConnect(MQTTConfig);
};
