import config from "@/config/index.js";
import type { PopulatedEmoji } from "@/misc/populate-emojis.js";
import type { Channel } from "@/models/entities/channel.js";
import type { Note } from "@/models/entities/note.js";
import type { NoteReaction } from "@/models/entities/note-reaction.js";
import { Client, types, tracker } from "cassandra-driver";
import type { User } from "@/models/entities/user.js";
import {
	ChannelFollowingsCache,
	InstanceMutingsCache,
	LocalFollowingsCache,
	RenoteMutingsCache,
	UserBlockedCache,
	UserBlockingCache,
	UserMutingsCache,
	userWordMuteCache,
} from "@/misc/cache.js";
import { getTimestamp } from "@/misc/gen-id.js";
import Logger from "@/services/logger.js";
import { UserProfiles } from "@/models/index.js";
import { getWordHardMute } from "@/misc/check-word-mute.js";
import type { UserProfile } from "@/models/entities/user-profile.js";
import { scyllaQueries } from "@/db/cql.js";
import { notificationTypes } from "@/types.js";

function newClient(): Client | null {
	if (!config.scylla) {
		return null;
	}

	const requestTracker = new tracker.RequestLogger({
		slowThreshold: 1000,
	});
	const client = new Client({
		contactPoints: config.scylla.nodes,
		localDataCenter: config.scylla.localDataCentre,
		keyspace: config.scylla.keyspace,
		requestTracker,
	});

	const logger = new Logger("scylla");
	client.on("log", (level, loggerName, message, _furtherInfo) => {
		const msg = `${loggerName} - ${message}`;
		switch (level) {
			case "info":
				logger.info(msg);
				break;
			case "warning":
				logger.warn(msg);
				break;
			case "error":
				logger.error(msg);
				break;
		}
	});
	client.on("slow", (message) => {
		logger.warn(message);
	});
	client.on("large", (message) => {
		logger.warn(message);
	});

	return client;
}

export const scyllaClient = newClient();

export const prepared = scyllaQueries;

export interface ScyllaNotification {
	targetId: string;
	createdAtDate: Date;
	createdAt: Date;
	id: string;
	notifierId: string | null;
	notifierHost: string | null;
	type: typeof notificationTypes[number];
	entityId: string | null;
	reaction: string | null;
	choice: number | null;
	customBody: string | null;
	customHeader: string | null;
	customIcon: string | null;
}

export function parseScyllaNotification(row: types.Row): ScyllaNotification {
	return {
		targetId: row.get("targetId"),
		createdAtDate: row.get("createdAt"),
		createdAt: row.get("createdAt"),
		id: row.get("id"),
		type: row.get("type"),
		notifierId: row.get("notifierId") ?? null,
		notifierHost: row.get("notifierHost") ?? null,
		entityId: row.get("entityId") ?? null,
		reaction: row.get("reaction") ?? null,
		choice: row.get("choice") ?? null,
		customBody: row.get("customBody") ?? null,
		customHeader: row.get("customHeader") ?? null,
		customIcon: row.get("customIcon") ?? null,
	};
}

export interface ScyllaDriveFile {
	id: string;
	type: string;
	createdAt: Date;
	name: string;
	comment: string | null;
	blurhash: string | null;
	url: string;
	thumbnailUrl: string;
	isSensitive: boolean;
	isLink: boolean;
	md5: string;
	size: number;
	width: number | null;
	height: number | null;
}

export function getScyllaDrivePublicUrl(
	file: ScyllaDriveFile,
	thumbnail = false,
): string | null {
	const isImage =
		file.type &&
		[
			"image/png",
			"image/apng",
			"image/gif",
			"image/jpeg",
			"image/webp",
			"image/svg+xml",
			"image/avif",
		].includes(file.type);

	return thumbnail
		? file.thumbnailUrl || (isImage ? file.url : null)
		: file.url;
}

export interface ScyllaNoteEditHistory {
	content: string;
	cw: string;
	files: ScyllaDriveFile[];
	updatedAt: Date;
}

export interface ScyllaPoll {
	expiresAt: Date | null;
	multiple: boolean;
	choices: Record<number, string>;
}

export interface ScyllaPollVote {
	noteId: string;
	userId: string;
	choice: Set<number>;
	createdAt: Date;
}

export function parseScyllaPollVote(row: types.Row): ScyllaPollVote {
	return {
		noteId: row.get("noteId"),
		userId: row.get("userId"),
		choice: new Set(row.get("choice") ?? []),
		createdAt: row.get("createdAt"),
	};
}

export type ScyllaNote = Note & {
	createdAtDate: Date;
	files: ScyllaDriveFile[];
	noteEdit: ScyllaNoteEditHistory[];
	replyText: string | null;
	replyCw: string | null;
	replyFiles: ScyllaDriveFile[];
	renoteText: string | null;
	renoteCw: string | null;
	renoteFiles: ScyllaDriveFile[];
	poll: ScyllaPoll | null;
};

