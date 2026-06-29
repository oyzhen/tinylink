/**
 * Test implementation object — every method exercises a distinct branch in `core.ts`.
 *
 *  | Method / Property        | Core branch covered                                    |
 *  |--------------------------|--------------------------------------------------------|
 *  | `x`                     | $get scalar                                             |
 *  | `get counter()`         | $get getter (returns value + target as owner)           |
 *  | `add`                   | $exec pure function                                     |
 *  | `increment`             | $exec with closure state mutation                       |
 *  | `createObject`          | return plain object (isClonable, !looksLikeRemote)      |
 *  | `createArray`           | return array (isClonable)                               |
 *  | `createTypedArray`      | return Uint8Array (transferable + clonable)             |
 *  | `sumBytes`              | consume Uint8Array transferable                         |
 *  | `paintCanvas`           | OffscreenCanvas → ImageBitmap (browser-only)            |
 *  | `math`                  | nested object w/ methods (looksLikeRemoteObject=true)   |
 *  | `createCounter`         | returned object w/ methods + async                       |
 *  | `fn2`                   | return object with `this`-aware method                  |
 *  | `throwError`            | Error throw (.message extraction)                        |
 *  | `throwString`           | non-Error string throw (String() fallback)              |
 *  | `throwNull`             | null throw ('Unknown error' fallback)                    |
 *  | `throwObjectWithStack`  | non-Error object with .stack property                    |
 *  | `rejectAsync`           | async rejection (Promise rejection path)                |
 *  | `getAdder`              | return standalone function (no __this, isFuncTarget)     |
 *  | `getProfile`            | plain object (looksLikeRemote=false)                     |
 *  | `getTree`               | deeply nested plain data (no methods)                    |
 *  | `getDate`               | Date return (isClonable for Date)                        |
 *  | `getPattern`            | RegExp return (isClonable for RegExp)                    |
 *  | `getMap` / `getSet`     | Map/Set return (isClonable + collectTransferables)       |
 *  | `getMapWithBuffer`      | Map containing transferable                              |
 *  | `getSetWithBuffer`      | Set containing transferable                              |
 *  | `getFunctions`          | array of functions (resolveValue array recursion)        |
 *  | `delayedAdd`            | async success (Promise resolution path)                  |
 */

let counter = 0;

const impl = {
    // -- scalar property --
    x: 'hello',

    // -- a promise
    p: Promise.resolve('world'),

    // -- getter (exercises $get → sendResponse with target as owner) --
    get counter() {
        return counter;
    },

    // -- pure function (no side-effect, returns primitive) --
    add(a: number, b: number) {
        return a + b;
    },

    // -- closure state mutation --
    increment(n: number) {
        return (counter += n);
    },

    // -- return plain object (isClonable=true, looksLikeRemoteObject=false) --
    createObject() {
        return { a: 1 };
    },

    // -- return array (isClonable=true) --
    createArray() {
        return [1, 2, 3];
    },

    // -- return Uint8Array (isClonable=true + isTransferable=true) --
    createTypedArray() {
        return new Uint8Array([10, 20, 30]);
    },

    // -- consume transferable Uint8Array --
    sumBytes(buf: Uint8Array) {
        return buf.reduce((sum, x) => sum + x, 0);
    },

    // -- OffscreenCanvas → ImageBitmap (browser-only) --
    paintCanvas(canvas: OffscreenCanvas) {
        canvas.width = 2;
        canvas.height = 2;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Failed to get 2D context');
        }
        ctx.fillStyle = 'red';
        ctx.fillRect(0, 0, 2, 2);
        return canvas.transferToImageBitmap();
    },

    // -- nested object with methods (looksLikeRemoteObject = true) --
    math: (() => {
        let val = 10;
        return {
            get value() {
                return val;
            },
            add(n: number) {
                return (val += n);
            },
            reset() {
                val = 10;
                return val;
            },
        };
    })(),

    // -- return object with methods + this binding + async --
    createCounter(init: number) {
        let count = init;
        return {
            inc() {
                return ++count;
            },
            dec() {
                return --count;
            },
            get() {
                return count;
            },
            async getAsync() {
                return count;
            },
        };
    },

    // -- return object with this-aware method (fn2 pattern) --
    fn2() {
        return {
            a: 1,
            inc(v: number) {
                this.a += v;
                return this.a;
            },
        };
    },

    // -- Error throw (sendError → result instanceof Error → .message) --
    throwError() {
        throw new Error('intentional error');
    },

    // -- Non-Error throw (sendError → String(result)) --
    throwString() {
        throw 'string error';
    },

    // -- Null throw (sendError → 'Unknown error') --
    throwNull() {
        throw null as unknown as Error;
    },

    // -- Non-Error object with .stack property (sendError → result.stack) --
    throwObjectWithStack() {
        throw { stack: 'custom stack trace', message: '' } as unknown as Error;
    },

    // -- Async rejection (Promise.resolve().then(_, e) path) --
    async rejectAsync() {
        throw new Error('async rejection');
    },

    // -- Return standalone function (no __this in ref descriptor) --
    getAdder() {
        return (a: number, b: number) => a + b;
    },

    // -- Return plain object (looksLikeRemoteObject = false, isClonable = true) --
    getProfile() {
        return { name: 'Alice', age: 30 };
    },

    // -- Return deeply nested plain data (no methods) --
    getTree() {
        return { left: { value: 1 }, right: { value: 2 } };
    },

    // -- Return Date (isClonable = true for Date) --
    getDate() {
        return new Date('2024-01-01');
    },

    // -- Return RegExp (isClonable = true for RegExp) --
    getPattern() {
        return /test/gi;
    },

    // -- Return Map (isClonable + collectTransferables Map recursion) --
    getMap() {
        return new Map<string, number>([
            ['a', 1],
            ['b', 2],
        ]);
    },

    // -- Return Set (isClonable + collectTransferables Set recursion) --
    getSet() {
        return new Set([1, 2, 3]);
    },

    // -- Map containing transferable (collectTransferables Map key/value recursion) --
    getMapWithBuffer() {
        return new Map([['data', new Uint8Array([1, 2])]]);
    },

    // -- Set containing transferable (collectTransferables Set recursion) --
    getSetWithBuffer() {
        return new Set([new Uint8Array([3, 4])]);
    },

    // -- MessagePort transferable (exercises isTransferable hasMessagePort branch) --
    passMessagePort(port: MessagePort) {
        return port instanceof MessagePort;
    },

    // -- Async success (Promise resolution path) --
    async delayedAdd(a: number, b: number) {
        return a + b;
    },

    // -- Return array of functions (resolveValue array recursion) --
    getFunctions() {
        return [(x: number) => x * 2, (x: number) => x * 3];
    },
} as const;

export type Impl = typeof impl;

export { impl };
