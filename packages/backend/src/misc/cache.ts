import { redisClient } from "@/db/redis.js";
import { encode, decode } from "msgpackr";
import { ChainableCommander } from "ioredis";
import {
	Blockings,
	ChannelFollowings,
	Followings,
	Mutings,
	RenoteMutings,
	UserProfiles,
} from "@/models/index.js";
import { IsNull } from "typeorm";

export class Cache<T> {
	private ttl: number;
	private prefix: string;

	constructor(name: string, ttlSeconds: number) {
		this.ttl = ttlSeconds;
		this.prefix = `cache:${name}`;
	}

	private prefixedKey(key: string | null): string {
		return key ? `${this.prefix}:${key}` : this.prefix;
	}

	public async set(
		key: string | null,
		value: T,
		transaction?: ChainableCommander,
	): Promise<void> {
		const _key = this.prefixedKey(key);
		const _value = Buffer.from(encode(value));
		const commander = transaction ?? redisClient;
		await commander.set(_key, _value, "EX", this.ttl);
	}

	public async exists(...keys: string[]): Promise<boolean> {
		return (
			(await redisClient.exists(keys.map((key) => this.prefixedKey(key)))) > 0
		);
	}

	public async get(key: string | null, renew = false): Promise<T | undefined> {
		const _key = this.prefixedKey(key);
		const cached = await redisClient.getBuffer(_key);
		if (cached === null) return undefined;

		if (renew) await redisClient.expire(_key, this.ttl);

		return decode(cached) as T;
	}

	public async getAll(renew = false): Promise<Map<string, T>> {
		const keys = await redisClient.keys(`${this.prefix}*`);
		const map = new Map<string, T>();
		if (keys.length === 0) {
			return map;
		}
		const values = await redisClient.mgetBuffer(keys);

		for (const [i, key] of keys.entries()) {
			const val = values[i];
			if (val !== null) {
				map.set(key, decode(val) as T);
			}
		}

		if (renew) {
			const trans = redisClient.multi();
			for (const key of map.keys()) {
				trans.expire(key, this.ttl);
			}
			await trans.exec();
		}

		return map;
	}

	public async delete(...keys: (string | null)[]): Promise<void> {
		if (keys.length > 0) {
			const _keys = keys.map((key) => this.prefixedKey(key));
			await redisClient.del(_keys);
		}
	}

	/**
	 * Returns if cached value exists. Otherwise, calls fetcher and caches.
	 * Overwrites cached value if invalidated by the optional validator.
	 */
	public async fetch(
		key: string | null,
		fetcher: () => Promise<T>,
		renew = false,
		validator?: (cachedValue: T) => boolean,
	): Promise<T> {
		const cachedValue = await this.get(key, renew);
		if (cachedValue !== undefined) {
			if (validator) {
				if (validator(cachedValue)) {
					// Cache HIT
					return cachedValue;
				}
			} else {
				// Cache HIT
				return cachedValue;
			}
		}

		// Cache MISS
		const value = await fetcher();
		await this.set(key, value);
		return value;
	}

	/**
	 * Returns if cached value exists. Otherwise, calls fetcher and caches if the fetcher returns a value.
	 * Overwrites cached value if invalidated by the optional validator.
	 */
	public async fetchMaybe(
		key: string | null,
		fetcher: () => Promise<T | undefined>,
		renew = false,
		validator?: (cachedValue: T) => boolean,
	): Promise<T | undefined> {
		const cachedValue = await this.get(key, renew);
		if (cachedValue !== undefined) {
			if (validator) {
				if (validator(cachedValue)) {
					// Cache HIT
					return cachedValue;
				}
			} else {
				// Cache HIT
				return cachedValue;
			}
		}

		// Cache MISS
		const value = await fetcher();
		if (value !== undefined) {
			await this.set(key, value);
		}
		return value;
	}
}

export class SetCache {
	private readonly key: string;
	private readonly fetchedKey: string;
	private readonly fetcher: () => Promise<string[]>;

	protected constructor(
		name: string,
		userId: string,
		fetcher: () => Promise<string[]>,
	) {
		this.key = `setcache:${name}:${userId}`;
		this.fetchedKey = `${this.key}:fetched`;
		this.fetcher = fetcher;
	}

