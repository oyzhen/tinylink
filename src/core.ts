// === Type-level helpers ===
// https://developer.mozilla.org/docs/Web/API/Transferable
// https://nodejs.org/api/worker_threads.html#worker_threads_port_postmessage_value_transferlist
type TransferList = unknown[];

/**
 * Extract keys of Impl whose value is a callable function.
 * Used as a constraint on K (K extends MethodKeys<Impl>) so callers
 * get autocomplete, while the implementation types use K extends keyof Impl.
 */
type MethodKeys<Impl extends Record<string, unknown>> = {
    [K in keyof Impl]: Impl[K] extends (...args: readonly any[]) => any ? K : never;
}[keyof Impl];

/**
 * Safely extract Parameters<T> — returns `never` (not any) when T is not a function.
 * Using a conditional type here lets TypeScript resolve it correctly even when
 * it can't prove T is a function from the generic constraint alone.
 */
type SafeParameters<T> = T extends (...args: readonly any[]) => any ? Parameters<T> : never;

/** Safely extract ReturnType<T>. */
type SafeReturnType<T> = T extends (...args: readonly any[]) => any ? ReturnType<T> : never;

/** Map each element of an array/tuple for remote wrapping — functions get Promise-wrapped returns. */
type RemoteArrayElements<T extends readonly unknown[]> = {
    [K in keyof T]: T[K] extends (...args: readonly any[]) => any
        ? (...args: Parameters<T[K]>) => Promise<Awaited<ReturnType<T[K]>>>
        : Promise<Awaited<T[K]>>;
};

/**
 * Detect if an array/tuple type contains any function elements.
 * Arrays with functions are NOT clonable at runtime → stored as refs → must be typed as remote.
 */
type ArrayHasFunctions<T> = [T] extends [readonly unknown[]]
    ? [Extract<T[number], (...args: any[]) => any>] extends [never]
        ? false
        : true
    : false;

/**
 * Return type of `exec`:
 *   - arrays containing functions → remote array (elements wrapped)
 *   - if the method returns an object → remote-object shape
 *   - otherwise → plain awaited value
 */
type ExecReturnType<T> =
    ArrayHasFunctions<Awaited<SafeReturnType<T>>> extends true
        ? Promise<RemoteArrayElements<Awaited<SafeReturnType<T>>>>
        : Awaited<SafeReturnType<T>> extends Record<string, unknown>
          ? Promise<RemoteObject<Awaited<SafeReturnType<T>>>>
          : Promise<Awaited<SafeReturnType<T>>>;

type RemoteMethodValue<T> = T extends (...args: readonly any[]) => any ? (...args: Parameters<T>) => ExecReturnType<T> : never;

type RemoteValue<T> = T extends Record<string, unknown> ? RemoteObject<T> : Awaited<T>;

type RemotePropertyValue<T> = T extends Record<string, unknown> ? RemoteObject<T> : Promise<Awaited<T>>;

// === Public types ===

/**
 * RemoteControl: low-level escape hatches available on every remote object.
 *   $get / $exec / $eval operate on the ref of *this* sub-object,
 *   so callers can drive method calls without relying on the proxy layout.
 */
type RemoteControl<T extends Record<string, unknown>> = {
    $get<K extends keyof T>(key: K): Promise<RemoteValue<T[K]>>;
    $exec<K extends MethodKeys<T>>(method: K, ...args: SafeParameters<T[K]>): ExecReturnType<T[K]>;
    $eval<R>(callback: (ref: T) => R): Promise<R>;
    $eval<A extends unknown[], R>(callback: (ref: T, ...args: A) => R, deps?: A): Promise<R>;
};

/**
 * RemoteObject: an object returned from a remote method call.
 *   - methods are callable directly (returning Promise<Awaited<ReturnType<...>>>)
 *   - non-method properties resolve to a promise of the remote value
 *   - $get / $exec / $eval for low-level access
 */
export type RemoteObject<T extends Record<string, unknown>> = {
    [K in keyof T as T[K] extends (...args: readonly any[]) => any ? K : never]: RemoteMethodValue<T[K]>;
} & {
    [K in keyof T as T[K] extends (...args: readonly any[]) => any ? never : K]: RemotePropertyValue<T[K]>;
} & RemoteControl<T>;

