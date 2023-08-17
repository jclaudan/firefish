import { Brackets } from "typeorm";
import { fetchMeta } from "@/misc/fetch-meta.js";
import { Followings, Notes, UserProfiles } from "@/models/index.js";
import { activeUsersChart } from "@/services/chart/index.js";
import define from "../../define.js";
import { ApiError } from "../../error.js";
import { makePaginationQuery } from "../../common/make-pagination-query.js";
import { generateVisibilityQuery } from "../../common/generate-visibility-query.js";
import { generateMutedUserQuery } from "../../common/generate-muted-user-query.js";
import { generateRepliesQuery } from "../../common/generate-replies-query.js";
import { generateMutedNoteQuery } from "../../common/generate-muted-note-query.js";
import { generateChannelQuery } from "../../common/generate-channel-query.js";
import { generateBlockedUserQuery } from "../../common/generate-block-query.js";
import { generateMutedUserRenotesQueryForNotes } from "../../common/generated-muted-renote-query.js";
import {
	ScyllaNote,
	execNotePaginationQuery,
	filterBlockUser,
	filterChannel,
	filterMutedNote,
	filterMutedRenotes,
	filterMutedUser,
	filterReply,
	filterVisibility,
	scyllaClient,
} from "@/db/scylla.js";
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
		stlDisabled: {
			message: "Hybrid timeline has been disabled.",
			code: "STL_DISABLED",
			id: "620763f4-f621-4533-ab33-0577a1a3c342",
		},
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
	const m = await fetchMeta();
	if (m.disableLocalTimeline && !user.isAdmin && !user.isModerator) {
		throw new ApiError(meta.errors.stlDisabled);
	}

	process.nextTick(() => {
		activeUsersChart.read(user);
	});

	if (scyllaClient) {
		const [
			followingChannelIds,
			followingUserIds,
			mutedUserIds,
			mutedInstances,
			mutedWords,
			blockerIds,
			blockingIds,
			renoteMutedIds,
		] = await Promise.all([
			ChannelFollowingsCache.init(user.id).then((cache) => cache.getAll()),
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
			RenoteMutingsCache.init(user.id).then((cache) => cache.getAll()),
		]);
		const homeUserIds = [user.id, ...followingUserIds];
		const optFilter = (n: ScyllaNote) =>
			!n.renoteId || !!n.text || n.files.length > 0 || n.hasPoll;

		const homeFilter = (notes: ScyllaNote[]) =>
			notes.filter((n) => homeUserIds.includes(n.userId));
		const localFilter = (notes: ScyllaNote[]) =>
			notes.filter((n) => !homeUserIds.includes(n.userId));

		const commonFilter = async (notes: ScyllaNote[]) => {
			let filtered = await filterChannel(notes, user, followingChannelIds);
			filtered = await filterReply(filtered, ps.withReplies, user);
			filtered = await filterVisibility(filtered, user, followingUserIds);
			filtered = await filterMutedUser(
				filtered,
				user,
				mutedUserIds,
				mutedInstances,
			);
			filtered = await filterMutedNote(filtered, user, mutedWords);
			filtered = await filterBlockUser(filtered, user, [
				...blockerIds,
				...blockingIds,
			]);
			filtered = await filterMutedRenotes(filtered, user, renoteMutedIds);
			if (!ps.includeMyRenotes) {
				filtered = filtered.filter((n) => n.userId !== user.id || optFilter(n));
			}
			if (!ps.includeRenotedMyNotes) {
				filtered = filtered.filter(
					(n) => n.renoteUserId !== user.id || optFilter(n),
				);
			}
			if (!ps.includeLocalRenotes) {
				filtered = filtered.filter((n) => n.renoteUserHost || optFilter(n));
			}
			if (ps.withFiles) {
				filtered = filtered.filter((n) => n.files.length > 0);
			}
			filtered = filtered.filter((n) => n.visibility !== "hidden");
			return filtered;
		};

		const foundPacked = [];
		while (foundPacked.length < ps.limit) {
			const [homeFoundNotes, localFoundNotes] = await Promise.all([
				execNotePaginationQuery(
					"home",
					ps,
					(notes) => commonFilter(homeFilter(notes)),
					user.id,
				),
				execNotePaginationQuery("local", ps, (notes) =>
					commonFilter(localFilter(notes)),
				),
			]);
			const foundNotes = [...homeFoundNotes, ...localFoundNotes]
				.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()) // Descendent
				.slice(0, ps.limit * 1.5); // Some may be filtered out by Notes.packMany, thus we take more than ps.limit.
			foundPacked.push(
				...(await Notes.packMany(foundNotes, user, { scyllaNote: true })),
			);
			if (foundNotes.length < ps.limit) break;
			ps.untilDate = foundNotes[foundNotes.length - 1].createdAt.getTime();
		}

		return foundPacked.slice(0, ps.limit);
	}

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
				qb.where(
					`((note.userId IN (${followingQuery.getQuery()})) OR (note.userId = :meId))`,
					{ meId: user.id },
				).orWhere("(note.visibility = 'public') AND (note.userHost IS NULL)");
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