	protected async fetch() {
		// Sync from DB if nothing is cached yet or cache is expired
		if ((await redisClient.exists(this.fetchedKey)) === 0) {
			await this.clear();
			await this.add(...(await this.fetcher()));
			await redisClient.set(this.fetchedKey, "", "EX", 60 * 30);
		}
	}

	public async add(...targetIds: string[]) {
		if (targetIds.length > 0) {
			// This is no-op if targets are already in cache
			await redisClient.sadd(this.key, targetIds);
		}
		if ((await redisClient.ttl(this.key)) < 0) {
			await redisClient.expire(this.key, 60 * 60);
		}
	}

	public async delete(...targetIds: string[]) {
		if (targetIds.length > 0) {
			// This is no-op if targets are not in cache
			await redisClient.srem(this.key, targetIds);
		}
	}

	public async clear() {
		await redisClient.del(this.key);
	}

	public async has(targetId: string): Promise<boolean> {
		return (await redisClient.sismember(this.key, targetId)) === 1;
	}

	public async exists(): Promise<boolean> {
		return (await redisClient.scard(this.key)) !== 0;
	}

	public async getAll(): Promise<string[]> {
		return await redisClient.smembers(this.key);
	}
}

export class HashCache {
	private readonly key: string;
	private readonly fetchedKey: string;
	private readonly fetcher: () => Promise<Map<string, string>>;

	protected constructor(
		name: string,
		userId: string,
		fetcher: () => Promise<Map<string, string>>,
	) {
		this.key = `hashcache:${name}:${userId}`;
		this.fetchedKey = `${this.key}:fetched`;
		this.fetcher = fetcher;
	}

	protected async fetch() {
		// Sync from DB if nothing is cached yet or cache is expired
		if ((await redisClient.exists(this.fetchedKey)) === 0) {
			await this.clear();
			await this.setHash(await this.fetcher());
			await redisClient.set(this.fetchedKey, "", "EX", 60 * 30);
		}
	}

	public async exists(): Promise<boolean> {
		return (await redisClient.hlen(this.key)) > 0;
	}

	public async setHash(hash: Map<string, string>) {
		if (hash.size > 0) {
			await redisClient.hset(this.key, hash);
		}
		if ((await redisClient.ttl(this.key)) < 0) {
			await redisClient.expire(this.key, 60 * 60);
		}
	}

	public async set(field: string, value: string) {
		await this.setHash(new Map([[field, value]]));
	}

	public async delete(...fields: string[]) {
		if (fields.length > 0) {
			await redisClient.hdel(this.key, ...fields);
		}
	}

	public async clear() {
		await redisClient.del(this.key);
	}

	public async get(...fields: string[]): Promise<Map<string, string>> {
		let pairs: [string, string][] = [];

		if (fields.length > 0) {
			pairs = (await redisClient.hmget(this.key, ...fields))
				.map((v, i) => [fields[i], v] as [string, string | null])
				.filter(([_, value]) => value !== null) as [string, string][];
		} else {
			pairs = Object.entries(await redisClient.hgetall(this.key));
		}

		return new Map(pairs);
	}
}

export class LocalFollowingsCache extends SetCache {
	private constructor(userId: string) {
		const fetcher = () =>
			Followings.find({
				select: ["followeeId"],
				where: { followerId: userId, followerHost: IsNull() },
			}).then((follows) => follows.map(({ followeeId }) => followeeId));

		super("follow", userId, fetcher);
	}

	public static async init(userId: string): Promise<LocalFollowingsCache> {
		const cache = new LocalFollowingsCache(userId);
		await cache.fetch();

		return cache;
	}
}

export class LocalFollowersCache extends SetCache {
	private constructor(userId: string) {
		const fetcher = () =>
			Followings.find({
				select: ["followerId"],
				where: { followeeId: userId, followerHost: IsNull() },
			}).then((followers) => followers.map(({ followerId }) => followerId));

		super("follower", userId, fetcher);
	}

	public static async init(userId: string): Promise<LocalFollowersCache> {
		const cache = new LocalFollowersCache(userId);
		await cache.fetch();

		return cache;
	}
}