/** The proxy interface exposed to consumers. */
export type RemoteApi<Impl extends Record<string, unknown>> = RemoteObject<Impl> & {
    $terminate(): Promise<void>;
};

// === Wire protocol ===

const REQUEST = 'm$s';
const RESPONSE = 'm$r';
const OP_GET = 0 as const;
const OP_EXEC = 1 as const;
const OP_EVAL = 2 as const;
const OP_RELEASE = -1 as const; // internal-only, not part of the public opcode sequence

interface RefDescriptor {
    __ref: number;
    __kind?: 'function' | 'object';
    __this?: number;
}

const isRef = (obj: unknown): obj is RefDescriptor => typeof obj === 'object' && obj !== null && '__ref' in obj!;

// === Adapter ===

export type Adapter<Ctx> = [
    emit: (ctx: Ctx, data: readonly unknown[], transferList?: TransferList) => void,
    listen: (ctx: Ctx, handler: (data: readonly unknown[]) => void) => void,
    terminate: (ctx: Ctx) => Promise<void>,
];

// === createExpose ===

export const createExpose =
    <Ctx>([emit, listen]: Adapter<Ctx>) =>
    (ctx: Ctx, impl: Record<string, unknown>): void => {
        const refs = new Map<number, unknown>();
        let nextRef = 1; // 0 is reserved for the root `impl`

        const storeRef = (obj: unknown): number => {
            for (const [id, ref] of refs) {
                if (Object.is(ref, obj)) {
                    return id;
                }
            }
            const id = nextRef++;
            refs.set(id, obj);
            return id;
        };

        const toTransportValue = (value: unknown, owner?: unknown): unknown => {
            if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
                return value;
            }

            if (typeof value === 'function') {
                const refValue = { __ref: storeRef(value), __kind: 'function' } as RefDescriptor & { __this?: number };
                if (owner != null && (typeof owner === 'object' || typeof owner === 'function')) {
                    refValue.__this = storeRef(owner);
                }
                return refValue;
            }

            if (looksLikeRemoteObject(value)) {
                return { __ref: storeRef(value), __kind: 'object' };
            }

            return isClonable(value) ? value : { __ref: storeRef(value), __kind: 'object' };
        };

        const sendResponse = (id: number, err: boolean, result: unknown, extraTransferList?: TransferList, owner?: unknown): void => {
            if (err) {
                const msg = result instanceof Error ? result.message : ((result as any)?.stack ?? String(result ?? 'Unknown error'));
                emit(ctx, [RESPONSE, id, true, msg] as readonly unknown[]);
                return;
            }

            const value = toTransportValue(result, owner);
            const transferList = mergeTransferables(collectTransferables(value), extraTransferList);
            emit(ctx, [RESPONSE, id, false, value] as readonly unknown[], transferList);
        };

        const resolveExecPayload = (payload: unknown): { methodName: string; args: unknown[] } => {
            const payloadArray = Array.isArray(payload) ? payload : [payload];
            const [rawMethod, ...args] = payloadArray as [unknown, ...unknown[]];
            const methodName = typeof rawMethod === 'string' ? rawMethod : String(rawMethod);
            return { methodName, args };
        };

        const createLocalBinding = (target: unknown): unknown => {
            if (target == null || (typeof target !== 'object' && typeof target !== 'function')) {
                return target;
            }

            return new Proxy({} as Record<string, unknown>, {
                get(_, prop: string | symbol) {
                    if (prop === 'then' || prop === 'catch' || prop === 'finally') {
                        return;
                    }
                    if (typeof prop !== 'string') {
                        return;
                    }
                    if (prop === 'get' && !('get' in (target as object))) {
                        return (key: string) => (target as Record<string, unknown>)[key];
                    }
                    const value = (target as Record<string, unknown>)[prop];
                    if (typeof value === 'function') {
                        return (...args: unknown[]) => (value as (...args: unknown[]) => unknown).apply(target, args);
                    }
                    if (value != null && typeof value === 'object') {
                        return createLocalBinding(value);
                    }
                    return value;
                },
            });
        };

        listen(ctx, data => {
            if ((data as any)?.[0] !== REQUEST) {
                return;
            }

            const [, rawId, rawOp, refId, payload] = data as [string, number, number, number, unknown];
            const id = rawId;
            const op = rawOp as typeof OP_GET | typeof OP_EXEC | typeof OP_EVAL;
            const target = refId === 0 ? impl : refs.get(refId);

            if (target == null) {
                sendResponse(id, true, `Invalid ref ID: ${refId}`);
                return;
            }

            if (op === OP_GET) {
                const key = payload as string;
                try {
                    const value = (target as Record<string, unknown>)[key];
                    Promise.resolve(value).then(
                        r => sendResponse(id, false, r, undefined, target),
                        e => sendResponse(id, true, e),
                    );
                } catch (e) {
                    sendResponse(id, true, e);
                }
            } else if (op === OP_EXEC) {
                const { methodName, args } = resolveExecPayload(payload);
                const isFunctionTarget = typeof target === 'function';
                const fn = isFunctionTarget ? target : (target as Record<string, unknown>)[methodName];
                if (typeof fn !== 'function') {
                    sendResponse(id, true, `Method ${methodName} not found`);
                    return;
                }
                try {
                    const result = isFunctionTarget
                        ? (fn as (...a: unknown[]) => unknown)(...args)
                        : (fn as (...a: unknown[]) => unknown).apply(target, args);
                    Promise.resolve(result).then(
                        r => sendResponse(id, false, r),
                        e => sendResponse(id, true, e),
                    );
                } catch (e) {
                    sendResponse(id, true, e);
                }
            } else if (op === OP_EVAL) {
                const { callback: serializedFn, deps: evalDeps } = payload as { callback: string; deps: unknown[] };
                const fn = new Function('return (' + serializedFn + ')')();
                Promise.resolve()
                    .then(() => fn(createLocalBinding(target), ...evalDeps))
                    .then(
                        r => sendResponse(id, false, r),
                        e => sendResponse(id, true, e),
                    );
            } else if (op === OP_RELEASE) {
                refs.delete(refId);
            }
        });
    };

