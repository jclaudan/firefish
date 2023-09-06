import { Brackets } from "typeorm";
import { Notes } from "@/models/index.js";
import { safeForSql } from "@/misc/safe-for-sql.js";
import { normalizeForSearch } from "@/misc/normalize-for-search.js";
import define from "../../define.js";
import { makePaginationQuery } from "../../common/make-pagination-query.js";
import { generateMutedUserQuery } from "../../common/generate-muted-user-query.js";
import { generateVisibilityQuery } from "../../common/generate-visibility-query.js";
import { generateBlockedUserQuery } from "../../common/generate-block-query.js";
import { parseScyllaNote, prepared, scyllaClient } from "@/db/scylla.js";
import sonic from "@/db/sonic.js";
import meilisearch, { MeilisearchNote } from "@/db/meilisearch.js";

export const meta = {
	tags: ["notes", "hashtags"],
	requireCredentialPrivateMode: true,

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
		reply: { type: "boolean", nullable: true, default: null },
		renote: { type: "boolean", nullable: true, default: null },
		withFiles: {
			type: "boolean",
			default: false,
			description: "Only show notes that have attached files.",
		},
		poll: { type: "boolean", nullable: true, default: null },
		sinceId: { type: "string", format: "misskey:id" },
		untilId: { type: "string", format: "misskey:id" },
		limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
	},
	anyOf: [
		{
			properties: {
				tag: { type: "string", minLength: 1 },
			},
			required: ["tag"],
		},
		{
			properties: {
				query: {
					type: "array",
					description:
						"The outer arrays are chained with OR, the inner arrays are chained with AND.",
					items: {
						type: "array",
						items: {
							type: "string",
							minLength: 1,
						},
						minItems: 1,
					},
					minItems: 1,
				},
			},
			required: ["query"],
		},
	],
} as const;