export function parseScyllaNote(row: types.Row): ScyllaNote {
	const files: ScyllaDriveFile[] = row.get("files") ?? [];
	const userHost = row.get("userHost");

	return {
		createdAtDate: row.get("createdAt"),
		createdAt: row.get("createdAt"),
		id: row.get("id"),
		visibility: row.get("visibility"),
		text: row.get("content") ?? null,
		name: row.get("name") ?? null,
		cw: row.get("cw") ?? null,
		localOnly: row.get("localOnly"),
		renoteCount: row.get("renoteCount"),
		repliesCount: row.get("repliesCount"),
		uri: row.get("uri") ?? null,
		url: row.get("url") ?? null,
		score: row.get("score"),
		files,
		fileIds: files.map((file) => file.id),
		attachedFileTypes: files.map((file) => file.type) ?? [],
		visibleUserIds: row.get("visibleUserIds") ?? [],
		mentions: row.get("mentions") ?? [],
		emojis: row.get("emojis") ?? [],
		tags: row.get("tags") ?? [],
		hasPoll: row.get("hasPoll") ?? false,
		poll: row.get("poll") ?? null,
		threadId: row.get("threadId") ?? null,
		channelId: row.get("channelId") ?? null,
		userId: row.get("userId"),
		userHost: userHost !== "local" ? userHost : null,
		replyId: row.get("replyId") ?? null,
		replyUserId: row.get("replyUserId") ?? null,
		replyUserHost: row.get("replyUserHost") ?? null,
		replyText: row.get("replyContent") ?? null,
		replyCw: row.get("replyCw") ?? null,
		replyFiles: row.get("replyFiles") ?? [],
		renoteId: row.get("renoteId") ?? null,
		renoteUserId: row.get("renoteUserId") ?? null,
		renoteUserHost: row.get("renoteUserHost") ?? null,
		renoteText: row.get("renoteContent") ?? null,
		renoteCw: row.get("renoteCw") ?? null,
		renoteFiles: row.get("renoteFiles") ?? [],
		reactions: row.get("reactions") ?? {},
		noteEdit: row.get("noteEdit") ?? [],
		updatedAt: row.get("updatedAt") ?? null,
		mentionedRemoteUsers: row.get("mentionedRemoteUsers") ?? "[]",
		/* unused postgres denormalization */
		channel: null,
		renote: null,
		reply: null,
		user: null,
	};
}

export function parseHomeTimeline(
	row: types.Row,
): { feedUserId: string } & ScyllaNote {
	const note = parseScyllaNote(row);

	return {
		feedUserId: row.get("feedUserId"),
		...note,
	};
}

export interface ScyllaNoteReaction extends NoteReaction {
	emoji: PopulatedEmoji;
}

export type FeedType =
	| "home"
	| "local"
	| "recommended"
	| "global"
	| "renotes"
	| "user"
	| "channel"
	| "notification"
	| "list";

export function parseScyllaReaction(row: types.Row): ScyllaNoteReaction {
	return {
		id: row.get("id"),
		noteId: row.get("noteId"),
		userId: row.get("userId"),
		reaction: row.get("reaction"),
		createdAt: row.get("createdAt"),
		emoji: row.get("emoji"),
	};
}

export function preparePaginationQuery(
	kind: FeedType,
	ps: {
		untilId?: string;
		untilDate?: number;
		sinceId?: string;
		sinceDate?: number;
	},
): { query: string; untilDate: Date; sinceDate: Date | null } {
	const queryParts: string[] = [];

	switch (kind) {
		case "home":
			queryParts.push(prepared.homeTimeline.select.byUserAndDate);
			break;
		case "local":
			queryParts.push(prepared.localTimeline.select.byDate);
			break;
		case "recommended":
		case "global":
			queryParts.push(prepared.globalTimeline.select.byDate);
			break;
		case "renotes":
			queryParts.push(prepared.note.select.byRenoteId);
			break;
		case "user":
		case "list":
			queryParts.push(prepared.note.select.byUserId);
			break;
		case "channel":
			queryParts.push(prepared.note.select.byChannelId);
			break;
		case "notification":
			queryParts.push(prepared.notification.select.byTargetId);
			break;
		default:
			queryParts.push(prepared.note.select.byDate);
	}

	queryParts.push(`AND "createdAt" < ?`);

	let until = new Date();
	if (ps.untilId) {
		until = new Date(getTimestamp(ps.untilId));
	}
	if (ps.untilDate && ps.untilDate < until.getTime()) {
		until = new Date(ps.untilDate);
	}
	let since: Date | null = null;
	if (ps.sinceId) {
		since = new Date(getTimestamp(ps.sinceId));
	}
	if (ps.sinceDate && (!since || ps.sinceDate > since.getTime())) {
		since = new Date(ps.sinceDate);
	}
	if (since !== null) {
		queryParts.push(`AND "createdAt" > ?`);
	}

	queryParts.push("LIMIT ?");

	const query = queryParts.join(" ");

	return {
		query,
		untilDate: until,
		sinceDate: since,
	};
}