// === createWrap ===

export const createWrap =
    <Ctx>(adapter: Adapter<Ctx>) =>
    <Impl extends Record<string, unknown>>(ctx: Ctx): RemoteApi<Impl> => {
        const [emit, listen, doTerminate] = adapter;
        const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
        const TERMINATED_ERROR = new Error('The remote peer has been terminated');
        let terminated = false;
        /** Cache: refId → weak refs so proxies can be GC'd when no user-visible reference remains */
        const cache = new Map<number, { api: WeakRef<RemoteApi<any>>; obj: WeakRef<any>; refCount: number }>();
        /** When proxy pairs are GC'd, send OP_RELEASE back to the expose side */
        const registry = new FinalizationRegistry<{ refId: number }>(held => {
            const entry = cache.get(held.refId);
            if (entry) {
                entry.refCount--;
                if (entry.refCount <= 0) {
                    cache.delete(held.refId);
                }
            }
            emit(ctx, [REQUEST, 0, OP_RELEASE, held.refId, undefined] as readonly unknown[]);
        });
        let counter = 0;
        const nextId = () => counter++;
        const REF_ID = Symbol('refId');

        const proxyFor = (refId: number, kind: 'api' | 'obj' | 'fn', bindRefId?: number): RemoteApi<any> | unknown => {
            const ownerRef = bindRefId ?? refId;
            const cachedEntry = cache.get(refId);
            if (cachedEntry != null) {
                const hit = kind === 'api' ? cachedEntry.api.deref() : cachedEntry.obj.deref();
                if (hit != null) {
                    return hit;
                }
            }

            const createBinding = (propertyName: string, resolver: () => Promise<unknown>, promiseMode = true) => {
                const proxy = new Proxy(
                    (...args: unknown[]) => {
                        const transferList = collectTransferables(args);
                        return resolver().then(value => {
                            const targetRef = getRefId(value, ownerRef);
                            return request(OP_EXEC, targetRef, [propertyName, ...args], transferList);
                        });
                    },
                    {
                        get(_, prop: string | symbol) {
                            if (prop === 'then') {
                                if (!promiseMode) {
                                    return;
                                }
                                return (resolve: (value: unknown) => void, reject?: (reason?: unknown) => void) => {
                                    resolver().then(resolve, reject);
                                };
                            }
                            if (prop === 'catch') {
                                if (!promiseMode) {
                                    return;
                                }
                                return (reject: (reason?: unknown) => void) => resolver().catch(reject);
                            }
                            if (prop === 'finally') {
                                if (!promiseMode) {
                                    return;
                                }
                                return (finallyFn: () => void) => resolver().finally(finallyFn);
                            }
                            if (prop === REF_ID) {
                                return ownerRef;
                            }
                            if (prop === '$get') {
                                return (key: string) =>
                                    resolver().then(value => {
                                        const targetRef = getRefId(value, ownerRef);
                                        return request(OP_GET, targetRef, key, []);
                                    });
                            }
                            if (prop === '$exec') {
                                return (method: string, ...args: unknown[]) =>
                                    resolver().then(value => {
                                        const targetRef = getRefId(value, ownerRef);
                                        const transferList = collectTransferables(args);
                                        return request(OP_EXEC, targetRef, [method, ...args], transferList);
                                    });
                            }
                            if (prop === '$eval') {
                                return (callback: (ref: unknown) => unknown, deps?: unknown[]) =>
                                    resolver().then(value => {
                                        const targetRef = getRefId(value, ownerRef);
                                        const serialized = callback.toString();
                                        const transferList = collectTransferables(deps);
                                        return request(OP_EVAL, targetRef, { callback: serialized, deps: deps ?? [] }, transferList);
                                    });
                            }
                            if (typeof prop !== 'string') {
                                return;
                            }
                            return createBinding(
                                prop,
                                () =>
                                    resolver().then(value => {
                                        const targetRef = getRefId(value, ownerRef);
                                        return request(OP_GET, targetRef, prop, []);
                                    }),
                                true,
                            );
                        },
                    },
                );

                return proxy;
            };

            const apiProxy = new Proxy({} as Record<string, unknown>, {
                get(_, prop: string | symbol) {
                    if (prop === '$get') {
                        return (key: string) => request(OP_GET, refId, key, []);
                    }
                    if (prop === '$exec') {
                        return (method: string, ...args: unknown[]) => {
                            const transferList = collectTransferables(args);
                            return request(OP_EXEC, refId, [method, ...args], transferList);
                        };
                    }
                    if (prop === '$eval') {
                        return (callback: (ref: unknown) => unknown, deps?: unknown[]) => {
                            const serialized = callback.toString();
                            const transferList = collectTransferables(deps);
                            return request(OP_EVAL, refId, { callback: serialized, deps: deps ?? [] }, transferList);
                        };
                    }
                    if (prop === '$terminate') {
                        return () => {
                            terminated = true;
                            for (const { reject } of pending.values()) {
                                reject(TERMINATED_ERROR);
                            }
                            pending.clear();
                            return doTerminate(ctx);
                        };
                    }
                    if (prop === 'then' || prop === 'catch' || prop === 'finally') {
                        return;
                    }
                    if (typeof prop !== 'string') {
                        return;
                    }
                    return createBinding(prop, () => request(OP_GET, refId, prop, []));
                },
            });

            const objProxy = createBinding('', () => Promise.resolve(refId), false) as unknown as Record<string | symbol, unknown>;
            objProxy[REF_ID] = refId;

            const nextEntry = cache.get(refId) ?? { api: new WeakRef(apiProxy as RemoteApi<any>), obj: new WeakRef(objProxy), refCount: 0 };
            nextEntry.refCount++;
            cache.set(refId, nextEntry);
            registry.register(apiProxy, { refId });
            registry.register(objProxy, { refId });
            return kind === 'api' ? apiProxy : objProxy;
        };

        const getRefId = (value: unknown, fallback: number): number => {
            if (value != null && (typeof value === 'object' || typeof value === 'function')) {
                const internalRef = (value as Record<symbol, unknown>)[REF_ID];
                if (typeof internalRef === 'number') {
                    return internalRef;
                }
                const refDescriptor = value as { __ref?: unknown; __this?: unknown; __kind?: 'function' | 'object' };
                if (refDescriptor.__kind === 'function' && typeof refDescriptor.__this === 'number') {
                    return refDescriptor.__this;
                }
                if (typeof refDescriptor.__ref === 'number') {
                    return refDescriptor.__ref;
                }
            }
            return fallback;
        };

        const request = (
            op: typeof OP_GET | typeof OP_EXEC | typeof OP_EVAL,
            refId: number,
            payload: unknown,
            transferList?: TransferList,
        ): Promise<unknown> => {
            if (terminated) {
                return Promise.reject(TERMINATED_ERROR);
            }
            const id = nextId();
            return new Promise((resolve, reject) => {
                const resolveValue = (value: unknown): unknown => {
                    if (Array.isArray(value)) {
                        return value.map(item => resolveValue(item));
                    }
                    if (isRef(value)) {
                        return value.__kind === 'function'
                            ? proxyFor(value.__ref, 'fn', typeof value.__this === 'number' ? value.__this : undefined)
                            : proxyFor(value.__ref, 'obj');
                    }
                    return value;
                };

                pending.set(id, {
                    resolve: (result: unknown) => {
                        resolve(resolveValue(result));
                    },
                    reject: (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))),
                });
                emit(ctx, [REQUEST, id, op, refId, payload] as readonly unknown[], transferList);
            });
        };

        listen(ctx, data => {
            if ((data as any)?.[0] !== RESPONSE) {
                return;
            }
            const [, rawId, err, result] = data as [string, number, boolean, unknown];
            const rec = pending.get(rawId);
            if (rec == null) {
                return;
            }
            pending.delete(rawId);
            if (err) {
                rec.reject(new Error(String(result)));
            } else {
                rec.resolve(result);
            }
        });

        return proxyFor(0, 'api') as RemoteApi<Impl>;
    };

