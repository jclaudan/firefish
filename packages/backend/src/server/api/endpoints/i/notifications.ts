import { Brackets } from "typeorm";
import {
	Notifications,
	Followings,
	Mutings,
	Users,
	UserProfiles,
} from "@/models/index.js";
import { notificationTypes } from "@/types.js";
import read from "@/services/note/read.js";
import { readNotification } from "../../common/read-notification.js";
import define from "../../define.js";
import { makePaginationQuery } from "../../common/make-pagination-query.js";
import {
	ScyllaNotification,
	execPaginationQuery,
	parseScyllaNote,
	prepared,
	scyllaClient,
} from "@/db/scylla.js";
import {
	InstanceMutingsCache,
	LocalFollowingsCache,
	UserBlockedCache,
	UserBlockingCache,
	UserMutingsCache,
} from "@/misc/cache.js";
import type { Client } from "cassandra-driver";

export const meta = {
	tags: ["account", "notifications"],

	requireCredential: true,

	kind: "read:notifications",

	res: {
		type: "array",
		optional: false,
		nullable: false,
		items: {
			type: "object",
			optional: false,
			nullable: false,
			ref: "Notification",
		},
	},
} as const;

export const paramDef = {
	type: "object",
	properties: {
		limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: "string", format: "misskey:id" },
		untilId: { type: "string", format: "misskey:id" },
		following: { type: "boolean", default: false },
		unreadOnly: { type: "boolean", default: false },
		directOnly: { type: "boolean", default: false },
		markAsRead: { type: "boolean", default: true },
		includeTypes: {
			type: "array",
			items: {
				type: "string",
				enum: notificationTypes,
			},
		},
		excludeTypes: {
			type: "array",
			items: {
				type: "string",
				enum: notificationTypes,
			},
		},
	},
	required: [],
} as const;