export async function execPaginationQuery(
	kind: FeedType,
	ps: {
		limit: number;
		untilId?: string;
		untilDate?: number;
		sinceId?: string;
		sinceDate?: number;
		noteId?: string;
		channelId?: string;
		userIds?: string[];
	},
	filter?: {
		note?: (_: ScyllaNote[]) => Promise<ScyllaNote[]>;
		notification?: (_: ScyllaNotification[]) => ScyllaNotification[];
	},
	userId?: User["id"],
	maxPartitions = config.scylla?.sparseTimelineDays ?? 14,
): Promise<ScyllaNote[] | ScyllaNotification[]> {
	if (!scyllaClient) return [];

	switch (kind) {
		case "home":
		case "user":
		case "notification":
			if (!userId) throw new Error(`Feed ${kind} needs userId`);
			break;
		case "renotes":
			if (!ps.noteId) throw new Error(`Feed ${kind} needs noteId`);
			break;
		case "channel":
			if (!ps.channelId) throw new Error(`Feed ${kind} needs channelId`);
			break;
		case "list":
			if (!ps.userIds || ps.userIds.length === 0)
				throw new Error(`Feed ${kind} needs userIds`);
			break;
	}

	let { query, untilDate, sinceDate } = preparePaginationQuery(kind, ps);

	let scannedPartitions = 0;
	const found: (ScyllaNote | ScyllaNotification)[] = [];
	const queryLimit = config.scylla?.queryLimit ?? 1000;
	let foundLimit = ps.limit;
	if (kind === "list" && ps.userIds) {
		foundLimit *= ps.userIds.length;
	}

	// Try to get posts of at most <maxPartitions> in the single request
	while (found.length < foundLimit && scannedPartitions < maxPartitions) {
		const params: (Date | string | string[] | number)[] = [];
		if (kind === "home" && userId) {
			params.push(userId, untilDate, untilDate);
		} else if (kind === "user" && userId) {
			params.push(userId, untilDate);
		} else if (kind === "renotes" && ps.noteId) {
			params.push(ps.noteId, untilDate);
		} else if (kind === "channel" && ps.channelId) {
			params.push(ps.channelId, untilDate);
		} else if (kind === "notification" && userId) {
			params.push(userId, untilDate, untilDate);
		} else if (kind === "list" && ps.userIds) {
			const targetId = ps.userIds.pop();
			if (!targetId) break;
			params.push(targetId, untilDate);
		} else {
			params.push(untilDate, untilDate);
		}

		if (sinceDate) {
			params.push(sinceDate);
		}

		const fetchLimit = kind === "list" ? ps.limit : queryLimit;
		params.push(fetchLimit);

		const result = await scyllaClient.execute(query, params, {
			prepare: true,
		});

		if (result.rowLength > 0) {
			if (kind === "notification") {
				const notifications = result.rows.map(parseScyllaNotification);
				found.push(
					...(filter?.notification
						? filter.notification(notifications)
						: notifications),
				);
				untilDate = notifications[notifications.length - 1].createdAt;
			} else {
				const notes = result.rows.map(parseScyllaNote);
				found.push(...(filter?.note ? await filter.note(notes) : notes));
				untilDate = notes[notes.length - 1].createdAt;
			}
		}

		if (result.rowLength < fetchLimit) {
			// Reached the end of partition. Queries posts created one day before.
			scannedPartitions++;
			const yesterday = new Date(untilDate.getTime() - 86400000);
			yesterday.setUTCHours(23, 59, 59, 999);
			untilDate = yesterday;
			if (sinceDate && untilDate < sinceDate) break;
		}
	}

	if (kind === "notification") {
		return found as ScyllaNotification[];
	}

	return found as ScyllaNote[];
}

export async function filterVisibility(
	notes: ScyllaNote[],
	user: { id: User["id"] } | null,
	followingIds?: User["id"][],
): Promise<ScyllaNote[]> {
	let filtered = notes;

	if (!user) {
		filtered = filtered.filter((note) =>
			["public", "home"].includes(note.visibility),
		);
	} else {
		let ids: User["id"][];
		if (followingIds) {
			ids = followingIds;
		} else {
			ids = await LocalFollowingsCache.init(user.id).then((cache) =>
				cache.getAll(),
			);
		}

		filtered = filtered.filter(
			(note) =>
				["public", "home"].includes(note.visibility) ||
				note.userId === user.id ||
				note.visibleUserIds.includes(user.id) ||
				note.mentions.includes(user.id) ||
				(note.visibility === "followers" &&
					(ids.includes(note.userId) || note.replyUserId === user.id)),
		);
	}

	return filtered;
}

