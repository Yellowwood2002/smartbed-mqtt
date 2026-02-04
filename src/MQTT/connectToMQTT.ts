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

      // Wrap early so we never miss the initial connect event.
      const connection = new MQTTConnection(client);

      const publishOnline = () => {
        try {
          connection.publish(STATUS_TOPIC, 'online', { qos: 1, retain: true });
        } catch (e: any) {
          logWarn('[MQTT] Failed to publish online status:', e?.message || String(e));
        }
      };

      // Publish online on EVERY MQTT (re)connect.
      client.on('connect', publishOnline);

      // Log reconnect transitions, but do NOT publish offline during transient reconnects.
      // Rationale:
      // - Publishing `offline` while the add-on is alive causes HA/HomeKit entities to go unavailable.
      // - The MQTT Last Will is the authoritative "addon died" signal.
      client.on('offline', () => logWarn('[MQTT] Client went offline (auto-reconnect enabled).'));
      client.on('close', () => logWarn('[MQTT] Connection closed (auto-reconnect enabled).'));
      client.on('error', (error: any) => {
        const errorMessage = error?.message || String(error);
        logError(`[MQTT] Connection error (auto-reconnect enabled): ${errorMessage}`);
      });

      client.once('connect', () => {
        logInfo('[MQTT] Connected');
        // publishOnline will run via the persistent handler above.
        resolve(connection);
      });

      client.once('error', (error: any) => {
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
          try {
            // Stop this client so it can't linger and publish later.
            connection.disconnect();
          } catch {}
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
