import { logError, logInfo } from '@utils/logger';
import EventEmitter from 'events';
import { MqttClient } from 'mqtt';
import { IMQTTConnection } from './IMQTTConnection';

export class MQTTConnection extends EventEmitter implements IMQTTConnection {
  private subscribedTopics: string[] = [];

  constructor(private client: MqttClient) {
    super();

    client.on('connect', () => {
      logInfo('[MQTT] Connected');
      this.emit('connect');
    });

    client.on('reconnect', () => {
      logInfo('[MQTT] Reconnecting...');
    });

    client.on('error', (error) => {
      logError('[MQTT] Error', error);
    });

    client.on('message', (topic, message) => {
      this.emit(topic, message.toString());
    });
    this.setMaxListeners(0);
  }

  /**
   * Hard-stop the underlying MQTT client so it can't linger and publish later.
   *
   * IMPORTANT:
   * - We intentionally do NOT publish `smartbedmqtt/status=offline` here.
   * - That topic is an availability signal for HA/HomeKit; flapping it during self-heal loops can
   *   make entities disappear even though the add-on is still running.
   * - The MQTT Last Will covers true crashes/ungraceful exits.
   */
  disconnect(): void {
    try {
      // Force-close immediately (don't wait for inflight acks).
      this.client.end(true);
    } catch {}
    try {
      this.client.removeAllListeners();
    } catch {}
    try {
      this.removeAllListeners();
    } catch {}
  }

  publish(topic: string, message: any, options?: { qos?: 0 | 1 | 2; retain?: boolean }) {
    if (message instanceof Object) {
      message = JSON.stringify(message);
    }
    this.client.publish(topic, message, {
      qos: options?.qos ?? 1,
      retain: options?.retain ?? false,
    });
  }

  subscribe(topic: string) {
    if (!this.subscribedTopics.includes(topic)) {
      this.client.subscribe(topic);
      this.subscribedTopics.push(topic);
    }
  }

  unsubscribe(topic: string) {
    const index = this.subscribedTopics.indexOf(topic);
    if (index !== -1) {
      this.client.unsubscribe(topic);
      this.subscribedTopics.splice(index, 1);
    }
  }
}