export async function filterChannel(
	notes: ScyllaNote[],
	user: { id: User["id"] } | null,
	followingIds?: Channel["id"][],
): Promise<ScyllaNote[]> {
	let filtered = notes;

	if (!user) {
		filtered = filtered.filter((note) => !note.channelId);
	} else {
		const channelNotes = filtered.filter((note) => !!note.channelId);
		if (channelNotes.length > 0) {
			let followings: Channel["id"][];
			if (followingIds) {
				followings = followingIds;
			} else {
				followings = await ChannelFollowingsCache.init(user.id).then((cache) =>
					cache.getAll(),
				);
			}
			filtered = filtered.filter(
				(note) => !note.channelId || followings.includes(note.channelId),
			);
		}
	}

	return filtered;
}

export async function filterReply(
	notes: ScyllaNote[],
	withReplies: boolean,
	user: { id: User["id"] } | null,
): Promise<ScyllaNote[]> {
	let filtered = notes;

	if (!user) {
		filtered = filtered.filter(
			(note) => !note.replyId || note.replyUserId === note.userId,
		);
	} else if (!withReplies) {
		filtered = filtered.filter(
			(note) =>
				!note.replyId ||
				note.replyUserId === user.id ||
				note.userId === user.id ||
				note.replyUserId === note.userId,
		);
	}

	return filtered;
}

export async function filterMutedUser(
	notes: ScyllaNote[],
	user: { id: User["id"] },
	mutedIds?: User["id"][],
	mutedInstances?: UserProfile["mutedInstances"],
	exclude?: User,
): Promise<ScyllaNote[]> {
	let ids: User["id"][];
	let instances: UserProfile["mutedInstances"];

	if (mutedIds) {
		ids = mutedIds;
	} else {
		ids = await UserMutingsCache.init(user.id).then((cache) => cache.getAll());
	}

	if (mutedInstances) {
		instances = mutedInstances;
	} else {
		instances = await InstanceMutingsCache.init(user.id).then((cache) =>
			cache.getAll(),
		);
	}

	if (exclude) {
		ids = ids.filter((id) => id !== exclude.id);
	}

	return notes.filter(
		(note) =>
			!ids.includes(note.userId) &&
			!(note.replyUserId && ids.includes(note.replyUserId)) &&
			!(note.renoteUserId && ids.includes(note.renoteUserId)) &&
			!(note.userHost && instances.includes(note.userHost)) &&
			!(note.replyUserHost && instances.includes(note.replyUserHost)) &&
			!(note.renoteUserHost && instances.includes(note.renoteUserHost)),
	);
}

export async function filterMutedNote(
	notes: ScyllaNote[],
	user: { id: User["id"] },
	mutedWords?: string[][],
): Promise<ScyllaNote[]> {
	let words = mutedWords;

	if (!words) {
		words = await userWordMuteCache.fetchMaybe(user.id, () =>
			UserProfiles.findOne({
				select: ["mutedWords"],
				where: { userId: user.id },
			}).then((profile) => profile?.mutedWords),
		);
	}

	if (words && words.length > 0) {
		return notes.filter(
			(note) => !getWordHardMute(note, user, words as string[][]),
		);
	}

	return notes;
}

export async function filterBlockUser(
	notes: ScyllaNote[],
	user: { id: User["id"] },
	blockIds?: User["id"][],
): Promise<ScyllaNote[]> {
	let ids: User["id"][];

	if (blockIds) {
		ids = blockIds;
	} else {
		const blocked = await UserBlockedCache.init(user.id).then((cache) =>
			cache.getAll(),
		);
		const blocking = await UserBlockingCache.init(user.id).then((cache) =>
			cache.getAll(),
		);
		ids = [...blocked, ...blocking];
	}

	return notes.filter(
		(note) =>
			!ids.includes(note.userId) &&
			!(note.replyUserId && ids.includes(note.replyUserId)) &&
			!(note.renoteUserId && ids.includes(note.renoteUserId)),
	);
}

export async function filterMutedRenotes(
	notes: ScyllaNote[],
	user: { id: User["id"] },
	muteeIds?: User["id"][],
): Promise<ScyllaNote[]> {
	let ids: User["id"][];

	if (muteeIds) {
		ids = muteeIds;
	} else {
		ids = await RenoteMutingsCache.init(user.id).then((cache) =>
			cache.getAll(),
		);
	}

	return notes.filter(
		(note) => note.text || !note.renoteId || !ids.includes(note.userId),
	);
}
