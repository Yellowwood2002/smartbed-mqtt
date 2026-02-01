import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          ignore: 'pid,hostname',
          translateTime: 'SYS:standard',
        },
      },
});

/**
 * Log de-dupe / rate limit
 *
 * Why this exists:
 * - BLE discovery/connect failures can be persistent when a device is asleep or out of range.
 * - Without rate limiting, retry loops spam logs, making real failures hard to find and stressing storage/UI.
 *
 * How to use:
 * - Provide a stable key (e.g. "esphome:search:<deviceNames>") and a window in ms.
 * - The first call logs; subsequent calls within the window are suppressed.
 */
const lastLogAtByKey = new Map<string, number>();
const shouldLog = (key: string, windowMs: number) => {
  const now = Date.now();
  const last = lastLogAtByKey.get(key) ?? 0;
  if (now - last < windowMs) return false;
  lastLogAtByKey.set(key, now);
  return true;
};

export const logInfo = (message: any, ...optionalParams: any[]) => {
  logger.info(message, ...optionalParams);
};
export const logDebug = (message: any, ...optionalParams: any[]) => {
  logger.debug(message, ...optionalParams);
};
export const logWarn = (message: any, ...optionalParams: any[]) => {
  logger.warn(message, ...optionalParams);
};
export const logError = (message: any, ...optionalParams: any[]) => {
  logger.error(message, ...optionalParams);
};

export const logInfoDedup = (key: string, windowMs: number, message: any, ...optionalParams: any[]) => {
  if (!shouldLog(key, windowMs)) return;
  logInfo(message, ...optionalParams);
};
export const logDebugDedup = (key: string, windowMs: number, message: any, ...optionalParams: any[]) => {
  if (!shouldLog(key, windowMs)) return;
  logDebug(message, ...optionalParams);
};
export const logWarnDedup = (key: string, windowMs: number, message: any, ...optionalParams: any[]) => {
  if (!shouldLog(key, windowMs)) return;
  logWarn(message, ...optionalParams);
};

export default logger;