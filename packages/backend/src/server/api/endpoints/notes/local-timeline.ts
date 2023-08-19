import { Brackets } from "typeorm";
import { fetchMeta } from "@/misc/fetch-meta.js";
import { Notes, UserProfiles, Users } from "@/models/index.js";
import { activeUsersChart } from "@/services/chart/index.js";
import define from "../../define.js";
import { ApiError } from "../../error.js";
import { generateMutedUserQuery } from "../../common/generate-muted-user-query.js";
import { makePaginationQuery } from "../../common/make-pagination-query.js";
import { generateVisibilityQuery } from "../../common/generate-visibility-query.js";
import { generateRepliesQuery } from "../../common/generate-replies-query.js";
import { generateMutedNoteQuery } from "../../common/generate-muted-note-query.js";
import { generateChannelQuery } from "../../common/generate-channel-query.js";
import { generateBlockedUserQuery } from "../../common/generate-block-query.js";
import { generateMutedUserRenotesQueryForNotes } from "../../common/generated-muted-renote-query.js";
import {
	type ScyllaNote,
	execPaginationQuery,
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

	errors: {
		ltlDisabled: {
			message: "Local timeline has been disabled.",
			code: "LTL_DISABLED",
			id: "45a6eb02-7695-4393-b023-dd3be9aaaefd",
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
		withFiles: {
			type: "boolean",
			default: false,
			description: "Only show notes that have attached files.",
		},
		fileType: {
			type: "array",
			items: {
				type: "string",
			},
		},
		excludeNsfw: { type: "boolean", default: false },
		limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: "string", format: "misskey:id" },
		untilId: { type: "string", format: "misskey:id" },
		sinceDate: { type: "integer" },
		untilDate: { type: "integer" },
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

	if (m.disableLocalTimeline) {
		if (user == null || !(user.isAdmin || user.isModerator)) {
			throw new ApiError(meta.errors.ltlDisabled);
		}
	}

	process.nextTick(() => {
		if (user) {
			activeUsersChart.read(user);
		}
	});

	if (scyllaClient) {
		let [
			followingChannelIds,
			followingUserIds,
			mutedUserIds,
			mutedInstances,
			blockerIds,
			blockingIds,
			renoteMutedIds,
		]: string[][] = [];
		let mutedWords: string[][];
		if (user) {
			[
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
		}

		const filter = async (notes: ScyllaNote[]) => {
			let filtered = await filterChannel(notes, user, followingChannelIds);
			filtered = await filterReply(filtered, ps.withReplies, user);
			filtered = await filterVisibility(filtered, user, followingUserIds);
			if (user) {
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
			}
			if (ps.withFiles) {
				filtered = filtered.filter((n) => n.files.length > 0);
			}
			if (ps.fileType) {
				filtered = filtered.filter((n) =>
					n.files.some((f) => ps.fileType?.includes(f.type)),
				);
			}
			if (ps.excludeNsfw) {
				filtered = filtered.filter(
					(n) => !n.cw && n.files.every((f) => !f.isSensitive),
				);
			}
			filtered = filtered.filter((n) => n.visibility !== "hidden");
			return filtered;
		};

		const foundPacked = [];
		while (foundPacked.length < ps.limit) {
			const foundNotes = (
				(await execPaginationQuery("local", ps, {
					note: filter,
				})) as ScyllaNote[]
			).slice(0, ps.limit * 1.5); // Some may filtered out by Notes.packMany, thus we take more than ps.limit.
			foundPacked.push(...(await Notes.packMany(foundNotes, user)));
			if (foundNotes.length < ps.limit) break;
			ps.untilDate = foundNotes[foundNotes.length - 1].createdAt.getTime();
		}

		return foundPacked.slice(0, ps.limit);
	}

	//#region Construct query
	const query = makePaginationQuery(
		Notes.createQueryBuilder("note"),
		ps.sinceId,
		ps.untilId,
		ps.sinceDate,
		ps.untilDate,
	).andWhere("(note.visibility = 'public') AND (note.userHost IS NULL)");

	generateChannelQuery(query, user);
	generateRepliesQuery(query, ps.withReplies, user);
	generateVisibilityQuery(query, user);
	if (user) generateMutedUserQuery(query, user);
	if (user) generateMutedNoteQuery(query, user);
	if (user) generateBlockedUserQuery(query, user);
	if (user) generateMutedUserRenotesQueryForNotes(query, user);

	if (ps.withFiles) {
		query.andWhere("note.fileIds != '{}'");
	}

	if (ps.fileType != null) {
		query.andWhere("note.fileIds != '{}'");
		query.andWhere(
			new Brackets((qb) => {
				for (const type of ps.fileType!) {
					const i = ps.fileType!.indexOf(type);
					qb.orWhere(`:type${i} = ANY(note.attachedFileTypes)`, {
						[`type${i}`]: type,
					});
				}
			}),
		);

		if (ps.excludeNsfw) {
			query.andWhere("note.cw IS NULL");
			query.andWhere(
				'0 = (SELECT COUNT(*) FROM drive_file df WHERE df.id = ANY(note."fileIds") AND df."isSensitive" = TRUE)',
			);
		}
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
