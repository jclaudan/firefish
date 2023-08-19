import define from "../../define.js";
import { ApiError } from "../../error.js";
import { Notes, Channels, UserProfiles } from "@/models/index.js";
import { makePaginationQuery } from "../../common/make-pagination-query.js";
import { activeUsersChart } from "@/services/chart/index.js";
import {
	type ScyllaNote,
	execPaginationQuery,
	filterBlockUser,
	filterMutedNote,
	filterMutedUser,
	scyllaClient,
} from "@/db/scylla.js";
import {
	UserBlockedCache,
	UserBlockingCache,
	UserMutingsCache,
	userWordMuteCache,
} from "@/misc/cache.js";

export const meta = {
	tags: ["notes", "channels"],

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
		noSuchChannel: {
			message: "No such channel.",
			code: "NO_SUCH_CHANNEL",
			id: "4d0eeeba-a02c-4c3c-9966-ef60d38d2e7f",
		},
	},
} as const;

export const paramDef = {
	type: "object",
	properties: {
		channelId: { type: "string", format: "misskey:id" },
		limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: "string", format: "misskey:id" },
		untilId: { type: "string", format: "misskey:id" },
		sinceDate: { type: "integer" },
		untilDate: { type: "integer" },
	},
	required: ["channelId"],
} as const;

export default define(meta, paramDef, async (ps, user) => {
	const channel = await Channels.findOneBy({
		id: ps.channelId,
	});

	if (!channel) {
		throw new ApiError(meta.errors.noSuchChannel);
	}

	if (user) activeUsersChart.read(user);

	if (scyllaClient) {
		let [mutedUserIds, blockerIds, blockingIds]: string[][] = [];
		let mutedWords: string[][];
		if (user) {
			[mutedUserIds, mutedWords, blockerIds, blockingIds] = await Promise.all([
				UserMutingsCache.init(user.id).then((cache) => cache.getAll()),
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
			if (!user) return notes;
			let filtered = await filterMutedUser(notes, user, mutedUserIds, []);
			filtered = await filterMutedNote(filtered, user, mutedWords);
			filtered = await filterBlockUser(filtered, user, [
				...blockerIds,
				...blockingIds,
			]);
			return filtered;
		};

		const foundPacked = [];
		while (foundPacked.length < ps.limit) {
			const foundNotes = (
				(await execPaginationQuery("channel", ps, {
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
		.andWhere("note.channelId = :channelId", { channelId: channel.id })
		.innerJoinAndSelect("note.user", "user")
		.leftJoinAndSelect("note.channel", "channel");
	//#endregion

	const timeline = await query.take(ps.limit).getMany();

	return await Notes.packMany(timeline, user);
});
