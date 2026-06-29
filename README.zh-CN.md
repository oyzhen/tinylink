# justlink

[English Documentation](./README.md)

> 类型安全的 Worker 与线程 RPC 库——零依赖，本地调用般的体验。

灵感来源于 [`comlink`](https://github.com/GoogleChromeLabs/comlink) 和 [`minlink`](https://github.com/mizchi/minlink)。

## 这是什么？

Worker 能帮你把耗时的计算放到后台线程，但和 Worker 通信是一件很痛苦的事——你需要手动 `postMessage` / `onmessage`，手动序列化数据，手动追踪状态，代码很快就会变成一团面条。

**justlink 让你像调用本地函数一样调用 Worker 里的方法。** 你只需要定义一个对象，justlink 会自动帮你处理所有通信细节。

```ts
// 定义（在 worker 中）
const impl = {
    fibonacci(n: number) {
        // 这个计算会跑在 Worker 线程，不会卡 UI
        return n <= 1 ? n : fibonacci(n - 1) + fibonacci(n - 2);
    },
};

// 使用（在主线程中）
const api = wrap<Impl>(new MyWorker());
const result = await api.fibonacci(40); // 就这么简单！
```

没有 `postMessage`，没有 `onmessage`，没有手动序列化。只需要 `expose` 和 `wrap`，两个函数搞定。

## 为什么选 justlink？

|                  | justlink                      | 原生 postMessage    | Comlink |
| ---------------- | ----------------------------- | ------------------- | ------- |
| **代码量**       | 极少（2 个函数）              | 需要大量样板代码    | 较少    |
| **TypeScript**   | ✅ 完整类型推导 + 自动补全    | ❌ 需要手动定义类型 | ✅      |
| **依赖数**       | 0                             | 0                   | 1       |
| **嵌套对象**     | ✅ 自动代理                   | ❌ 需要手动处理     | ✅      |
| **Transferable** | ✅ 自动检测                   | ❌ 需要手动列举     | ✅      |
| **`$eval`**      | ✅ 可在 Worker 内执行任意逻辑 | ❌                  | ❌      |
| **Node.js**      | ✅ `worker_threads`           | ✅                  | ❌      |
| **内存模式**     | ✅ 主线程/非 Worker 场景      | ❌                  | ❌      |

## 安装

```bash
npm install justlink
```

### 导入方式

justlink 提供三个入口——根据你的运行环境选择：

| 导入路径           | 适用场景                         |
| ------------------ | -------------------------------- |
| `justlink/browser` | Web Worker（`self` / `Worker`）  |
| `justlink/node`    | `worker_threads`（`parentPort`） |
| `justlink/memory`  | 进程内（无需真实 Worker）        |

```ts
import { expose, wrap } from 'justlink/browser';
import { expose, wrap } from 'justlink/node';
import { expose, wrap, createMemoryPair } from 'justlink/memory';
import type { RemoteApi } from 'justlink/browser';
```

core 模块（`justlink/core`）提供底层 API，用于构建自定义 Adapter：

```ts
import { createExpose, createWrap, type Adapter, type RemoteApi } from 'justlink/core';
```

## 快速开始（5 分钟）

只需要 **3 步**，就能让 Worker 跑起来。

### 第 1 步：创建 worker 实现

新建 `worker-impl.ts`，写一个普通的对象，包含你想在 Worker 中执行的方法：

```ts
// worker-impl.ts
let count = 0;

export const impl = {
    // 普通方法
    greet(name: string) {
        return `你好, ${name}!`;
    },

    // 有状态的方法
    getCount() {
        return count;
    },
    increment(n = 1) {
        return (count += n);
    },

    // 嵌套对象也支持
    nested: {
        add(a: number, b: number) {
            return a + b;
        },
    },
};

// 导出类型——宿主端需要用到
export type Impl = typeof impl;
```

> 💡 **关键点：** 你只需要写一个普通对象，不需要继承任何基类，不需要注册任何装饰器。

### 第 2 步：在 Worker 中暴露它

#### 浏览器（Vite）

```ts
// worker.ts
import { expose } from 'justlink/browser';
import { impl } from './worker-impl';

expose(self, impl); // 一行搞定！
```

#### Node.js

```ts
// worker.ts
import { parentPort } from 'node:worker_threads';
import { expose } from 'justlink/node';
import { impl } from './worker-impl';

expose(parentPort!, impl); // 一行搞定！
```

### 第 3 步：在主线程中使用

#### 浏览器（Vite）

```ts
// main.ts
import { wrap } from 'justlink/browser';
import type { Impl } from './worker-impl';
import MyWorker from './worker?worker'; // Vite 的 Worker 导入语法

// 创建 worker，包装成类型安全的 api
const api = wrap<Impl>(new MyWorker());

// 🎉 就像调用本地函数一样！
console.log(await api.greet('世界')); // "你好, 世界!"
console.log(await api.increment(5)); // 5
console.log(await api.nested.add(1, 2)); // 3
```

#### Node.js

```ts
// main.ts
import { Worker } from 'node:worker_threads';
import { wrap } from 'justlink/node';
import type { Impl } from './worker-impl';

const worker = new Worker('./worker.js');
const api = wrap<Impl>(worker);

// 🎉 用法完全一样！
console.log(await api.greet('世界')); // "你好, 世界!"
console.log(await api.increment(5)); // 5
```

> 💡 **核心概念：** `expose` 是在 Worker 端"暴露"实现，`wrap` 是在主线程端"包装"成代理对象。两个函数配合使用，就完成了整个通信链路。

## 完整示例：在 Worker 中做计算

下面是一个更实际的例子——把计算密集型任务放到 Worker 中：

```ts
// worker-impl.ts
export const impl = {
    // 计算斐波那契数列——耗时操作，适合放到 Worker
    fibonacci(n: number): number {
        return n <= 1 ? n : this.fibonacci(n - 1) + this.fibonacci(n - 2);
    },

    // 处理数组
    sum(arr: number[]): number {
        return arr.reduce((a, b) => a + b, 0);
    },

    // 返回复杂对象
    analyze(text: string) {
        return {
            length: text.length,
            words: text.split(/\s+/).length,
            chars: new Set(text).size,
        };
    },
};

export type Impl = typeof impl;
```

```ts
// main.ts
const api = wrap<Impl>(new MyWorker());

// 计算密集型任务——不会卡 UI
const result = await api.fibonacci(40);

// 传递大数组——自动 transfer
const data = new Array(1000000).fill(0).map(() => Math.random());
const total = await api.sum(data);

// 获取复杂对象
const stats = await api.analyze('hello world');
console.log(stats.length); // 11
console.log(stats.words); // 2
console.log(stats.chars); // 9
```

## API 参考

### `expose(ctx, impl)`

**在 Worker 端调用。** 把一个普通对象暴露给主线程。

| 参数   | 说明                                                        |
| ------ | ----------------------------------------------------------- |
| `ctx`  | Worker 上下文。浏览器中是 `self`，Node.js 中是 `parentPort` |
| `impl` | 要暴露的对象，包含属性和方法                                |

### `wrap<Impl>(ctx): RemoteApi<Impl>`

**在主线程端调用。** 把 Worker 包装成一个类型安全的代理对象。

| 参数  | 说明                                                                      |
| ----- | ------------------------------------------------------------------------- |
| `ctx` | Worker 实例。浏览器中是 `new Worker(...)`，Node.js 中是 `new Worker(...)` |

返回值 `api` 上有以下特殊方法：

| 方法                         | 说明                 | 示例                           |
| ---------------------------- | -------------------- | ------------------------------ |
| `api.$get(key)`              | 读取远程属性         | `await api.$get('name')`       |
| `api.$exec(method, ...args)` | 动态调用方法         | `await api.$exec('add', 1, 2)` |
| `api.$eval(callback, deps?)` | 在 Worker 内执行回调 | 见下方 `$eval` 章节            |
| `api.$terminate()`           | 终止远程端           | `await api.$terminate()`       |

> 💡 大多数情况下你不需要这些方法——直接 `await api.methodName(args)` 就够了。这些是"逃生舱"，用于动态方法名等特殊场景。

#### `$terminate()` — 终止远程端

调用 `$terminate()` 后，远程端会被关闭，所有 pending 请求都会被 reject。后续的调用会**立即 reject**，不会进入无尽的 Promise pending 状态：

```ts
await api.$terminate();

// 以下调用都会立即 reject：
await api.someMethod(); // → reject: "The remote peer has been terminated"
await api.$get('x');    // → reject
await api.$eval(...);   // → reject
```

> 💡 这是一个安全机制——防止在已终止的远程端上意外挂起。

### `createMemoryPair()`

> `import { createMemoryPair } from 'justlink/memory'`

创建一对 `host` / `worker` 上下文，通过进程内直接调用通信，无需真实的 Worker。

典型场景：你封装了一套基于 justlink 的 API，希望它在 Worker 内外都能使用：

```ts
import { createMemoryPair, expose, wrap } from 'justlink/memory';
import { expose as browserExpose, wrap as browserWrap } from 'justlink/browser';

// 无论在哪个环境，api 的用法完全一样
let api: ImplApi;

if (isWorker) {
    // Worker 环境：走 postMessage
    browserExpose(self, impl);
    api = browserWrap<Impl>(self);
} else {
    // 主线程 / Node 主进程：进程内直接调用
    const { host, worker } = createMemoryPair();
    expose(worker, impl);
    api = wrap<Impl>(host);
}

// 以下代码在两种环境下行为完全一致
console.log(await api.someMethod());
```

## 进阶用法

### `$eval` — 在 Worker 内执行代码

普通调用（`api.methodName()`）是"在主线程调用，Worker 执行"。但有时候你需要"在 Worker 内部操作"——比如一次往返中同时读取多个属性。`$eval` 就是为此设计的：

```ts
// ❌ 普通方式：3 次往返通信
const a = await api.a;
const b = await api.nested.b;
const c = await api.nested.c;

// ✅ $eval：1 次往返通信
const result = await api.$eval(ref => {
    return ref.a + ref.nested.b + ref.nested.c;
});
```

#### 传递外部数据到 Worker

`$eval` 的回调会被序列化发送到 Worker 内部执行，所以不能使用外部变量。需要用第二个参数传递：

```ts
// 把 Uint8Array 传到 Worker 中处理
const data = new Uint8Array([1, 2, 3]);
const sum = await api.$eval(
    (ref, arr) => ref.processData(arr),
    [data], // deps 数组中的值会被自动 transfer
);
```

> ⚠️ **注意：** `$eval` 的回调通过 `.toString()` 序列化——**不能使用闭包**（外部变量）。如果需要传值，请使用 `deps` 参数。

### Transferable 对象

justlink 会自动检测并转移以下类型——无需手动管理 `transferList`：

- `ArrayBuffer`
- 类型数组（`Uint8Array`、`Float32Array` 等）
- `OffscreenCanvas`
- `ImageBitmap`
- `MessagePort`

> 💡 **什么是 Transfer？** 普通的数据传递是"复制"，Transfer 是"移动"——所有权从发送方转移到接收方，发送方的视图会失效。好处是零拷贝，性能更好。

### 错误处理

Worker 中抛出的错误会自动传递到主线程：

```ts
const api = wrap<Impl>(new MyWorker());

try {
    await api.willThrow(); // 假设 Worker 中这个方法会抛错
} catch (err) {
    console.error(err.message); // 错误信息会正确传递过来
}
```

### 嵌套对象与返回值

Worker 方法返回对象时，justlink 会自动代理，你可以继续调用返回对象上的方法：

```ts
const counter = await api.createCounter(0);
await counter.inc(); // 1
await counter.inc(); // 2
await counter.get(); // 2

// 继续深入嵌套
const obj = await api.getNestedObject();
await obj.child.deepMethod();
```

### 普通对象 vs 代理对象

justlink 根据返回值**是否包含函数**来决定传输方式：

**包含函数的对象** → 返回**远程代理**，每次访问触发 `postMessage` 通信：

```ts
// Worker 返回 { count: 1, inc() {...} }
const obj = await api.createCounter(0);
await obj.inc(); // 触发一次 postMessage
await obj.count; // 再触发一次 postMessage
```

**纯数据对象（不含函数）** → **structured clone**，返回普通 JS 对象，零开销：

```ts
// Worker 返回 { x: 1, y: [2, 3] }
const point = await api.getPoint();
// point 是普通对象——直接使用，同步读取
console.log(point.x); // 1 — 无 postMessage
console.log(point.y); // [2, 3]
```

> 💡 **提示：** 如果返回值意外包含了函数字段，它会被视为远程对象。如果不需要，可以在返回前移除。

#### `$get` 的返回值

```ts
// 纯数据 → 普通对象
const data = await api.$get('config');
console.log(data.theme); // 'dark' — 同步读取

// 包含函数 → 远程代理
const counter = await api.$get('counter');
await counter.inc(); // postMessage 往返
```

#### `$eval` 的返回值

```ts
// 返回纯数据 → 普通值
const sum = await api.$eval(ref => ref.a + ref.nested.a); // 4

// 返回包含函数的对象 → 远程代理
const counter = await api.$eval(ref => ref.createCounter(0));
await counter.inc(); // postMessage 往返
```

## 自定义传输层

核心的 `createExpose` / `createWrap` 函数接受泛型的 `Adapter` 元组，可以对接任意传输层：

```ts
import { createExpose, createWrap, type Adapter } from 'justlink/core';

const myAdapter: Adapter<MyContext> = [
    // emit(ctx, data, transferList?) — 向对方发送数据
    (ctx, data, transferList) => {
        /* ... */
    },
    // listen(ctx, handler) — 注册接收数据的回调
    (ctx, handler) => {
        /* ... */
    },
    // terminate(ctx) — 清理上下文
    ctx => Promise.resolve(),
];

export const expose = createExpose(myAdapter);
export const wrap = createWrap(myAdapter);
```

## 导入路径一览

```ts
import { expose, wrap } from 'justlink/browser'; // 浏览器 Web Worker
import { expose, wrap } from 'justlink/node'; // Node.js worker_threads
import { createMemoryPair, expose, wrap } from 'justlink/memory'; // 进程内通信
import { createExpose, createWrap } from 'justlink/core'; // 自定义传输层
```

## Agent Skills

justlink 附带了面向 AI 编程助手的 [skills](https://skills.sh)——可复用的知识，帮助 agent 生成正确的 justlink 代码。

```bash
npx skills add oyzhen/justlink
```

| Skill                | 描述                                                                     |
| -------------------- | ------------------------------------------------------------------------ |
| `wrap-to-remote-api` | 在 Worker 中暴露一个普通对象，并包装为 `RemoteApi` 代理                  |
| `universal-worker`   | 自动检测环境运行 Worker；不可用时通过 `justlink/memory` 降级为主进程执行 |

## 限制与注意事项

### `$eval` 闭包不生效

`$eval` 回调在 Worker 内部被 `.toString()` 序列化后执行 —— 闭包中的外部变量无法传递。请使用 `deps` 数组传参。

### `__ref` 对象

包含函数的对象无法被结构化克隆，将被存储为远程引用（ref）。如果你的纯数据对象恰巧含有 `__ref` 属性，justlink 会错误地将其视为远程引用描述符。如有冲突请换用其他属性名前缀。

## 环境要求

- TypeScript 5.0+
- 浏览器适配器需要支持 `?worker` 导入的打包工具（如 Vite、Webpack 等）

## 许可证

MIT
