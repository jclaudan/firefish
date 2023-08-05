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
	UserMutingsCache,
	userWordMuteCache,
} from "@/misc/cache.js";
import { getTimestamp } from "@/misc/gen-id.js";
import Logger from "@/services/logger.js";
import { UserProfiles } from "@/models/index.js";
import { getWordHardMute } from "@/misc/check-word-mute";

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

export const prepared = {
	note: {
		insert: `INSERT INTO note (
				"createdAtDate",
				"createdAt",
				"id",
				"visibility",
				"content",
				"name",
				"cw",
				"localOnly",
				"renoteCount",
				"repliesCount",
				"uri",
				"url",
				"score",
				"files",
				"visibleUserIds",
				"mentions",
				"mentionedRemoteUsers",
				"emojis",
				"tags",
				"hasPoll",
				"threadId",
				"channelId",
				"userId",
				"userHost",
				"replyId",
				"replyUserId",
				"replyUserHost",
				"replyContent",
				"replyCw",
				"replyFiles",
				"renoteId",
				"renoteUserId",
				"renoteUserHost",
				"renoteContent",
				"renoteCw",
				"renoteFiles",
				"reactions",
				"noteEdit",
				"updatedAt"
			)
			VALUES
			(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		select: {
			byDate: `SELECT * FROM note WHERE "createdAtDate" = ?`,
			byUri: `SELECT * FROM note WHERE "uri" IN ?`,
			byUrl: `SELECT * FROM note WHERE "url" IN ?`,
			byId: `SELECT * FROM note_by_id WHERE "id" IN ?`,
			byUserId: `SELECT * FROM note_by_userid WHERE "userId" IN ?`,
		},
		delete: `DELETE FROM note WHERE "createdAtDate" = ? AND "createdAt" = ? AND "id" = ?`,
		update: {
			renoteCount: `UPDATE note SET
				"renoteCount" = ?,
				"score" = ?
				WHERE "createdAtDate" = ? AND "createdAt" = ? AND "id" = ? IF EXISTS`,
			repliesCount: `UPDATE note SET
				"repliesCount" = ?,
				WHERE "createdAtDate" = ? AND "createdAt" = ? AND "id" = ? IF EXISTS`,
			reactions: `UPDATE note SET
				"emojis" = ?,
				"reactions" = ?,
				"score" = ?
				WHERE "createdAtDate" = ? AND "createdAt" = ? AND "id" = ? IF EXISTS`,
		},
	},
	reaction: {
		insert: `INSERT INTO reaction
			("id", "noteId", "userId", "reaction", "emoji", "createdAt")
			VALUES (?, ?, ?, ?, ?, ?)`,
		select: {
			byNoteId: `SELECT * FROM reaction WHERE "noteId" IN ?`,
			byUserId: `SELECT * FROM reaction_by_userid WHERE "userId" IN ?`,
			byNoteAndUser: `SELECT * FROM reaction WHERE "noteId" = ? AND "userId" = ?`,
			byId: `SELECT * FROM reaction WHERE "id" IN ?`,
		},
		delete: `DELETE FROM reaction WHERE "noteId" = ? AND "userId" = ?`,
	},
};

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

export interface ScyllaNoteEditHistory {
	content: string;
	cw: string;
	files: ScyllaDriveFile[];
	updatedAt: Date;
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
};

export function parseScyllaNote(row: types.Row): ScyllaNote {
	const files: ScyllaDriveFile[] = row.get("files") ?? [];

	return {
		createdAtDate: row.get("createdAtDate"),
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
		threadId: row.get("threadId") ?? null,
		channelId: row.get("channelId") ?? null,
		userId: row.get("userId"),
		userHost: row.get("userHost") ?? null,
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

export interface ScyllaNoteReaction extends NoteReaction {
	emoji: PopulatedEmoji;
}

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

export function prepareTimelineQuery(ps: {
	untilId?: string;
	untilDate?: number;
	sinceId?: string;
	sinceDate?: number;
}): { query: string; untilDate: Date; sinceDate: Date | null } {
	const queryParts = [`${prepared.note.select.byDate} AND "createdAt" < ?`];

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

	queryParts.push("LIMIT 50"); // Hardcoded to issue a prepared query
	const query = queryParts.join(" ");

	return {
		query,
		untilDate: until,
		sinceDate: since,
	};
}

export async function execTimelineQuery(
	ps: {
		limit: number;
		untilId?: string;
		untilDate?: number;
		sinceId?: string;
		sinceDate?: number;
	},
	filter?: (_: ScyllaNote[]) => Promise<ScyllaNote[]>,
	maxDays = 30,
): Promise<ScyllaNote[]> {
	if (!scyllaClient) return [];

	let { query, untilDate, sinceDate } = prepareTimelineQuery(ps);

	let scannedEmptyPartitions = 0;
	const foundNotes: ScyllaNote[] = [];

	// Try to get posts of at most <maxDays> in the single request
	while (foundNotes.length < ps.limit && scannedEmptyPartitions < maxDays) {
		const params: (Date | string | string[])[] = [untilDate, untilDate];
		if (sinceDate) {
			params.push(sinceDate);
		}

		const result = await scyllaClient.execute(query, params, {
			prepare: true,
		});

		if (result.rowLength === 0) {
			// Reached the end of partition. Queries posts created one day before.
			scannedEmptyPartitions++;
			untilDate = new Date(
				untilDate.getFullYear(),
				untilDate.getMonth(),
				untilDate.getDate() - 1,
				23,
				59,
				59,
				999,
			);
			if (sinceDate && untilDate < sinceDate) break;

			continue;
		}

		scannedEmptyPartitions = 0;

		const notes = result.rows.map(parseScyllaNote);
		foundNotes.push(...(filter ? await filter(notes) : notes));
		untilDate = notes[notes.length - 1].createdAt;
	}

	return foundNotes;
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
		let followings: User["id"][];
		if (followingIds) {
			followings = followingIds;
		} else {
			const cache = await LocalFollowingsCache.init(user.id);
			followings = await cache.getAll();
		}

		filtered = filtered.filter(
			(note) =>
				["public", "home"].includes(note.visibility) ||
				note.userId === user.id ||
				note.visibleUserIds.includes(user.id) ||
				note.mentions.includes(user.id) ||
				(note.visibility === "followers" &&
					(followings.includes(note.userId) || note.replyUserId === user.id)),
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
				const cache = await ChannelFollowingsCache.init(user.id);
				followings = await cache.getAll();
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
	exclude?: User,
): Promise<ScyllaNote[]> {
	const userCache = await UserMutingsCache.init(user.id);
	let mutedUserIds = await userCache.getAll();

	if (exclude) {
		mutedUserIds = mutedUserIds.filter((id) => id !== exclude.id);
	}

	const instanceCache = await InstanceMutingsCache.init(user.id);
	const mutedInstances = await instanceCache.getAll();

	return notes.filter(
		(note) =>
			!mutedUserIds.includes(note.userId) &&
			!(note.replyUserId && mutedUserIds.includes(note.replyUserId)) &&
			!(note.renoteUserId && mutedUserIds.includes(note.renoteUserId)) &&
			!(note.userHost && mutedInstances.includes(note.userHost)) &&
			!(note.replyUserHost && mutedInstances.includes(note.replyUserHost)) &&
			!(note.renoteUserHost && mutedInstances.includes(note.renoteUserHost)),
	);
}

export async function filterMutedNote(
	notes: ScyllaNote[],
	user: { id: User["id"] },
): Promise<ScyllaNote[]> {
	const mutedWords = await userWordMuteCache.fetchMaybe(user.id, () =>
		UserProfiles.findOne({
			select: ["mutedWords"],
			where: { userId: user.id },
		}).then((profile) => profile?.mutedWords),
	);

	if (!mutedWords) {
		return notes;
	}

	return notes.filter((note) => !getWordHardMute(note, user, mutedWords));
}
