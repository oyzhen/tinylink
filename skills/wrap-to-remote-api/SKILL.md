---
name: wrap-to-remote-api
description: |
    Generate justlink code that exposes a plain object in a Worker and wraps it
    as a RemoteApi proxy on the main thread. Use when the user wants to create
    a new Worker integration, add methods to an existing Worker, or convert a
    plain object into a remote-callable API.
triggers:
    - 'create worker'
    - 'expose impl'
    - 'wrap worker'
    - 'RemoteApi'
    - 'remote api'
    - 'worker rpc'
---

# Wrap plain object → RemoteApi

## Overview

justlink turns a plain JS object into a type-safe remote proxy across threads.
Two sides:

| Side        | Function                              | Import from                                            | Runs inside |
| ----------- | ------------------------------------- | ------------------------------------------------------ | ----------- |
| Worker      | `expose(ctx, impl)`                   | `justlink/browser`, `justlink/node`, `justlink/memory` | Worker      |
| Main thread | `wrap<Impl>(ctx)` → `RemoteApi<Impl>` | same                                                   | main thread |

## Step-by-step

### 1. Define the implementation object

```ts
// worker-impl.ts
export const impl = {
    greet(name: string) {
        return `Hello, ${name}!`;
    },
    add(a: number, b: number) {
        return a + b;
    },
    // Nested objects are auto-proxied
    math: {
        multiply(a: number, b: number) {
            return a * b;
        },
    },
};

// Export the type — needed for the generic parameter on the main thread
export type Impl = typeof impl;
```

### 2. Expose it in the Worker

Pick the correct adapter:

**Browser (Vite)** — context is `self`:

```ts
// worker.ts
import { expose } from 'justlink/browser';
import { impl } from './worker-impl';
expose(self, impl);
```

**Node.js `worker_threads`** — context is `parentPort`:

```ts
// worker.ts
import { parentPort } from 'node:worker_threads';
import { expose } from 'justlink/node';
import { impl } from './worker-impl';
expose(parentPort!, impl);
```

**In-memory (testing, no real Worker)** — use `createMemoryPair`:

```ts
import { createMemoryPair, expose, wrap } from 'justlink/memory';
import { impl } from './worker-impl';

const { host, worker } = createMemoryPair();
expose(worker, impl);
const api = wrap(host); // no generic needed — inferred from impl
```

### 3. Wrap on the main thread

```ts
// main.ts
import { wrap } from 'justlink/browser'; // or 'justlink/node'
import type { Impl } from './worker-impl';
import MyWorker from './worker?worker'; // Vite worker import

const api = wrap<Impl>(new MyWorker());

// Call methods like regular async functions
const greeting = await api.greet('world');
const sum = await api.add(1, 2);
const product = await api.math.multiply(3, 4);
```

## Type cheat sheet

```ts
import type { RemoteApi } from 'justlink/browser'; // or node / memory

// The return type of wrap<Impl>(ctx)
type MyApi = RemoteApi<Impl>;

// RemoteApi<T> = RemoteObject<T> & { $terminate(): Promise<void> }
// RemoteObject<T> — methods return Promise<Awaited<ReturnType>>,
//                   non-method properties return Promise<Awaited<T>>,
//                   plus $get / $exec / $eval escape hatches.
```

## Escape hatches on every RemoteApi

| Method                       | Description                                    |
| ---------------------------- | ---------------------------------------------- |
| `api.$get(key)`              | Read a remote property dynamically             |
| `api.$exec(method, ...args)` | Call a method by name                          |
| `api.$eval(fn, deps?)`       | Run arbitrary code inside the Worker           |
| `api.$terminate()`           | Shut down the Worker, reject all pending calls |

## Pitfalls

- `$eval` callbacks are `.toString()` serialized — no closures over
  non-serializable values. Pass dependencies via the `deps` array.
- `expose()` and `wrap()` must use the **same adapter** (browser↔browser,
  node↔node, memory↔memory).
- Return objects with methods (`{ inc() {} }`) become remote proxies.
  Return plain data (`{ name: 'Alice' }`) is structured-cloned directly.
- `export type { RemoteApi }` is re-exported from each adapter module,
  so you don't need to import from `core` directly.
