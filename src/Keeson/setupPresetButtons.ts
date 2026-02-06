import { IMQTTConnection } from '@mqtt/IMQTTConnection';
import { Commands } from 'Common/Commands';
import { IController } from 'Common/IController';
import { buildCommandButton } from 'Common/buildCommandButton';
import { getString } from '@utils/getString';

export const setupPresetButtons = (mqtt: IMQTTConnection, controller: IController<number>) => {
  const model = ((controller as any)?.cache as any)?.__keesonModel ?? 'unknown';

  // Flat + Anti-snore: these labels are stable and already match the remote.
  buildCommandButton('Keeson', mqtt, controller, 'PresetFlat', Commands.PresetFlat);
  buildCommandButton('Keeson', mqtt, controller, 'PresetAntiSnore', Commands.PresetMemory3);

  /**
   * Zero-G reliability:
   * Some Keeson controllers appear to require multiple frames (similar to a quick "double tap")
   * before movement starts. Re-sending the preset a few times is cheap and improves real-world success.
   */
  buildCommandButton(
    'Keeson',
    mqtt,
    controller,
    'PresetZeroG',
    Commands.PresetZeroG,
    undefined,
    { count: 3, waitTime: 200 }
  );

  /**
   * Remote button labeling (auto):
   *
   * Project memory:
   * - Older smartbedmqtt versions exposed "Preset: Memory 1/2" entities for Keeson.
   * - Renaming to colors without a stable tag created "missing" buttons in HA/HomeKit.
   *
   * Strategy:
   * - Keep the *stable tag* aligned with the legacy memory button entity IDs (so HA updates in place).
   * - Present user-facing names as the remote button labels (Yellow/Green/Red).
   * - Add Memory 4 (Red) for remotes that have the third color button.
   */
  const legacyTagMemory1 = getString('PresetMemory1'); // "Preset: Memory 1"
  const legacyTagMemory2 = getString('PresetMemory2'); // "Preset: Memory 2"

  // KSBT remotes commonly use colored memory buttons.
  const useColorLabels = model === 'ksbt';
  if (useColorLabels) {
    buildCommandButton('Keeson', mqtt, controller, 'PresetYellow', Commands.PresetMemory1, undefined, undefined, {
      tag: legacyTagMemory1,
    });
    buildCommandButton('Keeson', mqtt, controller, 'PresetGreen', Commands.PresetMemory2, undefined, undefined, {
      tag: legacyTagMemory2,
    });
    buildCommandButton('Keeson', mqtt, controller, 'PresetRed', Commands.PresetMemory4, undefined, undefined, {
      // New entity; tag it to Memory 4 for future-proof stable renames.
      tag: getString('PresetMemory4'),
    });
  } else {
    // Non-KSBT variants: keep generic memory naming.
    buildCommandButton('Keeson', mqtt, controller, 'PresetMemory1', Commands.PresetMemory1);
    buildCommandButton('Keeson', mqtt, controller, 'PresetMemory2', Commands.PresetMemory2);
    buildCommandButton('Keeson', mqtt, controller, 'PresetMemory4', Commands.PresetMemory4);
  }
};
