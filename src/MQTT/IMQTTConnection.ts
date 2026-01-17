export interface IMQTTConnection {
  unsubscribe(topic: string): void;
  on(event: string, listener: (this: IMQTTConnection, message: string) => void): this;
  off(event: string, listener: (this: IMQTTConnection, message: string) => void): this;
  publish(
    topic: string,
    message: any,
    options?: {
      /**
       * MQTT QoS level (defaults to 1 when using the built-in MQTTConnection)
       */
      qos?: 0 | 1 | 2;
      /**
       * Whether to retain the message on the broker (defaults to false when using the built-in MQTTConnection)
       */
      retain?: boolean;
    }
  ): void;
  subscribe(topic: string): void;
}
