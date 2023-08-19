import { Notes } from "@/models/index.js";
import define from "../../define.js";
import { getNote } from "../../common/getters.js";
import { ApiError } from "../../error.js";
import { generateVisibilityQuery } from "../../common/generate-visibility-query.js";
import { generateMutedUserQuery } from "../../common/generate-muted-user-query.js";
import { makePaginationQuery } from "../../common/make-pagination-query.js";
import { generateBlockedUserQuery } from "../../common/generate-block-query.js";
import {
	type ScyllaNote,
	execPaginationQuery,
	filterBlockUser,
	filterMutedUser,
	filterVisibility,
	scyllaClient,
} from "@/db/scylla.js";
import {
	InstanceMutingsCache,
	LocalFollowingsCache,
	UserBlockedCache,
	UserBlockingCache,
	UserMutingsCache,
} from "@/misc/cache.js";

export const meta = {
	tags: ["notes"],

	requireCredential: false,
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
		noSuchNote: {
			message: "No such note.",
			code: "NO_SUCH_NOTE",
			id: "12908022-2e21-46cd-ba6a-3edaf6093f46",
		},
	},
} as const;

export const paramDef = {
	type: "object",
	properties: {
		noteId: { type: "string", format: "misskey:id" },
		userId: { type: "string", format: "misskey:id" },
		limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: "string", format: "misskey:id" },
		untilId: { type: "string", format: "misskey:id" },
	},
	required: ["noteId"],
} as const;

export default define(meta, paramDef, async (ps, user) => {
	let followingUserIds: string[] = [];
	if (user) {
		followingUserIds = await LocalFollowingsCache.init(user.id).then((cache) =>
			cache.getAll(),
		);
	}

	const note = await getNote(ps.noteId, user, followingUserIds).catch((err) => {
		if (err.id === "9725d0ce-ba28-4dde-95a7-2cbb2c15de24")
			throw new ApiError(meta.errors.noSuchNote);
		throw err;
	});

	if (scyllaClient) {
		let [mutedUserIds, mutedInstances, blockerIds, blockingIds]: string[][] =
			[];
		if (user) {
			[mutedUserIds, mutedInstances, blockerIds, blockingIds] =
				await Promise.all([
					UserMutingsCache.init(user.id).then((cache) => cache.getAll()),
					InstanceMutingsCache.init(user.id).then((cache) => cache.getAll()),
					UserBlockedCache.init(user.id).then((cache) => cache.getAll()),
					UserBlockingCache.init(user.id).then((cache) => cache.getAll()),
				]);
		}

		const filter = async (notes: ScyllaNote[]) => {
			let filtered = notes;
			if (ps.userId) {
				filtered = filtered.filter((n) => n.userId === ps.userId);
			}
			filtered = await filterVisibility(filtered, user, followingUserIds);
			if (user) {
				filtered = await filterMutedUser(
					filtered,
					user,
					mutedUserIds,
					mutedInstances,
				);
				filtered = await filterBlockUser(filtered, user, [
					...blockerIds,
					...blockingIds,
				]);
			}
			return filtered;
		};

		const foundPacked = [];
		let untilDate: number | undefined;
		while (foundPacked.length < ps.limit) {
			const foundNotes = (
				(await execPaginationQuery(
					"renotes",
					{ ...ps, untilDate },
					{ note: filter },
					user?.id,
					1,
				)) as ScyllaNote[]
			).slice(0, ps.limit * 1.5); // Some may filtered out by Notes.packMany, thus we take more than ps.limit.
			foundPacked.push(...(await Notes.packMany(foundNotes, user)));
			if (foundNotes.length < ps.limit) break;
			untilDate = foundNotes[foundNotes.length - 1].createdAt.getTime();
		}

		return foundPacked.slice(0, ps.limit);
	}

	const query = makePaginationQuery(
		Notes.createQueryBuilder("note"),
		ps.sinceId,
		ps.untilId,
	).andWhere("note.renoteId = :renoteId", { renoteId: note.id });

	if (ps.userId) {
		query.andWhere("note.userId = :userId", { userId: ps.userId });
	}

	generateVisibilityQuery(query, user);
	if (user) generateMutedUserQuery(query, user);
	if (user) generateBlockedUserQuery(query, user);

	// We fetch more than requested because some may be filtered out, and if there's less than
	// requested, the pagination stops.
	const found = [];
	const take = Math.floor(ps.limit * 1.5);
	let skip = 0;
	while (found.length < ps.limit) {
		const notes = await query.take(take).skip(skip).getMany();
		found.push(...(await Notes.packMany(notes, user)));
		skip += take;
		if (notes.length < take) break;
	}

	if (found.length > ps.limit) {
		found.length = ps.limit;
	}

	return found;
});
