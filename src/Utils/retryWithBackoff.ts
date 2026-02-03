import { logWarn } from './logger';
import { wait } from './wait';

export interface RetryOptions {
  maxRetries?: number; // undefined = infinite retries
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  isRetryableError?: (error: any) => boolean;
  onRetry?: (error: any, attempt: number, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'maxRetries' | 'isRetryableError' | 'onRetry'>> = {
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Retries a function with exponential backoff
 * @param fn Function to execute (can be async)
 * @param options Retry configuration options
 * @returns Promise that resolves with the function result or rejects after max retries
 */
export const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> => {
  const {
    maxRetries,
    initialDelayMs = DEFAULT_OPTIONS.initialDelayMs,
    maxDelayMs = DEFAULT_OPTIONS.maxDelayMs,
    backoffMultiplier = DEFAULT_OPTIONS.backoffMultiplier,
    isRetryableError = () => true,
    onRetry,
  } = options;

  let attempt = 0;
  let delayMs = initialDelayMs;
  let lastError: any;

  while (maxRetries === undefined || attempt < maxRetries) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      attempt++;

      // Check if error is retryable
      if (!isRetryableError(error)) {
        throw error;
      }

      // Check if we've exceeded max retries
      if (maxRetries !== undefined && attempt >= maxRetries) {
        throw error;
      }

      // Calculate next delay with exponential backoff
      const currentDelay = Math.min(delayMs, maxDelayMs);
      
      // Call onRetry callback if provided
      if (onRetry) {
        onRetry(error, attempt, currentDelay);
      } else {
        const errorMessage = error?.message || String(error);
        // NOTE: pino doesn't reliably print extra args unless you use format specifiers.
        logWarn(`[Retry] Attempt ${attempt} failed, retrying in ${currentDelay / 1000}s: ${errorMessage}`);
      }

      // Wait before retrying
      await wait(currentDelay);

      // Calculate next delay
      delayMs = Math.min(delayMs * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError;
};

/**
 * Helper to check if an error is a socket/BLE timeout error
 */
export const isSocketOrBLETimeoutError = (error: any): boolean => {
  const errorMessage = error?.message || String(error);
  const errorCode = error?.code || '';
  const lower = String(errorMessage).toLowerCase();
  
  return (
    errorCode === 'ECONNRESET' ||
    errorCode === 'ECONNREFUSED' ||
    errorCode === 'ETIMEDOUT' ||
    errorCode === 'EHOSTUNREACH' ||
    errorCode === 'ENETUNREACH' ||
    errorMessage.includes('ECONNRESET') ||
    lower.includes('socket') ||
    lower.includes('reset') ||
    lower.includes('timeout') ||
    lower.includes('ehostunreach') ||
    lower.includes('enetunreach') ||
    lower.includes('hostunreach') ||
    lower.includes('network unreachable') ||
    lower.includes('host unreachable') ||
    // ESPHome BLE proxy / ESP-IDF failure patterns
    lower.includes('status=133') ||
    lower.includes('reason=0x100') ||
    lower.includes('reason 0x100') ||
    lower.includes('gatt_busy') ||
    // Our higher-level fast-fail messages
    lower.includes('proxy ignored connection request') ||
    lower.includes('proxy reported hard ble failure') ||
    lower.includes('write after end') ||
    // ESPHome API framing/protocol corruption (Noise/plaintext mismatch or garbage bytes).
    lower.includes('unknown protocol selected by server') ||
    lower.includes('bad format. expected 1') ||
    lower.includes('bad format') ||
    // Common when the underlying ESPHome API socket is dead but calls continue.
    lower.includes('not authorized') ||
    lower.includes('not connected') ||
    lower.includes('socket is not connected') ||
    // Our guardrail when the API is reconnecting but not ready yet.
    lower.includes('esphome api not ready') ||
    // Known message waits (older library wording)
    errorMessage.includes('BluetoothDeviceConnectionResponse') ||
    errorMessage.includes('BluetoothGATTGetServicesDoneResponse')
  );
};

