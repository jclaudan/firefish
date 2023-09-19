import { Brackets } from "typeorm";
import { Notes, UserProfiles } from "@/models/index.js";
import define from "../../define.js";
import { ApiError } from "../../error.js";
import { getUser } from "../../common/getters.js";
import { makePaginationQuery } from "../../common/make-pagination-query.js";
import { generateVisibilityQuery } from "../../common/generate-visibility-query.js";
import { generateMutedUserQuery } from "../../common/generate-muted-user-query.js";
import { generateBlockedUserQuery } from "../../common/generate-block-query.js";
import {
	type ScyllaNote,
	execPaginationQuery,
	filterBlockUser,
	filterMutedNote,
	filterMutedUser,
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
	tags: ["users", "notes"],

	requireCredentialPrivateMode: true,
	description: "Show all notes that this user created.",

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
		noSuchUser: {
			message: "No such user.",
			code: "NO_SUCH_USER",
			id: "27e494ba-2ac2-48e8-893b-10d4d8c2387b",
		},
	},
} as const;

export const paramDef = {
	type: "object",
	properties: {
		userId: { type: "string", format: "misskey:id" },
		includeReplies: { type: "boolean", default: true },
		limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: "string", format: "misskey:id" },
		untilId: { type: "string", format: "misskey:id" },
		sinceDate: { type: "integer" },
		untilDate: { type: "integer" },
		includeMyRenotes: { type: "boolean", default: true },
		withFiles: { type: "boolean", default: false },
		fileType: {
			type: "array",
			items: {
				type: "string",
			},
		},
		excludeNsfw: { type: "boolean", default: false },
	},
	required: ["userId"],
} as const;

export default define(meta, paramDef, async (ps, me) => {
	// Lookup user
	const user = await getUser(ps.userId).catch((e) => {
		if (e.id === "15348ddd-432d-49c2-8a5a-8069753becff")
			throw new ApiError(meta.errors.noSuchUser);
		throw e;
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
		if (me) {
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
				ChannelFollowingsCache.init(me.id).then((cache) => cache.getAll()),
				LocalFollowingsCache.init(me.id).then((cache) => cache.getAll()),
				UserMutingsCache.init(me.id).then((cache) => cache.getAll()),
				InstanceMutingsCache.init(me.id).then((cache) => cache.getAll()),
				userWordMuteCache
					.fetchMaybe(me.id, () =>
						UserProfiles.findOne({
							select: ["mutedWords"],
							where: { userId: user.id },
						}).then((profile) => profile?.mutedWords),
					)
					.then((words) => words ?? []),
				UserBlockedCache.init(me.id).then((cache) => cache.getAll()),
				UserBlockingCache.init(me.id).then((cache) => cache.getAll()),
				RenoteMutingsCache.init(me.id).then((cache) => cache.getAll()),
			]);
		}

		if (
			mutedUserIds.includes(user.id) ||
			blockerIds.includes(user.id) ||
			(user.host && mutedInstances.includes(user.host))
		) {
			return Notes.packMany([]);
		}

		const filter = async (notes: ScyllaNote[]) => {
			let filtered = notes.filter((n) => n.userId === ps.userId);
			filtered = await filterVisibility(filtered, me, followingUserIds);
			if (me) {
				filtered = await filterMutedUser(
					filtered,
					me,
					mutedUserIds,
					mutedInstances,
				);
				filtered = await filterMutedNote(filtered, me, mutedWords);
				filtered = await filterBlockUser(filtered, me, [
					...blockerIds,
					...blockingIds,
				]);
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
			if (!ps.includeMyRenotes) {
				filtered = filtered.filter(
					(n) =>
						n.userId !== user.id ||
						!n.renoteId ||
						!!n.text ||
						n.files.length > 0 ||
						n.hasPoll,
				);
			}
			if (!ps.includeReplies) {
				filtered = filtered.filter((n) => !n.replyId);
			}
			return filtered;
		};

		const foundNotes = (
			(await execPaginationQuery(
				"user",
				ps,
				{ note: filter },
				user.id,
			)) as ScyllaNote[]
		).slice(0, ps.limit);
		return await Notes.packMany(foundNotes, user);
	}

	//#region Construct query
	const query = makePaginationQuery(
		Notes.createQueryBuilder("note"),
		ps.sinceId,
		ps.untilId,
		ps.sinceDate,
		ps.untilDate,
	)
		.andWhere("note.userId = :userId", { userId: user.id })
		.leftJoinAndSelect("note.reply", "reply")
		.leftJoinAndSelect("note.renote", "renote");

	generateVisibilityQuery(query, me);
	if (me) {
		generateMutedUserQuery(query, me, user);
		generateBlockedUserQuery(query, me);
	}

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

	if (!ps.includeReplies) {
		query.andWhere("note.replyId IS NULL");
	}

	if (ps.includeMyRenotes === false) {
		query.andWhere(
			new Brackets((qb) => {
				qb.orWhere("note.userId != :userId", { userId: user.id });
				qb.orWhere("note.renoteId IS NULL");
				qb.orWhere("note.text IS NOT NULL");
				qb.orWhere("note.fileIds != '{}'");
				qb.orWhere(
					'0 < (SELECT COUNT(*) FROM poll WHERE poll."noteId" = note.id)',
				);
			}),
		);
	}

	//#endregion

	const timeline = await query.take(ps.limit).getMany();

	return await Notes.packMany(timeline, me);
});
