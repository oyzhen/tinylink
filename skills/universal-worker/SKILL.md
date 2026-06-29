---
name: universal-worker
description: |
    Run a plain object inside a Web Worker with automatic environment detection.
    Falls back to in-process (main-thread) execution via justlink/memory when
    Worker is unavailable (SSR, older browsers, restricted contexts).
    Use when: the user wants "it just works everywhere", zero-config worker usage,
    or an isomorphic API that degrades gracefully.
triggers:
    - 'universal worker'
    - 'worker fallback'
    - 'worker not supported'
    - 'graceful degradation'
    - 'SSR worker'
    - 'auto worker'
    - 'run in worker if available'
---

# Universal Worker: auto-detect + graceful fallback

## Problem

You want heavy computation off the main thread **when possible**, but the app
must not break when Worker is unavailable (SSR, iframe sandboxing, CSP, etc.).

## Solution

justlink ships `justlink/memory` — an in-process adapter that bypasses
Worker entirely. By combining runtime detection with a conditional import,
you get **one API surface** that works everywhere:

| Environment              | What happens under the hood                     |
| ------------------------ | ----------------------------------------------- |
| Worker supported         | Real Web Worker, real `postMessage`             |
| Worker **not** supported | `createMemoryPair` runs impl in the main thread |

## File structure

```
src/
  worker-impl.ts      ← shared: the impl object + type
  create-worker.ts    ← universal factory (browser entry point)
  worker-runner.ts    ← Worker entry point (expose side)
```

## Step-by-step

### 1. Define the implementation

```ts
// src/worker-impl.ts
export const impl = {
    fibonacci(n: number): number {
        return n <= 1 ? n : fibonacci(n - 1) + fibonacci(n - 2);
    },
    heavySort(data: number[]): number[] {
        return [...data].sort((a, b) => a - b);
    },
};

export type Impl = typeof impl;
```

### 2. Write the Worker entry point

```ts
// src/worker-runner.ts
import { expose } from 'justlink/browser';
import { impl } from './worker-impl';

expose(self, impl);
```

> This file only runs inside the real Worker. Vite bundles it automatically
> when you use `new Worker(new URL('./worker-runner.ts', import.meta.url))`.

### 3. Create the universal factory

```ts
// src/create-worker.ts
import type { RemoteApi } from 'justlink/browser';
import type { Impl } from './worker-impl';

/**
 * Returns a RemoteApi<Impl> that works everywhere:
 * - Real Worker when `typeof Worker !== 'undefined'`
 * - In-process via justlink/memory when Worker is unavailable
 */
export async function createWorker(): Promise<RemoteApi<Impl>> {
    // --- Browser: Worker available ---
    if (typeof Worker !== 'undefined') {
        const { wrap } = await import('justlink/browser');
        const worker = new Worker(new URL('./worker-runner.ts', import.meta.url), { type: 'module' });
        return wrap<Impl>(worker);
    }

    // --- Fallback: in-process (SSR, restricted env, no Worker support) ---
    const { createMemoryPair, expose, wrap } = await import('justlink/memory');
    const { impl } = await import('./worker-impl');
    const { host, worker } = createMemoryPair();
    expose(worker, impl);
    return wrap<Impl>(host);
}
```

### 4. Use it — same API everywhere

```ts
// src/app.ts
import { createWorker } from './create-worker';
import type { Impl } from './worker-impl';

const api = await createWorker<Impl>();

// Identical call-site regardless of environment
const result = await api.fibonacci(40);
console.log(result);

// Don't forget cleanup when done
await api.$terminate();
```

## Advanced patterns

### With Vite `?worker&inline` (single-file deployment)

```ts
// src/create-worker.ts — inline variant (no separate worker file)
import type { RemoteApi } from 'justlink/browser';
import type { Impl } from './worker-impl';

export async function createWorker(): Promise<RemoteApi<Impl>> {
    if (typeof Worker !== 'undefined') {
        // Vite inlines the worker as a Blob URL
        const { wrap } = await import('justlink/browser');
        const WorkerFactory = await import('./worker-runner?worker&inline');
        const worker = new WorkerFactory.default();
        return wrap<Impl>(worker);
    }

    const { createMemoryPair, expose, wrap } = await import('justlink/memory');
    const { impl } = await import('./worker-impl');
    const { host, worker } = createMemoryPair();
    expose(worker, impl);
    return wrap<Impl>(host);
}
```

### With Node.js (server-side)

```ts
// src/create-worker.ts — Node.js variant
import type { RemoteApi } from 'justlink/node';
import type { Impl } from './worker-impl';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

export async function createWorker(): Promise<RemoteApi<Impl>> {
    const hasWorkerThreads = await import('node:worker_threads').then(m => typeof m.Worker === 'function').catch(() => false);

    if (hasWorkerThreads) {
        const { wrap } = await import('justlink/node');
        const { Worker: NodeWorker } = await import('node:worker_threads');
        const workerPath = fileURLToPath(new URL('./worker-runner.node.js', import.meta.url));
        const worker = new NodeWorker(workerPath);
        return wrap<Impl>(worker);
    }

    // Node.js without worker_threads — impossible in practice, but safe fallback
    const { createMemoryPair, expose, wrap } = await import('justlink/memory');
    const { impl } = await import('./worker-impl');
    const { host, worker } = createMemoryPair();
    expose(worker, impl);
    return wrap<Impl>(host);
}
```

### Singleton pattern (reuse across app)

```ts
// src/worker-singleton.ts
import { createWorker } from './create-worker';
import type { RemoteApi } from './worker-impl';

let instance: RemoteApi<Impl> | undefined;

export async function getWorker(): Promise<RemoteApi<Impl>> {
    if (!instance) {
        instance = await createWorker();
    }
    return instance;
}
```

## Type safety

```ts
import type { RemoteApi } from 'justlink/browser'; // identical to justlink/node
import type { Impl } from './worker-impl';

// The return type is always the same, regardless of environment
const api: RemoteApi<Impl> = await createWorker();

// Full autocomplete — this works whether running in a real Worker or in-memory
await api.fibonacci(10);
await api.heavySort([3, 1, 2]);
await api.$terminate();
```

## Key points

- **Dynamic imports** (`await import('justlink/browser')`) ensure the Worker
  code is tree-shaken when the fallback path is taken.
- `createMemoryPair` is synchronous internally — the `await` on `import()`
  is only for the module resolution, not for any I/O.
- `$terminate()` is idempotent and works on both real Workers and in-memory
  pairs. Always call it to clean up resources.
- The fallback path runs **on the main thread** — heavy computation will
  block. Use it only for environments where Worker is genuinely unavailable.
- For **SSR** (Next.js, Nuxt, etc.), the fallback path runs in Node.js.
  The impl object must not reference browser globals (`window`, `document`).
