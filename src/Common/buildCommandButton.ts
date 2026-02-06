import { Button } from '@ha/Button';
import { IMQTTConnection } from '@mqtt/IMQTTConnection';
import { StringsKey, getString } from '@utils/getString';
import { logError, logInfo } from '@utils/logger';
import { IController } from './IController';
import { buildEntityConfig } from './buildEntityConfig';

export const buildCommandButton = <TCommand>(
  context: string,
  mqtt: IMQTTConnection,
  { cache, deviceData, writeCommand }: IController<TCommand>,
  name: StringsKey,
  command: TCommand,
  category?: string,
  writeOptions?: { count?: number; waitTime?: number },
  configOverrides?: { description?: string; tag?: string; icon?: string; category?: string }
) => {
  if (cache[name]) return;

  const entityConfig = buildEntityConfig(
    name,
    typeof category === 'string' || category === undefined
      ? { category, ...(configOverrides || {}) }
      : { ...(configOverrides || {}) }
  );

  cache[name] = new Button(mqtt, deviceData, entityConfig, async () => {
    try {
      await writeCommand(command, writeOptions?.count, writeOptions?.waitTime);
      logInfo(`[${context}] Successfully executed command '${getString(name)}' on device ${deviceData.device.name}`);
    } catch (e) {
      logError(`[${context}] Failed to write '${getString(name)}' on device ${deviceData.device.name}`, e);
    }
  }).setOnline();
};
