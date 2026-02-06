import { StringsKey, getString } from '@utils/getString';

export const buildEntityConfig = (
  key: StringsKey,
  additionalConfig?: string | { category?: string; icon?: string; description?: string; tag?: string }
) => {
  if (typeof additionalConfig === 'string') additionalConfig = { category: additionalConfig };
  return {
    description: (additionalConfig as any)?.description ?? getString(key),
    tag: (additionalConfig as any)?.tag,
    ...(additionalConfig || {}),
  };
};
