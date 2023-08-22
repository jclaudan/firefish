import define from "../../define.js";
import { fetchMeta } from "@/misc/fetch-meta.js";
import { Notes } from "@/models/index.js";
import type { Note } from "@/models/entities/note.js";
import { safeForSql } from "@/misc/safe-for-sql.js";
import { normalizeForSearch } from "@/misc/normalize-for-search.js";
import { redisClient } from "@/db/redis.js";
import { scyllaClient } from "@/db/scylla.js";

/*
トレンドに載るためには「『直近a分間のユニーク投稿数が今からa分前～今からb分前の間のユニーク投稿数のn倍以上』のハッシュタグの上位5位以内に入る」ことが必要
ユニーク投稿数とはそのハッシュタグと投稿ユーザーのペアのカウントで、例えば同じユーザーが複数回同じハッシュタグを投稿してもそのハッシュタグのユニーク投稿数は1とカウントされる

..が理想だけどPostgreSQLでどうするのか分からないので単に「直近Aの内に投稿されたユニーク投稿数が多いハッシュタグ」で妥協する
*/

const rangeA = 1000 * 60 * 60; // 60分
//const rangeB = 1000 * 60 * 120; // 2時間
//const coefficient = 1.25; // 「n倍」の部分
//const requiredUsers = 3; // 最低何人がそのタグを投稿している必要があるか

const max = 5;

export const meta = {
	tags: ["hashtags"],

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
			properties: {
				tag: {
					type: "string",
					optional: false,
					nullable: false,
				},
				chart: {
					type: "array",
					optional: false,
					nullable: false,
					items: {
						type: "number",
						optional: false,
						nullable: false,
					},
				},
				usersCount: {
					type: "number",
					optional: false,
					nullable: false,
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: "object",
	properties: {},
	required: [],
} as const;

export default define(meta, paramDef, async () => {
	const instance = await fetchMeta(true);
	const hiddenTags = instance.hiddenTags.map((t) => normalizeForSearch(t));

	const now = new Date();
	now.setMinutes(Math.round(now.getMinutes() / 5) * 5, 0, 0); // Rounding to the nearest 5 minutes

	const tagNotes = await redisClient.xrange("trendtag", "-", "+");

	if (tagNotes.length === 0) {
		return [];
	}

	const tags: {
		name: string;
		users: Note["userId"][];
	}[] = [];

	for (const [_, fields] of tagNotes) {
		const name = fields[1];
		const userId = fields[3];
		if (hiddenTags.includes(name)) continue;

		const index = tags.findIndex((tag) => tag.name === name);
		if (index >= 0 && !tags[index].users.includes(userId)) {
			tags[index].users.push(userId);
		} else if (index < 0) {
			tags.push({ name, users: [userId] });
		}
	}

	// Sort tags by their popularity
	const hots = tags
		.sort((a, b) => b.users.length - a.users.length)
		.map((tag) => tag.name)
		.slice(0, max);

	if (scyllaClient) {
		const stats = hots.map((tag, i) => ({
			tag,
			chart: [], // FIXME: generate chart
			usersCount: tags[i].users.length,
		}));

		return stats;
	}

	//#region Prepare charts of the number of posts having tags in hots
	const countPromises: Promise<number[]>[] = [];

	const range = 20;
	const interval = 1000 * 60 * 10;

	for (let i = 0; i < range; i++) {
		countPromises.push(
			Promise.all(
				hots.map((tag) =>
					Notes.createQueryBuilder("note")
						.select("count(distinct note.userId)")
						.where(
							`'{"${safeForSql(tag) ? tag : "aichan_kawaii"}"}' <@ note.tags`,
						)
						.andWhere("note.createdAt < :lt", {
							lt: new Date(now.getTime() - interval * i),
						})
						.andWhere("note.createdAt > :gt", {
							gt: new Date(now.getTime() - interval * (i + 1)),
						})
						.cache(60000) // 1 min
						.getRawOne()
						.then((x) => parseInt(x.count, 10)),
				),
			),
		);
	}

	const countsLog = await Promise.all(countPromises);
	//#endregion

	const totalCounts = await Promise.all(
		hots.map((tag) =>
			Notes.createQueryBuilder("note")
				.select("count(distinct note.userId)")
				.where(`'{"${safeForSql(tag) ? tag : "aichan_kawaii"}"}' <@ note.tags`)
				.andWhere("note.createdAt > :gt", {
					gt: new Date(now.getTime() - rangeA),
				})
				.cache(60000 * 60) // 60 min
				.getRawOne()
				.then((x) => parseInt(x.count, 10)),
		),
	);

	const stats = hots.map((tag, i) => ({
		tag,
		chart: countsLog.map((counts) => counts[i]),
		usersCount: totalCounts[i],
	}));

	return stats;
});
