import { z } from 'zod';

export const optionsSchema = z.object({
  mqtt_host: z.string(),
  mqtt_port: z.string(),
  mqtt_user: z.string(),
  mqtt_password: z.string(),
  type: z.enum([
    'scanner',
    'sleeptracker',
    'ergowifi',
    'richmat',
    'linak',
    'solace',
    'motosleep',
    'reverie',
    'leggettplatt',
    'logicdata',
    'ergomotion',
    'okimat',
    'keeson',
    'octo',
  ]),
  sleeptrackerRefreshFrequency: z.number().int().min(0).optional(),
  sleeptrackerCredentials: z
    .array(
      z.object({
        email: z.string().email(),
        password: z.string(),
        type: z.enum(['tempur', 'beautyrest', 'serta']).optional(),
      })
    )
    .optional(),
  ergoWifiCredentials: z
    .array(
      z.object({
        email: z.string().email(),
        password: z.string(),
        remoteStyle: z.enum(['L', 'M', 'H']).optional(),
      })
    )
    .optional(),
  ergoMotionDevices: z
    .array(
      z.object({
        friendlyName: z.string(),
        ipAddress: z.string(),
        remoteStyle: z.enum(['L', 'M', 'H']).optional(),
      })
    )
    .optional(),
  logicdataDevices: z
    .array(
      z.object({
        name: z.string(),
        friendlyName: z.string(),
        ipAddress: z.string().optional(),
      })
    )
    .optional(),
  bleProxies: z
    .array(
      z.object({
        host: z.string(),
        port: z.number().int().min(1).max(65536).optional(),
        password: z.string().optional(),
        encryptionKey: z.string().optional(),
        expectedServerName: z.string().optional(),
      })
    )
    .optional(),
  richmatDevices: z
    .array(
      z.object({
        name: z.string(),
        friendlyName: z.string(),
        remoteCode: z.string(),
        stayConnected: z.boolean().optional(),
      })
    )
    .optional(),
  linakDevices: z
    .array(
      z.object({
        name: z.string(),
        friendlyName: z.string(),
        hasMassage: z.boolean().optional(),
        motorCount: z.number().int().optional(),
      })
    )
    .optional(),
  solaceDevices: z
    .array(
      z.object({
        name: z.string(),
        friendlyName: z.string(),
      })
    )
    .optional(),
  motoSleepDevices: z
    .array(
      z.object({
        name: z.string(),
        friendlyName: z.string(),
        stayConnected: z.boolean().optional(),
      })
    )
    .optional(),
  reverieDevices: z
    .array(
      z.object({
        name: z.string(),
        friendlyName: z.string(),
      })
    )
    .optional(),
  leggettPlattDevices: z
    .array(
      z.object({
        name: z.string(),
        friendlyName: z.string(),
      })
    )
    .optional(),
  okimatDevices: z
    .array(
      z.object({
        name: z.string(),
        friendlyName: z.string(),
        remoteCode: z.string(),
      })
    )
    .optional(),
  keesonDevices: z
    .array(
      z.object({
        name: z.string(),
        friendlyName: z.string(),
        stayConnected: z.boolean().optional(),
        aliases: z.string().optional(),
      })
    )
    .optional(),
  octoDevices: z
    .array(
      z.object({
        name: z.string(),
        friendlyName: z.string(),
        pin: z.string().optional(),
      })
    )
    .optional(),
  scannerDevices: z
    .array(
      z.object({
        name: z.string(),
        pair: z.boolean().optional(),
      })
    )
    .optional(),
});
