import { createExpose, createWrap, type Adapter } from './core.ts';

const peers = new WeakMap<object, { handler?: (data: readonly unknown[]) => void; peer?: object }>();

const ensurePeer = (ctx: object) => {
    const entry = peers.get(ctx) ?? {};
    peers.set(ctx, entry);
    return entry;
};

export const createMemoryPair = () => {
    const host = {};
    const worker = {};
    ensurePeer(host).peer = worker;
    ensurePeer(worker).peer = host;
    return { host, worker };
};

const adapter: Adapter<object> = [
    // emit: directly invoke the peer's handler (in-process, no serialization)
    (ctx, data) => {
        const entry = ensurePeer(ctx);
        if (entry.peer) {
            peers.get(entry.peer)?.handler?.(data);
        }
    },
    // listen: register the handler on this side
    (ctx, handler) => {
        ensurePeer(ctx).handler = handler;
    },
    // terminate: clear the peer link
    ctx => {
        const entry = peers.get(ctx);
        if (entry?.peer) {
            const peerEntry = peers.get(entry.peer);
            if (peerEntry) {
                peerEntry.handler = undefined;
                peerEntry.peer = undefined;
            }
            peers.delete(entry.peer);
        }
        peers.delete(ctx);
        return Promise.resolve();
    },
];

export const expose = createExpose(adapter);
export const wrap = createWrap(adapter);

export type { RemoteApi } from './core.ts';
