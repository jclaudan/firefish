import { fetchMeta } from "@/misc/fetch-meta.js";
import { Notes, UserProfiles } from "@/models/index.js";
import { activeUsersChart } from "@/services/chart/index.js";
import define from "../../define.js";
import { ApiError } from "../../error.js";
import { makePaginationQuery } from "../../common/make-pagination-query.js";
import { generateMutedUserQuery } from "../../common/generate-muted-user-query.js";
import { generateRepliesQuery } from "../../common/generate-replies-query.js";
import { generateMutedNoteQuery } from "../../common/generate-muted-note-query.js";
import { generateBlockedUserQuery } from "../../common/generate-block-query.js";
import { generateMutedUserRenotesQueryForNotes } from "../../common/generated-muted-renote-query.js";
import {
	type ScyllaNote,
	execPaginationQuery,
	filterBlockUser,
	filterMutedNote,
	filterMutedRenotes,
	filterMutedUser,
	filterReply,
	scyllaClient,
} from "@/db/scylla.js";
import {
	InstanceMutingsCache,
	RenoteMutingsCache,
	SuspendedUsersCache,
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
		gtlDisabled: {
			message: "Global timeline has been disabled.",
			code: "GTL_DISABLED",
			id: "0332fc13-6ab2-4427-ae80-a9fadffd1a6b",
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
	if (m.disableGlobalTimeline) {
		if (user == null || !(user.isAdmin || user.isModerator)) {
			throw new ApiError(meta.errors.gtlDisabled);
		}
	}

	process.nextTick(() => {
		if (user) {
			activeUsersChart.read(user);
		}
	});

	if (scyllaClient) {
		let [
			mutedUserIds,
			mutedInstances,
			blockerIds,
			blockingIds,
			renoteMutedIds,
		]: string[][] = [];
		let mutedWords: string[][];
		blockerIds = [];
		blockingIds = [];
		const suspendedUsers = await SuspendedUsersCache.init().then((cache) => cache.getAll());
		if (user) {
			[
				mutedUserIds,
				mutedInstances,
				mutedWords,
				blockerIds,
				blockingIds,
				renoteMutedIds,
			] = await Promise.all([
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

		const filter = (notes: ScyllaNote[]) => {
			let filtered = notes.filter(
				(n) => n.visibility === "public" && !n.channelId,
			);
			filtered = filterReply(filtered, ps.withReplies, user);
			filtered = filterBlockUser(filtered, [
				...blockerIds,
				...blockingIds,
				...suspendedUsers,
			]);
			if (user) {
				filtered = filterMutedUser(
					filtered,
					mutedUserIds,
					mutedInstances,
				);
				filtered = filterMutedNote(filtered, user, mutedWords);
				filtered = filterMutedRenotes(filtered, renoteMutedIds);
			}
			if (ps.withFiles) {
				filtered = filtered.filter((n) => n.files.length > 0);
			}
			filtered = filtered.filter((n) => n.visibility !== "hidden");
			return filtered;
		};

		const foundPacked = [];
		while (foundPacked.length < ps.limit) {
			const foundNotes = (
				(await execPaginationQuery("global", ps, {
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
	)
		.andWhere("note.visibility = 'public'")
		.andWhere("note.channelId IS NULL")
		.leftJoinAndSelect("note.reply", "reply")
		.leftJoinAndSelect("note.renote", "renote");

	generateRepliesQuery(query, ps.withReplies, user);
	if (user) {
		generateMutedUserQuery(query, user);
		generateMutedNoteQuery(query, user);
		generateBlockedUserQuery(query, user);
		generateMutedUserRenotesQueryForNotes(query, user);
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