function isTransferable(value: unknown): value is Transferable {
    const hasMessagePort = typeof MessagePort !== 'undefined';
    const hasImageBitmap = typeof ImageBitmap !== 'undefined';
    const hasOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';

    return (
        value instanceof ArrayBuffer ||
        ArrayBuffer.isView(value) ||
        (hasMessagePort && value instanceof MessagePort) ||
        (hasImageBitmap && value instanceof ImageBitmap) ||
        (hasOffscreenCanvas && value instanceof OffscreenCanvas)
    );
}

function collectTransferables(value: unknown, seen = new Set<unknown>()): TransferList {
    if (value == null || (typeof value !== 'object' && typeof value !== 'function')) {
        return [];
    }

    if (isTransferable(value)) {
        if (ArrayBuffer.isView(value)) {
            seen.add(value.buffer as Transferable);
        } else {
            seen.add(value as Transferable);
        }
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectTransferables(item, seen);
        }
        return Array.from(seen);
    }

    if (value instanceof Map) {
        for (const [key, entry] of value) {
            collectTransferables(key, seen);
            collectTransferables(entry, seen);
        }
        return Array.from(seen);
    }

    if (value instanceof Set) {
        for (const entry of value) {
            collectTransferables(entry, seen);
        }
        return Array.from(seen);
    }

    for (const entry of Object.values(value as Record<string, unknown>)) {
        collectTransferables(entry, seen);
    }

    return Array.from(seen);
}

