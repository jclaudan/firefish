import { Notes, UserProfiles } from "@/models/index.js";
import define from "../../define.js";
import { generateMutedUserQuery } from "../../common/generate-muted-user-query.js";
import { generateBlockedUserQuery } from "../../common/generate-block-query.js";
import {
	type ScyllaNote,
	scyllaClient,
	prepared,
	parseScyllaNote,
	filterMutedNote,
	filterMutedUser,
	filterBlockUser,
} from "@/db/scylla.js";
import {
	InstanceMutingsCache,
	SuspendedUsersCache,
	UserBlockedCache,
	UserBlockingCache,
	UserMutingsCache,
	userWordMuteCache,
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
} as const;

export const paramDef = {
	type: "object",
	properties: {
		limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
		offset: { type: "integer", default: 0 },
		origin: {
			type: "string",
			enum: ["combined", "local", "remote"],
			default: "local",
		},
		days: { type: "integer", minimum: 1, maximum: 365, default: 3 },
	},
	required: [],
} as const;

const ONEDAY = 1000 * 60 * 60 * 24;

export default define(meta, paramDef, async (ps, user) => {
	const max = 30;
	const day = ONEDAY * ps.days;

	if (scyllaClient) {
		let [mutedUserIds, mutedInstances, blockerIds, blockingIds]: string[][] =
			[];
		let mutedWords: string[][] = [];
		blockerIds = [];
		blockingIds = [];
		const suspendedUserIds = await SuspendedUsersCache.init().then((cache) => cache.getAll());

		const foundNotes: ScyllaNote[] = [];
		let searchedDays = 0;
		let targetDay = new Date();

		if (user) {
			[mutedUserIds, mutedInstances, mutedWords, blockerIds, blockingIds] =
				await Promise.all([
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

		while (foundNotes.length < max && searchedDays < ps.days) {
			searchedDays++;
			let notes = await scyllaClient
				.execute(prepared.scoreFeed.select, [targetDay], { prepare: true })
				.then((result) => result.rows.map(parseScyllaNote));

			switch (ps.origin) {
				case "local":
					notes = notes.filter((note) => !note.userHost);
					break;
				case "remote":
					notes = notes.filter((note) => !!note.userHost);
					break;
			}

			notes = filterBlockUser(notes, [
				...blockerIds,
				...blockingIds,
				...suspendedUserIds,
			]);

			if (user) {
				notes = filterMutedUser(
					notes,
					mutedUserIds,
					mutedInstances,
				);
				notes = filterMutedNote(notes, user, mutedWords);
			}

			foundNotes.push(...notes);
			targetDay = new Date(targetDay.getTime() - ONEDAY);
		}

		return Notes.packMany(
			foundNotes
				.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
				.slice(ps.offset, ps.offset + ps.limit),
			user,
		);
	}

	const query = Notes.createQueryBuilder("note")
		.addSelect("note.score")
		.andWhere("note.score > 0")
		.andWhere("note.createdAt > :date", { date: new Date(Date.now() - day) })
		.andWhere("note.visibility = 'public'");

	switch (ps.origin) {
		case "local":
			query.andWhere("note.userHost IS NULL");
			break;
		case "remote":
			query.andWhere("note.userHost IS NOT NULL");
			break;
	}

	if (user) generateMutedUserQuery(query, user);
	if (user) generateBlockedUserQuery(query, user);

	let notes = await query.orderBy("note.score", "DESC").take(max).getMany();

	notes.sort(
		(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
	);

	notes = notes.slice(ps.offset, ps.offset + ps.limit);

	return await Notes.packMany(notes, user);
});
