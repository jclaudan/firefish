import { NoteReactions, UserProfiles } from "@/models/index.js";
import define from "../../define.js";
import { makePaginationQuery } from "../../common/make-pagination-query.js";
import { generateVisibilityQuery } from "../../common/generate-visibility-query.js";
import { ApiError } from "../../error.js";
import {
	type ScyllaNoteReaction,
	execPaginationQuery,
	filterVisibility,
	parseScyllaNote,
	prepared,
	scyllaClient,
} from "@/db/scylla.js";
import { LocalFollowingsCache } from "@/misc/cache.js";
import type { Client } from "cassandra-driver";

export const meta = {
	tags: ["users", "reactions"],

	requireCredential: false,
	requireCredentialPrivateMode: true,

	description: "Show all reactions this user made.",

	res: {
		type: "array",
		optional: false,
		nullable: false,
		items: {
			type: "object",
			optional: false,
			nullable: false,
			ref: "NoteReaction",
		},
	},

	errors: {
		reactionsNotPublic: {
			message: "Reactions of the user is not public.",
			code: "REACTIONS_NOT_PUBLIC",
			id: "673a7dd2-6924-1093-e0c0-e68456ceae5c",
		},
	},
} as const;

export const paramDef = {
	type: "object",
	properties: {
		userId: { type: "string", format: "misskey:id" },
		limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: "string", format: "misskey:id" },
		untilId: { type: "string", format: "misskey:id" },
		sinceDate: { type: "integer" },
		untilDate: { type: "integer" },
	},
	required: ["userId"],
} as const;

export default define(meta, paramDef, async (ps, me) => {
	const profile = await UserProfiles.findOneByOrFail({ userId: ps.userId });

	if (me?.id !== ps.userId && !profile.publicReactions) {
		throw new ApiError(meta.errors.reactionsNotPublic);
	}

	if (scyllaClient) {
		const client: Client = scyllaClient

		let followingUserIds: string[] = [];
		if (me) {
			followingUserIds = await LocalFollowingsCache.init(me.id).then((cache) =>
				cache.getAll(),
			);
		}

		const filter = async (reactions: ScyllaNoteReaction[]) => {
			let noteIds = reactions.map(({ noteId }) => noteId);
			if (me) {
				const notes = await client
					.execute(prepared.note.select.byIds, [noteIds], { prepare: true })
					.then((result) => result.rows.map(parseScyllaNote));
				const filteredNoteIds = await filterVisibility(
					notes,
					me,
					followingUserIds,
				).then((notes) => notes.map(({ id }) => id));
				noteIds = noteIds.filter((id) => filteredNoteIds.includes(id));
			}

			return reactions.filter((reaction) => noteIds.includes(reaction.noteId));
		};

		const foundReactions = (await execPaginationQuery(
			"reaction",
			ps,
			{ reaction: filter },
			ps.userId,
		)) as ScyllaNoteReaction[];
		return await NoteReactions.packMany(foundReactions, me, { withNote: true });
	}

	const query = makePaginationQuery(
		NoteReactions.createQueryBuilder("reaction"),
		ps.sinceId,
		ps.untilId,
		ps.sinceDate,
		ps.untilDate,
	)
		.andWhere("reaction.userId = :userId", { userId: ps.userId })
		.leftJoinAndSelect("reaction.note", "note");

	generateVisibilityQuery(query, me);

	const reactions = await query.take(ps.limit).getMany();

	return await NoteReactions.packMany(reactions, me, { withNote: true });
});