function looksLikeRemoteObject(value: unknown): boolean {
    if (value == null || typeof value !== 'object') {
        return false;
    }

    return Object.values(value as Record<string, unknown>).some(entry => typeof entry === 'function');
}

function isClonable(value: unknown): boolean {
    if (typeof value === 'function' || typeof value === 'symbol') {
        return false;
    }
    if (value instanceof Promise) {
        return false;
    }
    if (
        typeof value !== 'object' ||
        value === null ||
        value instanceof ArrayBuffer ||
        ArrayBuffer.isView(value) ||
        value instanceof Date ||
        value instanceof RegExp ||
        value instanceof Error ||
        value instanceof Boolean ||
        value instanceof Number ||
        value instanceof String ||
        (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) ||
        (typeof OffscreenCanvas !== 'undefined' && value instanceof OffscreenCanvas)
    ) {
        return true;
    }
    if (Array.isArray(value)) {
        return value.every(isClonable);
    }
    if (value instanceof Map) {
        for (const [key, val] of value) {
            if (!isClonable(key) || !isClonable(val)) {
                return false;
            }
        }
        return true;
    }
    if (value instanceof Set) {
        for (const val of value) {
            if (!isClonable(val)) {
                return false;
            }
        }
        return true;
    }
    for (const val of Object.values(value)) {
        if (!isClonable(val)) {
            return false;
        }
    }
    return true;
}

function mergeTransferables(...lists: Array<TransferList | undefined>): TransferList {
    const seen = new Set<unknown>();
    for (const list of lists) {
        for (const item of list ?? []) {
            seen.add(item);
        }
    }
    return Array.from(seen);
}