export default define(meta, paramDef, async (ps, user) => {
	// includeTypes が空の場合はクエリしない
	// excludeTypes に全指定されている場合はクエリしない
	if (
		(ps.includeTypes && ps.includeTypes.length === 0) ||
		notificationTypes.every((type) => ps.excludeTypes?.includes(type))
	) {
		return await Notifications.packMany([], user.id);
	}

	if (scyllaClient) {
		const client = scyllaClient as Client;
		const [
			followingUserIds,
			mutedUserIds,
			mutedInstances,
			blockerIds,
			blockingIds,
		] = await Promise.all([
			LocalFollowingsCache.init(user.id).then((cache) => cache.getAll()),
			UserMutingsCache.init(user.id).then((cache) => cache.getAll()),
			InstanceMutingsCache.init(user.id).then((cache) => cache.getAll()),
			UserBlockedCache.init(user.id).then((cache) => cache.getAll()),
			UserBlockingCache.init(user.id).then((cache) => cache.getAll()),
		]);
		const validUserIds = [user.id, ...followingUserIds];

		const filter = async (notifications: ScyllaNotification[]) => {
			let filtered = notifications;
			if (ps.unreadOnly) {
				// FIXME: isRead is always true at the moment
				filtered = [];
			}
			if (ps.following) {
				filtered = filtered.filter(
					(n) => n.notifierId && validUserIds.includes(n.notifierId),
				);
			}
			if (ps.includeTypes && ps.includeTypes.length > 0) {
				filtered = filtered.filter((n) => ps.includeTypes?.includes(n.type));
			} else if (ps.excludeTypes && ps.excludeTypes.length > 0) {
				filtered = filtered.filter(
					(n) => ps.excludeTypes && !ps.excludeTypes.includes(n.type),
				);
			}
			filtered = filtered.filter(
				(n) => !(n.notifierHost && mutedInstances.includes(n.notifierHost)),
			);
			filtered = filtered.filter(
				(n) =>
					!(
						n.notifierId &&
						(mutedUserIds.includes(n.notifierId) ||
							blockingIds.includes(n.notifierId) ||
							blockerIds.includes(n.notifierId))
					),
			);
			if (
				ps.directOnly &&
				ps.includeTypes?.every((t) => ["mention", "reply"].includes(t))
			) {
				filtered = filtered.filter(({ entityId }) => !!entityId);
				let notes = await client
					.execute(
						prepared.note.select.byIds,
						[filtered.map(({ entityId }) => entityId as string)],
						{ prepare: true },
					)
					.then((result) => result.rows.map(parseScyllaNote));
				notes = notes.filter((n) => n.visibility === "specified");
				const validNoteIds = notes.map(({ id }) => id);
				filtered = filtered.filter(
					({ entityId }) => entityId && validNoteIds.includes(entityId),
				);
			}

			return filtered;
		};

		const foundNotifications = (
			(await execPaginationQuery(
				"notification",
				ps,
				{ notification: filter },
				user.id,
				30,
			)) as ScyllaNotification[]
		).slice(0, ps.limit);
		return await Notifications.packMany(foundNotifications, user.id);
	}

	const followingQuery = Followings.createQueryBuilder("following")
		.select("following.followeeId")
		.where("following.followerId = :followerId", { followerId: user.id });

	const mutingQuery = Mutings.createQueryBuilder("muting")
		.select("muting.muteeId")
		.where("muting.muterId = :muterId", { muterId: user.id });

	const mutingInstanceQuery = UserProfiles.createQueryBuilder("user_profile")
		.select("user_profile.mutedInstances")
		.where("user_profile.userId = :muterId", { muterId: user.id });

	const suspendedQuery = Users.createQueryBuilder("users")
		.select("users.id")
		.where("users.isSuspended = TRUE");

	const query = makePaginationQuery(
		Notifications.createQueryBuilder("notification"),
		ps.sinceId,
		ps.untilId,
	)
		.andWhere("notification.notifieeId = :meId", { meId: user.id })
		.leftJoinAndSelect("notification.notifier", "notifier")
		.leftJoinAndSelect("notification.note", "note")
		.leftJoinAndSelect("note.reply", "reply")
		.leftJoinAndSelect("note.renote", "renote");

	// muted users
	query.andWhere(
		new Brackets((qb) => {
			qb.where(
				`notification.notifierId NOT IN (${mutingQuery.getQuery()})`,
			).orWhere("notification.notifierId IS NULL");
		}),
	);
	query.setParameters(mutingQuery.getParameters());

	// muted instances
	query.andWhere(
		new Brackets((qb) => {
			qb.andWhere("notifier.host IS NULL").orWhere(
				`NOT (( ${mutingInstanceQuery.getQuery()} )::jsonb ? notifier.host)`,
			);
		}),
	);
	query.setParameters(mutingInstanceQuery.getParameters());

	// suspended users
	query.andWhere(
		new Brackets((qb) => {
			qb.where(
				`notification.notifierId NOT IN (${suspendedQuery.getQuery()})`,
			).orWhere("notification.notifierId IS NULL");
		}),
	);

	if (ps.following) {
		query.andWhere(
			`((notification.notifierId IN (${followingQuery.getQuery()})) OR (notification.notifierId = :meId))`,
			{ meId: user.id },
		);
		query.setParameters(followingQuery.getParameters());
	}

	if (ps.includeTypes && ps.includeTypes.length > 0) {
		query.andWhere("notification.type IN (:...includeTypes)", {
			includeTypes: ps.includeTypes,
		});
	} else if (ps.excludeTypes && ps.excludeTypes.length > 0) {
		query.andWhere("notification.type NOT IN (:...excludeTypes)", {
			excludeTypes: ps.excludeTypes,
		});
	}

	if (ps.directOnly) {
		query.andWhere("note.visibility = 'specified'");
	}

	if (ps.unreadOnly) {
		query.andWhere("notification.isRead = false");
	}

	const notifications = await query.take(ps.limit).getMany();

	// Mark all as read
	if (notifications.length > 0 && ps.markAsRead) {
		readNotification(
			user.id,
			notifications.map((x) => x.id),
		);
	}

	const notes = notifications
		.filter((notification) =>
			["mention", "reply", "quote"].includes(notification.type),
		)
		.map((notification) => notification.note!);

	if (notes.length > 0) {
		read(user.id, notes);
	}

	return await Notifications.packMany(notifications, user.id);
});
