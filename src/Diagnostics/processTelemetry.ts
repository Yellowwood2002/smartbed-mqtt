import { JsonSensor } from '@ha/JsonSensor';
import { IMQTTConnection } from '@mqtt/IMQTTConnection';
import { buildMQTTDeviceData } from 'Common/buildMQTTDeviceData';
import { logDebug } from '@utils/logger';
import { BLEDevice } from 'ESPHome/types/BLEDevice';
import { performance } from 'perf_hooks';

type StopFn = () => void;

/**
 * Process telemetry published as an HA diagnostic JsonSensor.
 *
 * Why:
 * - Helps prove/disprove memory leaks and correlates BLE instability with runtime health.
 * - Keeps key signals visible in HA without digging logs.
 */
export function startProcessTelemetry(mqtt: IMQTTConnection, type: string): StopFn {
  const deviceData = buildMQTTDeviceData(
    {
      friendlyName: 'SmartbedMQTT',
      name: `addon:${type}`,
      address: 'smartbedmqtt',
      ids: ['smartbedmqtt', `smartbedmqtt:${type}`],
    },
    'SmartbedMQTT'
  );

  const sensor = new JsonSensor<any>(mqtt, deviceData, {
    description: 'Process Diagnostics',
    category: 'diagnostic',
    icon: 'mdi:chart-line',
    valueField: 'status',
  });

  let lastTick = performance.now();
  let lagEwmaMs = 0;
  const intervalMs = 5000;

  const timer = setInterval(() => {
    const now = performance.now();
    const drift = Math.max(0, now - lastTick - intervalMs);
    lastTick = now;
    lagEwmaMs = lagEwmaMs === 0 ? drift : lagEwmaMs * 0.9 + drift * 0.1;

    const mem = process.memoryUsage();
    const ble = BLEDevice.getGlobalBleCounters();

    sensor.setState({
      status: 'ok',
      type,
      ts: Date.now(),
      uptimeSec: Math.floor(process.uptime()),
      memory: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
        arrayBuffers: (mem as any).arrayBuffers,
      },
      eventLoop: {
        lastLagMs: Math.round(drift),
        ewmaLagMs: Math.round(lagEwmaMs),
        intervalMs,
      },
      ble,
    });
  }, intervalMs);

  logDebug('[Diagnostics] Process telemetry started');

  return () => {
    clearInterval(timer);
  };
}

