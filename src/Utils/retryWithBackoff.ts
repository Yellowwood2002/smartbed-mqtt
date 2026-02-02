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
        logWarn(`[Retry] Attempt ${attempt} failed, retrying in ${currentDelay / 1000}s:`, errorMessage);
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
    errorMessage.includes('ECONNRESET') ||
    lower.includes('socket') ||
    lower.includes('reset') ||
    lower.includes('timeout') ||
    // ESPHome BLE proxy / ESP-IDF failure patterns
    lower.includes('status=133') ||
    lower.includes('reason=0x100') ||
    lower.includes('reason 0x100') ||
    lower.includes('gatt_busy') ||
    // Our higher-level fast-fail messages
    lower.includes('proxy ignored connection request') ||
    lower.includes('proxy reported hard ble failure') ||
    lower.includes('write after end') ||
    // Known message waits (older library wording)
    errorMessage.includes('BluetoothDeviceConnectionResponse') ||
    errorMessage.includes('BluetoothGATTGetServicesDoneResponse')
  );
};

