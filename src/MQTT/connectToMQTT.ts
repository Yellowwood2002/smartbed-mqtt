import { logError, logInfo, logWarn } from '@utils/logger';
import mqtt from 'mqtt';
import { IMQTTConnection } from './IMQTTConnection';
import MQTTConfig from './MQTTConfig';
import { MQTTConnection } from './MQTTConnection';

export const connectToMQTT = (): Promise<IMQTTConnection> => {
  logInfo('[MQTT] Connecting...');

  /**
   * Project memory (operational hardening):
   * Expose a simple retained online/offline topic so HA + automations can understand whether
   * the add-on is currently connected to MQTT. We also set an MQTT Last Will so unexpected
   * crashes produce an 'offline' state without relying on graceful shutdown.
   */
  const STATUS_TOPIC = 'smartbedmqtt/status';
  
  // Try connecting with the configured host first
  const tryConnect = (config: typeof MQTTConfig): Promise<IMQTTConnection> => {
    return new Promise((resolve, reject) => {
      // Configure MQTT client with auto-reconnect enabled
      const client = mqtt.connect({
        ...config,
        reconnectPeriod: 5000, // Reconnect every 5 seconds
        connectTimeout: 30000, // 30 second connection timeout
        will: {
          topic: STATUS_TOPIC,
          payload: 'offline',
          qos: 1,
          retain: true,
        },
      } as any); // Type assertion needed because config may have string port/username/password from env
      
      const cleanup = () => {
        client.removeAllListeners();
      };
      
      client.once('connect', () => {
        cleanup();
        logInfo('[MQTT] Connected');

        // Publish retained online marker now that we're connected.
        try {
          client.publish(STATUS_TOPIC, 'online', { qos: 1, retain: true });
        } catch (e: any) {
          logWarn('[MQTT] Failed to publish online status:', e?.message || String(e));
        }
        
        // Set up reconnection monitoring
        client.on('close', () => {
          logWarn('[MQTT] Connection closed, will attempt to reconnect...');
          // If this is a graceful close, publish offline. Last Will covers ungraceful exits.
          try {
            client.publish(STATUS_TOPIC, 'offline', { qos: 1, retain: true });
          } catch {}
        });
        
        client.on('offline', () => {
          logWarn('[MQTT] Client went offline, will attempt to reconnect...');
          try {
            client.publish(STATUS_TOPIC, 'offline', { qos: 1, retain: true });
          } catch {}
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
