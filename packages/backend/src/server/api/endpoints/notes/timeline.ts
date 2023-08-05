import { Brackets } from "typeorm";
import { Notes, Followings } from "@/models/index.js";
import { activeUsersChart } from "@/services/chart/index.js";
import define from "../../define.js";
import { makePaginationQuery } from "../../common/make-pagination-query.js";
import { generateVisibilityQuery } from "../../common/generate-visibility-query.js";
import { generateMutedUserQuery } from "../../common/generate-muted-user-query.js";
import { generateRepliesQuery } from "../../common/generate-replies-query.js";
import { generateMutedNoteQuery } from "../../common/generate-muted-note-query.js";
import { generateChannelQuery } from "../../common/generate-channel-query.js";
import { generateBlockedUserQuery } from "../../common/generate-block-query.js";
import { generateMutedUserRenotesQueryForNotes } from "../../common/generated-muted-renote-query.js";
import { ApiError } from "../../error.js";
import {
	type ScyllaNote,
	parseScyllaNote,
	prepared,
	scyllaClient,
	filterChannel,
	filterReply,
} from "@/db/scylla.js";
import { LocalFollowingsCache } from "@/misc/cache.js";
import { getTimestamp } from "@/misc/gen-id.js";

export const meta = {
	tags: ["notes"],

	requireCredential: true,

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

	errors: {
		queryError: {
			message: "Please follow more users.",
			code: "QUERY_ERROR",
			id: "620763f4-f621-4533-ab33-0577a1a3c343",
		},
	},
} as const;

export const paramDef = {
	type: "object",
	properties: {
		limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: "string", format: "misskey:id" },
		untilId: { type: "string", format: "misskey:id" },
		sinceDate: { type: "integer" },
		untilDate: { type: "integer" },
		includeMyRenotes: { type: "boolean", default: true },
		includeRenotedMyNotes: { type: "boolean", default: true },
		includeLocalRenotes: { type: "boolean", default: true },
		withFiles: {
			type: "boolean",
			default: false,
			description: "Only show notes that have attached files.",
		},
		withReplies: {
			type: "boolean",
			default: false,
			description: "Show replies in the timeline",
		},
	},
	required: [],
} as const;

export default define(meta, paramDef, async (ps, user) => {
	const followingsCache = await LocalFollowingsCache.init(user.id);

	if (scyllaClient) {
		let untilDate = new Date();
		const foundNotes: ScyllaNote[] = [];
		const validIds = [user.id].concat(await followingsCache.getAll());
		const query = `${prepared.note.select.byDate} AND "createdAt" < ? LIMIT 50`; // LIMIT is hardcoded to prepare

		if (ps.untilId) {
			untilDate = new Date(getTimestamp(ps.untilId));
		}

		let scanned_partitions = 0;

		// Try to get posts of at most 30 days in the single request
		while (foundNotes.length < ps.limit && scanned_partitions < 30) {
			const params: (Date | string | string[])[] = [untilDate, untilDate];

			const result = await scyllaClient.execute(query, params, {
				prepare: true,
			});

			if (result.rowLength === 0) {
				// Reached the end of partition. Queries posts created one day before.
				scanned_partitions++;
				untilDate = new Date(
					untilDate.getUTCFullYear(),
					untilDate.getUTCMonth(),
					untilDate.getUTCDate() - 1,
					23,
					59,
					59,
					999,
				);
				continue;
			}

			const notes = result.rows.map(parseScyllaNote);
			let filtered = notes.filter((note) => validIds.includes(note.userId));

			filtered = await filterChannel(filtered, user);
			filtered = await filterReply(filtered, ps.withReplies, user);

			foundNotes.push(...filtered);

			untilDate = notes[notes.length - 1].createdAt;
		}

		return Notes.packMany(foundNotes.slice(0, ps.limit), user);
	}

	const hasFollowing = await followingsCache.hasFollowing();

	//#region Construct query
	const followingQuery = Followings.createQueryBuilder("following")
		.select("following.followeeId")
		.where("following.followerId = :followerId", { followerId: user.id });

	const query = makePaginationQuery(
		Notes.createQueryBuilder("note"),
		ps.sinceId,
		ps.untilId,
		ps.sinceDate,
		ps.untilDate,
	)
		.andWhere(
			new Brackets((qb) => {
				qb.where("note.userId = :meId", { meId: user.id });
				if (hasFollowing)
					qb.orWhere(`note.userId IN (${followingQuery.getQuery()})`);
			}),
		)
		.setParameters(followingQuery.getParameters());

	generateChannelQuery(query, user);
	generateRepliesQuery(query, ps.withReplies, user);
	generateVisibilityQuery(query, user);
	generateMutedUserQuery(query, user);
	generateMutedNoteQuery(query, user);
	generateBlockedUserQuery(query, user);
	generateMutedUserRenotesQueryForNotes(query, user);

	if (ps.includeMyRenotes === false) {
		query.andWhere(
			new Brackets((qb) => {
				qb.orWhere("note.userId != :meId", { meId: user.id });
				qb.orWhere("note.renoteId IS NULL");
				qb.orWhere("note.text IS NOT NULL");
				qb.orWhere("note.fileIds != '{}'");
				qb.orWhere(
					'0 < (SELECT COUNT(*) FROM poll WHERE poll."noteId" = note.id)',
				);
			}),
		);
	}

	if (ps.includeRenotedMyNotes === false) {
		query.andWhere(
			new Brackets((qb) => {
				qb.orWhere("note.renoteUserId != :meId", { meId: user.id });
				qb.orWhere("note.renoteId IS NULL");
				qb.orWhere("note.text IS NOT NULL");
				qb.orWhere("note.fileIds != '{}'");
				qb.orWhere(
					'0 < (SELECT COUNT(*) FROM poll WHERE poll."noteId" = note.id)',
				);
			}),
		);
	}

	if (ps.includeLocalRenotes === false) {
		query.andWhere(
			new Brackets((qb) => {
				qb.orWhere("note.renoteUserHost IS NOT NULL");
				qb.orWhere("note.renoteId IS NULL");
				qb.orWhere("note.text IS NOT NULL");
				qb.orWhere("note.fileIds != '{}'");
				qb.orWhere(
					'0 < (SELECT COUNT(*) FROM poll WHERE poll."noteId" = note.id)',
				);
			}),
		);
	}

	if (ps.withFiles) {
		query.andWhere("note.fileIds != '{}'");
	}

	query.andWhere("note.visibility != 'hidden'");
	//#endregion

	process.nextTick(() => {
		activeUsersChart.read(user);
	});

	// We fetch more than requested because some may be filtered out, and if there's less than
	// requested, the pagination stops.
	const found = [];
	const take = Math.floor(ps.limit * 1.5);
	let skip = 0;
	try {
		while (found.length < ps.limit) {
			const notes = await query.take(take).skip(skip).getMany();
			found.push(...(await Notes.packMany(notes, user)));
			skip += take;
			if (notes.length < take) break;
		}
	} catch (error) {
		throw new ApiError(meta.errors.queryError);
	}

	if (found.length > ps.limit) {
		found.length = ps.limit;
	}

	return found;
});
