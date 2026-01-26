export interface IMQTTConnection {
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
