import type { FindOptionsWhere } from "typeorm";
import { NoteReactions } from "@/models/index.js";
import type { NoteReaction } from "@/models/entities/note-reaction.js";
import define from "../../define.js";
import { ApiError } from "../../error.js";
import { getNote } from "../../common/getters.js";
import { parseScyllaReaction, prepared, scyllaClient } from "@/db/scylla.js";

export const meta = {
	tags: ["notes", "reactions"],

	requireCredential: false,
	requireCredentialPrivateMode: true,

	allowGet: true,
	cacheSec: 60,

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
		noSuchNote: {
			message: "No such note.",
			code: "NO_SUCH_NOTE",
			id: "263fff3d-d0e1-4af4-bea7-8408059b451a",
		},
	},
} as const;

export const paramDef = {
	type: "object",
	properties: {
		noteId: { type: "string", format: "misskey:id" },
		type: { type: "string", nullable: true },
		limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
		offset: { type: "integer", default: 0 },
		sinceId: { type: "string", format: "misskey:id" },
		untilId: { type: "string", format: "misskey:id" },
	},
	required: ["noteId"],
} as const;

export default define(meta, paramDef, async (ps, user) => {
	// check note visibility
	await getNote(ps.noteId, user).catch((err) => {
		if (err.id === "9725d0ce-ba28-4dde-95a7-2cbb2c15de24")
			throw new ApiError(meta.errors.noSuchNote);
		throw err;
	});

	const query = {
		noteId: ps.noteId,
	} as FindOptionsWhere<NoteReaction>;

	if (ps.type) {
		// Remove "." suffix of local emojis here because they are actually null in DB.
		const suffix = "@.:";
		const type = ps.type.endsWith(suffix)
			? `${ps.type.slice(0, ps.type.length - suffix.length)}:`
			: ps.type;
		query.reaction = type;
	}

	let reactions: NoteReaction[] = [];
	if (scyllaClient) {
		const scyllaQuery = [prepared.reaction.select.byNoteId]
		const params: (string | string[] | number)[] = [[ps.noteId]];
		if (ps.type) {
			scyllaQuery.push(`AND "reaction" = ?`);
			params.push(query.reaction as string)
		}
		scyllaQuery.push("LIMIT ?");
		params.push(ps.limit);

		// Note: This query fails if the number of returned rows exceeds 5000 by
		// default, i.e., 5000 reactions with the same emoji from different users.
		// This limitation can be relaxed via "fetchSize" option.
		// Note: Remote emojis and local emojis are different.
		// Ref: https://github.com/datastax/nodejs-driver#paging
		const result = await scyllaClient.execute(
			scyllaQuery.join(" "),
			params,
			{ prepare: true },
		);
		reactions = result.rows.map(parseScyllaReaction);
	} else {
		reactions = await NoteReactions.find({
			where: query,
			take: ps.limit,
			skip: ps.offset,
			order: {
				id: -1,
			},
			relations: ["user", "user.avatar", "user.banner", "note"],
		});
	}

	return await NoteReactions.packMany(reactions, user);
});
