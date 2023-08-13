import { Notes, UserProfiles } from "@/models/index.js";
import define from "../../define.js";
import { makePaginationQuery } from "../../common/make-pagination-query.js";
import { generateVisibilityQuery } from "../../common/generate-visibility-query.js";
import { generateMutedUserQuery } from "../../common/generate-muted-user-query.js";
import { generateBlockedUserQuery } from "../../common/generate-block-query.js";
import {
	filterBlockedUser,
	filterMutedNote,
	filterMutedUser,
	filterVisibility,
	parseScyllaNote,
	prepared,
	scyllaClient,
} from "@/db/scylla.js";
import { getNote } from "@/server/api/common/getters.js";
import type { Note } from "@/models/entities/note.js";
import {
	InstanceMutingsCache,
	LocalFollowingsCache,
	UserBlockedCache,
	UserMutingsCache,
	userWordMuteCache,
} from "@/misc/cache.js";

export const meta = {
	tags: ["notes"],

	requireCredential: false,
	requireCredentialPrivateMode: true,
	description: "Get threaded/chained replies to a note",

	res: {
		type: "array",
		optional: false,
		nullable: false,
		items: {
			type: "object",
			optional: false,
			nullable: false,
			ref: "Note",
		},
	},
} as const;

export const paramDef = {
	type: "object",
	properties: {
		noteId: { type: "string", format: "misskey:id" },
		limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
		depth: { type: "integer", minimum: 1, maximum: 100, default: 12 },
		sinceId: { type: "string", format: "misskey:id" },
		untilId: { type: "string", format: "misskey:id" },
	},
	required: ["noteId"],
} as const;

export default define(meta, paramDef, async (ps, user) => {
	if (scyllaClient) {
		let [
			followingUserIds,
			mutedUserIds,
			mutedInstances,
			blockerIds,
		]: string[][] = [];
		let mutedWords: string[][] = [];
		if (user) {
			[followingUserIds, mutedUserIds, mutedInstances, mutedWords, blockerIds] =
				await Promise.all([
					LocalFollowingsCache.init(user.id).then((cache) => cache.getAll()),
					UserMutingsCache.init(user.id).then((cache) => cache.getAll()),
					InstanceMutingsCache.init(user.id).then((cache) => cache.getAll()),
					userWordMuteCache
						.fetchMaybe(user.id, () =>
							UserProfiles.findOne({
								select: ["mutedWords"],
								where: { userId: user.id },
							}).then((profile) => profile?.mutedWords),
						)
						.then((words) => words ?? []),
					UserBlockedCache.init(user.id).then((cache) => cache.getAll()),
				]);
		}

		const root = await getNote(ps.noteId, user, followingUserIds).catch(
			() => null,
		);
		if (!root) {
			return await Notes.packMany([]);
		}

		// Find replies in BFS manner
		const queue = [root];
		const foundReplies: Note[] = [];
		let depth = 0;

		while (
			queue.length > 0 &&
			foundReplies.length < ps.limit &&
			depth < ps.depth
		) {
			const note = queue.shift();
			if (note) {
				const result = await scyllaClient.execute(
					prepared.note.select.byReplyId,
					[note.id],
					{ prepare: true },
				);
				if (result.rowLength > 0) {
					let replies = result.rows.map(parseScyllaNote);
					replies = await filterVisibility(replies, user, followingUserIds);
					if (user) {
						replies = await filterMutedUser(
							replies,
							user,
							mutedUserIds,
							mutedInstances,
						);
						replies = await filterMutedNote(replies, user, mutedWords);
						replies = await filterBlockedUser(replies, user, blockerIds);
					}
					foundReplies.push(...replies);
					queue.push(...replies);
					depth++;
				}
			}
		}

		return await Notes.packMany(foundReplies, user, {
			detail: false,
			scyllaNote: true,
		});
	}

	const query = makePaginationQuery(
		Notes.createQueryBuilder("note"),
		ps.sinceId,
		ps.untilId,
	).andWhere(
		"note.id IN (SELECT id FROM note_replies(:noteId, :depth, :limit))",
		{ noteId: ps.noteId, depth: ps.depth, limit: ps.limit },
	);

	generateVisibilityQuery(query, user);
	if (user) {
		generateMutedUserQuery(query, user);
		generateBlockedUserQuery(query, user);
	}

	const notes = await query.getMany();

	return await Notes.packMany(notes, user, { detail: false });
});
