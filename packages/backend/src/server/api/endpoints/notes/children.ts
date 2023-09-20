import { Notes, UserProfiles } from "@/models/index.js";
import define from "../../define.js";
import { makePaginationQuery } from "../../common/make-pagination-query.js";
import { generateVisibilityQuery } from "../../common/generate-visibility-query.js";
import { generateMutedUserQuery } from "../../common/generate-muted-user-query.js";
import { generateBlockedUserQuery } from "../../common/generate-block-query.js";
import {
	ScyllaNote,
	filterBlockUser,
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
	SuspendedUsersCache,
	UserBlockedCache,
	UserBlockingCache,
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
			blockingIds,
		]: string[][] = [];
		let mutedWords: string[][] = [];
		blockerIds = [];
		blockingIds = [];
		if (user) {
			[
				followingUserIds,
				mutedUserIds,
				mutedInstances,
				mutedWords,
				blockerIds,
				blockingIds,
			] = await Promise.all([
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
				UserBlockingCache.init(user.id).then((cache) => cache.getAll()),
			]);
		}
		const suspendedUserIds = await SuspendedUsersCache.init().then((cache) => cache.getAll());

		const root = await getNote(ps.noteId, user, followingUserIds).catch(
			() => null,
		);
		if (!root) {
			return await Notes.packMany([]);
		}

		const filter = (notes: ScyllaNote[]) => {
			let filtered = filterVisibility(notes, user, followingUserIds);
			filtered = filterBlockUser(filtered, [
				...blockerIds,
				...blockingIds,
				...suspendedUserIds,
			]);
			if (user) {
				filtered = filterMutedUser(
					filtered,
					mutedUserIds,
					mutedInstances,
				);
				filtered = filterMutedNote(filtered, user, mutedWords);
			}
			return filtered;
		};

		// Find quotes first
		const renoteResult = await scyllaClient.execute(
			prepared.note.select.byRenoteId,
			[root.id],
			{ prepare: true },
		);
		const foundNotes = filter(
			renoteResult.rows.map(parseScyllaNote).filter((note) => !!note.text),
		);

		// Then find replies in BFS manner
		const queue = [root];
		let depth = 0;
		const limit = ps.limit + foundNotes.length;

		while (queue.length > 0 && foundNotes.length < limit && depth < ps.depth) {
			const note = queue.shift();
			if (note) {
				const replyResult = await scyllaClient.execute(
					prepared.note.select.byReplyId,
					[note.id],
					{ prepare: true },
				);
				const replies = filter(replyResult.rows.map(parseScyllaNote));
				if (replies.length > 0) {
					foundNotes.push(...replies);
					queue.push(...replies);
					depth++;
				}
			}
		}

		return await Notes.packMany(foundNotes, user, {
			detail: false,
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
