'use strict';

/**
 * fetch with a timeout that is actually cleaned up.
 *
 * AbortSignal.timeout() leaves its timer armed even after the request settles,
 * which keeps the event loop alive (and on Windows can trip a libuv assertion
 * when the process exits while the handle is still closing). An explicit
 * controller + clearTimeout avoids both.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout };
