export interface IMQTTConnection {
  /**
   * Disconnect the underlying MQTT client.
   *
   * Why:
   * - During self-healing loops we may create a new MQTT client.
   * - If the old client is left running, it can publish retained `offline` status later and
   *   make all entities unavailable in HA/HomeKit even though a new client is connected.
   */
  disconnect(): void;
  unsubscribe(topic: string): void;
  on(event: string, listener: (this: IMQTTConnection, message: string) => void): this;
  off(event: string, listener: (this: IMQTTConnection, message: string) => void): this;
  /**
   * Publish an MQTT message.
   *
   * Project memory:
   * - Some topics are telemetry/diagnostics and benefit from retain=true (e.g. online/offline, degraded state)
   *   so Home Assistant can show the last known state immediately after restart.
   */
  publish(topic: string, message: any, options?: { qos?: 0 | 1 | 2; retain?: boolean }): void;
  subscribe(topic: string): void;
}
