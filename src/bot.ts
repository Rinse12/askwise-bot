import { RegistryWatcher } from "./registry.js";
import { CommunityWatcher, type BotContext } from "./watcher.js";

export interface RunningBot {
    watch(address: string): Promise<void>;
    stop(): Promise<void>;
}

// Watches every community installed earlier plus the registry, which adds new ones as owners register.
export async function startBot(ctx: BotContext): Promise<RunningBot> {
    const watchers = new Map<string, CommunityWatcher>();
    const watch = async (address: string) => {
        const existing = watchers.get(address);
        if (existing && !existing.isStopped) return;
        const watcher = new CommunityWatcher(ctx, address);
        watchers.set(address, watcher);
        try {
            await watcher.start();
        } catch (error) {
            watchers.delete(address);
            console.error(`[${address}] could not start watching:`, error);
        }
    };

    const { db, config } = ctx;
    const toWatch = [...db.listCommunities("installed"), ...db.listCommunities("needs_reinstall")].map((row) => row.address);
    await Promise.all(toWatch.map(watch));

    let registry: RegistryWatcher | undefined;
    if (config.registryAddress) {
        registry = new RegistryWatcher(ctx, config.registryAddress, watch);
        await registry.start();
    } else console.warn("REGISTRY_ADDRESS is not set: new communities cannot register");

    return {
        watch,
        stop: async () => {
            await Promise.allSettled([registry?.stop(), ...[...watchers.values()].map((watcher) => watcher.stop())]);
        }
    };
}
