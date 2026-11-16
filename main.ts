import { createApp } from './app.ts';

// How long a single register / done request may run before we give up on
// that attempt and try again, in milliseconds.
const REQUEST_TIMEOUT_MS = 30_000;

// Backoff for retries: first pause 250 ms, doubling each time, never
// longer than 2,000 ms, and never doubling past 2^8.
const RETRY_BASE_MS = 250;
const RETRY_CAP_MS = 2_000;
const RETRY_MAX_SHIFT = 8;

// The env endpoint, without any trailing slashes so URL building below
// never produces a double slash.
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (ENV_URL === '') {
  process.stderr.write(
    '[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n',
  );
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function retryDelay(attempt: number): number {
  const shift = Math.min(attempt, RETRY_MAX_SHIFT);
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** shift);
}

async function register(port: number): Promise<void> {
  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // The request itself failed (network, timeout, abort): pause and retry.
      await sleep(retryDelay(attempt));
      attempt += 1;
      continue;
    }

    if (response.status === 200 || response.status === 409) {
      return;
    }

    if (response.status === 400 || response.status === 405) {
      const bodyText = await response.text();
      throw new Error(`register answered HTTP ${response.status}: ${bodyText}`);
    }

    // Any other status is transient: pause and retry.
    await sleep(retryDelay(attempt));
    attempt += 1;
  }
}

async function waitForDone(): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetch(`${ENV_URL}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload !== null && typeof payload === 'object' && payload.done === true) {
          return;
        }
      }
    } catch {
      // Network failure, timeout, or an unparsable body: just retry below.
    }
    await sleep(retryDelay(attempt));
    attempt += 1;
  }
}

async function main(): Promise<void> {
  const server = createApp();

  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });

  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  const port = bound.port;

  console.log(`[entry] listening on port ${port}`);

  await register(port);
  console.log('[entry] registered; waiting for the env to say done');

  await waitForDone();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  console.log('[entry] done');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[entry] ${message}\n`);
  process.exit(1);
}