export class ChannelFollowingsCache extends SetCache {
	private constructor(userId: string) {
		const fetcher = () =>
			ChannelFollowings.find({
				select: ["followeeId"],
				where: {
					followerId: userId,
				},
			}).then((follows) => follows.map(({ followeeId }) => followeeId));

		super("channel", userId, fetcher);
	}

	public static async init(userId: string): Promise<ChannelFollowingsCache> {
		const cache = new ChannelFollowingsCache(userId);
		await cache.fetch();

		return cache;
	}
}

export class UserMutingsCache extends HashCache {
	private constructor(userId: string) {
		const fetcher = () =>
			Mutings.find({
				select: ["muteeId", "expiresAt"],
				where: { muterId: userId },
			}).then(
				(mutes) =>
					new Map(
						mutes.map(({ muteeId, expiresAt }) => [
							muteeId,
							expiresAt?.toISOString() ?? "",
						]),
					),
			);

		super("mute", userId, fetcher);
	}

	public static async init(userId: string): Promise<UserMutingsCache> {
		const cache = new UserMutingsCache(userId);
		await cache.fetch();

		return cache;
	}

	public async mute(muteeId: string, expiresAt?: Date | null) {
		await this.set(muteeId, expiresAt?.toISOString() ?? "");
	}

	public async unmute(muteeId: string) {
		await this.delete(muteeId);
	}

	public async getAll(): Promise<string[]> {
		const mutes = await this.get();
		const expired: string[] = [];
		const valid: string[] = [];

		for (const [k, v] of mutes.entries()) {
			if (v !== "" && new Date(v) < new Date()) {
				expired.push(k);
			} else {
				valid.push(k);
			}
		}

		await this.delete(...expired);

		return valid;
	}

	public async isMuting(muteeId: string): Promise<boolean> {
		const result = (await this.get(muteeId)).get(muteeId); // Could be undefined or ""
		let muting = result === "";

		if (result) {
			muting = new Date(result) > new Date(); // Check if not expired yet
			if (!muting) {
				await this.unmute(muteeId);
			}
		}

		return muting;
	}
}

export class InstanceMutingsCache extends SetCache {
	private constructor(userId: string) {
		const fetcher = () =>
			UserProfiles.findOne({
				select: ["mutedInstances"],
				where: { userId },
			}).then((profile) => (profile ? profile.mutedInstances : []));

		super("instanceMute", userId, fetcher);
	}

	public static async init(userId: string): Promise<InstanceMutingsCache> {
		const cache = new InstanceMutingsCache(userId);
		await cache.fetch();

		return cache;
	}
}

export class UserBlockingCache extends SetCache {
	private constructor(userId: string) {
		const fetcher = () =>
			Blockings.find({
				select: ["blockeeId"],
				where: { blockerId: userId },
			}).then((blocks) => blocks.map(({ blockeeId }) => blockeeId));

		super("blocking", userId, fetcher);
	}

	public static async init(userId: string): Promise<UserBlockingCache> {
		const cache = new UserBlockingCache(userId);
		await cache.fetch();

		return cache;
	}
}

export class UserBlockedCache extends SetCache {
	private constructor(userId: string) {
		const fetcher = () =>
			Blockings.find({
				select: ["blockerId"],
				where: { blockeeId: userId },
			}).then((blocks) => blocks.map(({ blockerId }) => blockerId));

		super("blocked", userId, fetcher);
	}

	public static async init(userId: string): Promise<UserBlockedCache> {
		const cache = new UserBlockedCache(userId);
		await cache.fetch();

		return cache;
	}
}

export const userWordMuteCache = new Cache<string[][]>("mutedWord", 60 * 30);

export class RenoteMutingsCache extends SetCache {
	private constructor(userId: string) {
		const fetcher = () =>
			RenoteMutings.find({
				select: ["muteeId"],
				where: { muterId: userId },
			}).then((mutes) => mutes.map(({ muteeId }) => muteeId));

		super("renoteMute", userId, fetcher);
	}

	public static async init(userId: string): Promise<RenoteMutingsCache> {
		const cache = new RenoteMutingsCache(userId);
		await cache.fetch();

		return cache;
	}
}
