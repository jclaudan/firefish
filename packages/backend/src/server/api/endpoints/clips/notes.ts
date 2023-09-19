import define from "../../define.js";
import { ClipNotes, Clips, Notes, UserProfiles } from "@/models/index.js";
import { makePaginationQuery } from "../../common/make-pagination-query.js";
import { generateVisibilityQuery } from "../../common/generate-visibility-query.js";
import { generateMutedUserQuery } from "../../common/generate-muted-user-query.js";
import { ApiError } from "../../error.js";
import { generateBlockedUserQuery } from "../../common/generate-block-query.js";
import {
	type ScyllaNote,
	scyllaClient,
	filterVisibility,
	filterMutedUser,
	filterMutedNote,
	filterBlockUser,
	prepared,
	parseScyllaNote,
} from "@/db/scylla.js";
import {
	InstanceMutingsCache,
	LocalFollowingsCache,
	UserBlockedCache,
	UserBlockingCache,
	UserMutingsCache,
	userWordMuteCache,
} from "@/misc/cache.js";
import { Between, MoreThan, LessThan, FindOptionsWhere } from "typeorm";
import type { ClipNote } from "@/models/entities/clip-note.js";

export const meta = {
	tags: ["account", "notes", "clips"],

	requireCredential: false,
	requireCredentialPrivateMode: true,

	kind: "read:account",

	errors: {
		noSuchClip: {
			message: "No such clip.",
			code: "NO_SUCH_CLIP",
			id: "1d7645e6-2b6d-4635-b0fe-fe22b0e72e00",
		},
	},

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
		clipId: { type: "string", format: "misskey:id" },
		limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: "string", format: "misskey:id" },
		untilId: { type: "string", format: "misskey:id" },
	},
	required: ["clipId"],
} as const;

export default define(meta, paramDef, async (ps, user) => {
	const clip = await Clips.findOneBy({
		id: ps.clipId,
	});

	if (!clip) {
		throw new ApiError(meta.errors.noSuchClip);
	}

	if (!clip.isPublic && (user == null || clip.userId !== user.id)) {
		throw new ApiError(meta.errors.noSuchClip);
	}

	if (scyllaClient) {
		let [
			followingUserIds,
			mutedUserIds,
			mutedInstances,
			blockerIds,
			blockingIds,
		]: string[][] = [];
		let mutedWords: string[][];
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

		const filter = async (notes: ScyllaNote[]) => {
			let filtered = notes;
			if (user) {
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
			}
			return filtered;
		};

		const foundPacked = [];
		while (foundPacked.length < ps.limit) {
			let whereOpt: FindOptionsWhere<ClipNote> = { clipId: clip.id };
			if (ps.sinceId && ps.untilId) {
				whereOpt = { ...whereOpt, noteId: Between(ps.sinceId, ps.untilId) };
			} else if (ps.sinceId) {
				whereOpt = { ...whereOpt, noteId: MoreThan(ps.sinceId) };
			} else if (ps.untilId) {
				whereOpt = { ...whereOpt, noteId: LessThan(ps.untilId) };
			}

			const noteIds = await ClipNotes.find({
				where: whereOpt,
				order: { noteId: "DESC" },
				take: ps.limit * 1.5, // Some may be filtered out by Notes.packMany, thus we take more than ps.limit.
			}).then((clips) => clips.map(({ noteId }) => noteId));

			if (noteIds.length === 0) break;

			const foundNotes = (await scyllaClient
				.execute(prepared.note.select.byIds, [noteIds], { prepare: true })
				.then((result) => result.rows.map(parseScyllaNote)))

			foundPacked.push(...(await Notes.packMany((await filter(foundNotes)), user)));
			if (foundNotes.length < ps.limit) break;
			ps.untilId = foundNotes[foundNotes.length - 1].id;
		}

		return foundPacked.slice(0, ps.limit);
	}

	const query = makePaginationQuery(
		Notes.createQueryBuilder("note"),
		ps.sinceId,
		ps.untilId,
	)
		.innerJoin(
			ClipNotes.metadata.targetName,
			"clipNote",
			"clipNote.noteId = note.id",
		)
		.leftJoinAndSelect("note.reply", "reply")
		.leftJoinAndSelect("note.renote", "renote")
		.andWhere("clipNote.clipId = :clipId", { clipId: clip.id });

	if (user) {
		generateVisibilityQuery(query, user);
		generateMutedUserQuery(query, user);
		generateBlockedUserQuery(query, user);
	}

	const notes = await query.take(ps.limit).getMany();

	return await Notes.packMany(notes, user);
});
