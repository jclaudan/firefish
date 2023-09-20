import define from "../../define.js";
import readNote from "@/services/note/read.js";
import { Antennas, Notes, UserProfiles, Users } from "@/models/index.js";
import { redisClient } from "@/db/redis.js";
import { getTimestamp } from "@/misc/gen-id.js";
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
	filterMutedRenotes,
	filterReply,
	execPaginationQuery,
} from "@/db/scylla.js";
import {
	InstanceMutingsCache,
	LocalFollowingsCache,
	RenoteMutingsCache,
	SuspendedUsersCache,
	UserBlockedCache,
	UserBlockingCache,
	UserMutingsCache,
	userWordMuteCache,
} from "@/misc/cache.js";
import * as Acct from "@/misc/acct.js";
import { acctToUserIdCache } from "@/services/user-cache.js";
import config from "@/config/index.js";
import { IsNull } from "typeorm";

export const meta = {
	tags: ["antennas", "account", "notes"],

	requireCredential: true,

	kind: "read:account",

	errors: {
		noSuchAntenna: {
			message: "No such antenna.",
			code: "NO_SUCH_ANTENNA",
			id: "850926e0-fd3b-49b6-b69a-b28a5dbd82fe",
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
		antennaId: { type: "string", format: "misskey:id" },
		limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: "string", format: "misskey:id" },
		untilId: { type: "string", format: "misskey:id" },
		sinceDate: { type: "integer" },
		untilDate: { type: "integer" },
	},
	required: ["antennaId"],
} as const;

export default define(meta, paramDef, async (ps, user) => {
	const antenna = await Antennas.findOneBy({
		id: ps.antennaId,
		userId: user.id,
	});

	if (!antenna) {
		throw new ApiError(meta.errors.noSuchAntenna);
	}

	if (scyllaClient) {
		const [
			followingUserIds,
			mutedUserIds,
			mutedInstances,
			mutedWords,
			blockerIds,
			blockingIds,
			renoteMutedIds,
			suspendedUsers,
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
			RenoteMutingsCache.init(user.id).then((cache) => cache.getAll()),
			SuspendedUsersCache.init().then((cache) => cache.getAll()),
		]);

		const userIds: string[] = [];
		for (const acct of antenna.users) {
			const { username, host } = Acct.parse(acct);
			const userId = await acctToUserIdCache.fetchMaybe(
				`${username.toLowerCase()}@${host ?? config.host}`,
				() =>
					Users.findOne({
						where: {
							usernameLower: username.toLowerCase(),
							host: !host || host === config.host ? IsNull() : host,
							isSuspended: false,
						},
					}).then((user) => user?.id ?? undefined),
			);
			if (userId) {
				userIds.push(userId);
			}
		}

		const instances = antenna.instances
			.filter((x) => x !== "")
			.map((host) => {
				return host.toLowerCase();
			});

		const keywords = antenna.keywords
			.map((xs) => xs.filter((x) => x !== ""))
			.filter((xs) => xs.length > 0);

		const filter = (notes: ScyllaNote[]) => {
			let filtered = filterVisibility(notes, user, followingUserIds);
			filtered = filterReply(filtered, antenna.withReplies, user);
			filtered = filterMutedUser(
				filtered,
				mutedUserIds,
				mutedInstances,
			);
			filtered = filterMutedNote(filtered, user, mutedWords);
			filtered = filterBlockUser(filtered, [
				...blockerIds,
				...blockingIds,
				...suspendedUsers,
			]);
			filtered = filterMutedRenotes(filtered, renoteMutedIds);
			if (antenna.withFile) {
				filtered = filtered.filter((n) => n.files.length > 0);
			}
			switch (antenna.src) {
				case "users":
					filtered = filtered.filter((note) => userIds.includes(note.userId));
					break;
				case "instances":
					filtered = filtered.filter((note) =>
						instances.includes(note.userHost?.toLowerCase() ?? ""),
					);
					break;
			}
			if (keywords.length > 0) {
				filtered = filtered.filter((note) => {
					if (!note.text) return false;
					return keywords.some((and) =>
						and.every((keyword) =>
							antenna.caseSensitive
								? (note.text as string).includes(keyword)
								: (note.text as string)
										.toLowerCase()
										.includes(keyword.toLowerCase()),
						),
					);
				});
			}

			return filtered;
		};

		const foundNotes = (
			(await execPaginationQuery(
				antenna.src === "users" ? "list" : "antenna",
				{ ...ps, userIds },
				{ note: filter },
				user.id,
			)) as ScyllaNote[]
		)
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
			.slice(0, ps.limit);
		return await Notes.packMany(foundNotes, user);
	}

	const limit = ps.limit + (ps.untilId ? 1 : 0) + (ps.sinceId ? 1 : 0); // untilIdに指定したものも含まれるため+1
	let end = "+";
	if (ps.untilDate) {
		end = ps.untilDate.toString();
	} else if (ps.untilId) {
		end = getTimestamp(ps.untilId).toString();
	}
	let start = "-";
	if (ps.sinceDate) {
		start = ps.sinceDate.toString();
	} else if (ps.sinceId) {
		start = getTimestamp(ps.sinceId).toString();
	}
	const noteIdsRes = await redisClient.xrevrange(
		`antennaTimeline:${antenna.id}`,
		end,
		start,
		"COUNT",
		limit,
	);

	if (noteIdsRes.length === 0) {
		return await Notes.packMany([]);
	}

	const noteIds = noteIdsRes
		.map((x) => x[1][1])
		.filter((x) => x !== ps.untilId && x !== ps.sinceId);

	if (noteIds.length === 0) {
		return await Notes.packMany([]);
	}

	const query = makePaginationQuery(
		Notes.createQueryBuilder("note"),
		ps.sinceId,
		ps.untilId,
		ps.sinceDate,
		ps.untilDate,
	)
		.where("note.id IN (:...noteIds)", { noteIds: noteIds })
		.leftJoinAndSelect("note.reply", "reply")
		.leftJoinAndSelect("note.renote", "renote")
		.andWhere("note.visibility != 'home'");

	generateVisibilityQuery(query, user);
	generateMutedUserQuery(query, user);
	generateBlockedUserQuery(query, user);

	const notes = await query.take(limit).getMany();

	if (notes.length > 0) {
		readNote(user.id, notes);
	}

	return await Notes.packMany(notes, user);
});