export default define(meta, paramDef, async (ps, me) => {
	if (scyllaClient) {
		if (!ps.tag) {
			return await Notes.packMany([]);
		}

		const query = `#${ps.tag}`;

		if (sonic) {
			let start = 0;
			const chunkSize = 100;

			// Use sonic to fetch and step through all search results that could match the requirements
			const ids: string[] = [];
			while (true) {
				const results = await sonic.search.query(
					sonic.collection,
					sonic.bucket,
					query,
					{
						limit: chunkSize,
						offset: start,
					},
				);

				start += chunkSize;

				if (results.length === 0) {
					break;
				}

				const res = results
					.map((k) => JSON.parse(k))
					.filter((key) => {
						if (ps.sinceId && key.id <= ps.sinceId) {
							return false;
						}
						if (ps.untilId && key.id >= ps.untilId) {
							return false;
						}
						return true;
					})
					.map((key) => key.id);

				ids.push(...res);
			}

			// Sort all the results by note id DESC (newest first)
			ids.sort().reverse();

			// Fetch the notes from the database until we have enough to satisfy the limit
			start = 0;
			const found = [];
			while (found.length < ps.limit && start < ids.length) {
				const chunk = ids.slice(start, start + chunkSize);
				const notes = await scyllaClient
					.execute(prepared.note.select.byIds, [chunk], { prepare: true })
					.then((result) => result.rows.map(parseScyllaNote));

				// The notes are checked for visibility and muted/blocked users when packed
				found.push(...(await Notes.packMany(notes, me)));
				start += chunkSize;
			}

			// If we have more results than the limit, trim them
			if (found.length > ps.limit) {
				found.length = ps.limit;
			}

			return found;
		} else if (meilisearch) {
			let start = 0;
			const chunkSize = 100;
			const sortByDate = true;

			type NoteResult = {
				id: string;
				createdAt: number;
			};
			const extractedNotes: NoteResult[] = [];

			while (true) {
				const searchRes = await meilisearch.search(
					query,
					chunkSize,
					start,
					me,
					sortByDate ? "createdAt:desc" : null,
				);
				const results: MeilisearchNote[] = searchRes.hits as MeilisearchNote[];

				start += chunkSize;

				if (results.length === 0) {
					break;
				}

				const res = results
					.filter((key: MeilisearchNote) => {
						if (ps.sinceId && key.id <= ps.sinceId) {
							return false;
						}
						if (ps.untilId && key.id >= ps.untilId) {
							return false;
						}
						return true;
					})
					.map((key) => {
						return {
							id: key.id,
							createdAt: key.createdAt,
						};
					});

				extractedNotes.push(...res);
			}

			// Fetch the notes from the database until we have enough to satisfy the limit
			start = 0;
			const found = [];
			const noteIDs = extractedNotes.map((note) => note.id);

			// Index the ID => index number into a map, so we can restore the array ordering efficiently later
			const idIndexMap = new Map(noteIDs.map((id, index) => [id, index]));

			while (found.length < ps.limit && start < noteIDs.length) {
				const chunk = noteIDs.slice(start, start + chunkSize);

				const notes = await scyllaClient
					.execute(prepared.note.select.byIds, [chunk], { prepare: true })
					.then((result) => result.rows.map(parseScyllaNote));

				// Re-order the note result according to the noteIDs array (cannot be undefined, we map this earlier)
				// @ts-ignore
				notes.sort((a, b) => idIndexMap.get(a.id) - idIndexMap.get(b.id));

				// The notes are checked for visibility and muted/blocked users when packed
				found.push(...(await Notes.packMany(notes, me)));
				start += chunkSize;
			}

			// If we have more results than the limit, trim the results down
			if (found.length > ps.limit) {
				found.length = ps.limit;
			}

			return found;
		}

		return await Notes.packMany([]);
	}

	const query = makePaginationQuery(
		Notes.createQueryBuilder("note"),
		ps.sinceId,
		ps.untilId,
	)
		.leftJoinAndSelect("note.reply", "reply")
		.leftJoinAndSelect("note.renote", "renote");

	generateVisibilityQuery(query, me);
	if (me) generateMutedUserQuery(query, me);
	if (me) generateBlockedUserQuery(query, me);

	try {
		if (ps.tag) {
			if (!safeForSql(normalizeForSearch(ps.tag))) throw "Injection";
			query.andWhere(`'{"${normalizeForSearch(ps.tag)}"}' <@ note.tags`);
		} else {
			query.andWhere(
				new Brackets((qb) => {
					for (const tags of ps.query!) {
						qb.orWhere(
							new Brackets((qb) => {
								for (const tag of tags) {
									if (!safeForSql(normalizeForSearch(ps.tag)))
										throw "Injection";
									qb.andWhere(`'{"${normalizeForSearch(tag)}"}' <@ note.tags`);
								}
							}),
						);
					}
				}),
			);
		}
	} catch (e) {
		if (e.message === "Injection") return [];
		throw e;
	}

	if (ps.reply != null) {
		if (ps.reply) {
			query.andWhere("note.replyId IS NOT NULL");
		} else {
			query.andWhere("note.replyId IS NULL");
		}
	}

	if (ps.renote != null) {
		if (ps.renote) {
			query.andWhere("note.renoteId IS NOT NULL");
		} else {
			query.andWhere("note.renoteId IS NULL");
		}
	}

	if (ps.withFiles) {
		query.andWhere("note.fileIds != '{}'");
	}

	if (ps.poll != null) {
		if (ps.poll) {
			query.andWhere("note.hasPoll = TRUE");
		} else {
			query.andWhere("note.hasPoll = FALSE");
		}
	}

	// We fetch more than requested because some may be filtered out, and if there's less than
	// requested, the pagination stops.
	const found = [];
	const take = Math.floor(ps.limit * 1.5);
	let skip = 0;
	while (found.length < ps.limit) {
		const notes = await query.take(take).skip(skip).getMany();
		found.push(...(await Notes.packMany(notes, me)));
		skip += take;
		if (notes.length < take) break;
	}

	if (found.length > ps.limit) {
		found.length = ps.limit;
	}

	return found;
});
