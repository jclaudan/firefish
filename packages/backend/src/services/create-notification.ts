import { publishMainStream } from "@/services/stream.js";
import { pushNotification } from "@/services/push-notification.js";
import {
	Notifications,
	NoteThreadMutings,
	UserProfiles,
	Users,
	Followings,
} from "@/models/index.js";
import { genId } from "@/misc/gen-id.js";
import type { User } from "@/models/entities/user.js";
import type { Notification } from "@/models/entities/notification.js";
import { sendEmailNotification } from "./send-email-notification.js";
import { shouldSilenceInstance } from "@/misc/should-block-instance.js";
import { LocalFollowingsCache, UserMutingsCache } from "@/misc/cache.js";
import { userByIdCache } from "./user-cache.js";
import {
	type ScyllaNotification,
	prepared,
	scyllaClient,
} from "@/db/scylla.js";

export async function createNotification(
	notifieeId: User["id"],
	type: Notification["type"],
	data: Partial<Notification>,
) {
	if (data.notifierId && notifieeId === data.notifierId) {
		return null;
	}

	let notifierHost: string | null = null;

	if (
		data.notifierId &&
		["mention", "reply", "renote", "quote", "reaction"].includes(type)
	) {
		const notifier = await userByIdCache.fetchMaybe(data.notifierId, () =>
			Users.findOneBy({ id: data.notifierId ?? "" }).then(
				(user) => user ?? undefined,
			),
		);
		// suppress if the notifier does not exist or is silenced.
		if (!notifier) return null;

		notifierHost = notifier.host;

		// suppress if the notifier is silenced, suspended, or in a silenced instance, and not followed by the notifiee.
		if (
			(notifier.isSilenced ||
				notifier.isSuspended ||
				(Users.isRemoteUser(notifier) &&
					(await shouldSilenceInstance(notifier.host)))) &&
			!(await LocalFollowingsCache.init(notifieeId).then((cache) =>
				cache.has(notifier.id),
			))
		)
			return null;
	}

	const profile = await UserProfiles.findOneBy({ userId: notifieeId });

	const isMuted = profile?.mutingNotificationTypes.includes(type);

	if (data.note) {
		const threadMute = await NoteThreadMutings.exist({
			where: {
				userId: notifieeId,
				threadId: data.note.threadId || data.note.id,
			},
		});

		if (threadMute) {
			return null;
		}
	}

	// Create notification
	let notification: Notification | ScyllaNotification;
	if (scyllaClient) {
		const entityId =
			data.noteId ||
			data.followRequestId ||
			data.userGroupInvitationId ||
			data.appAccessTokenId ||
			null;
		const now = new Date();
		notification = {
			id: genId(),
			createdAtDate: now,
			createdAt: now,
			targetId: notifieeId,
			notifierId: data.notifierId ?? null,
			notifierHost,
			entityId,
			type,
			choice: data.choice ?? null,
			customBody: data.customBody ?? null,
			customHeader: data.customHeader ?? null,
			customIcon: data.customIcon ?? null,
			reaction: data.reaction ?? null,
		};
		await scyllaClient.execute(
			prepared.notification.insert,
			[
				notification.targetId,
				notification.createdAtDate,
				notification.createdAt,
				notification.id,
				notification.notifierId,
				notification.notifierHost,
				notification.type,
				notification.entityId,
				notification.reaction,
				notification.choice,
				notification.customBody,
				notification.customHeader,
				notification.customIcon,
			],
			{ prepare: true },
		);
	} else {
		notification = await Notifications.insert({
			id: genId(),
			createdAt: new Date(),
			notifieeId: notifieeId,
			type: type,
			// Make this notification read if muted
			isRead: isMuted,
			...data,
		} as Partial<Notification>).then((x) =>
			Notifications.findOneByOrFail(x.identifiers[0]),
		);
	}

	const packed = await Notifications.pack(notification, {});

	// Publish notification event
	publishMainStream(notifieeId, "notification", packed);

	// Fire "new notification" event if not yet read after two seconds
	setTimeout(async () => {
		const fresh = await Notifications.findOneBy({ id: notification.id });
		if (!fresh) return;
		// We execute this before, because the server side "read" check doesnt work well with push notifications, the app and service worker will decide themself
		// when it is best to show push notifications
		pushNotification(notifieeId, "notification", packed);
		if (fresh.isRead) return;

		// Ignore if the issuer is muted.
		if (data.notifierId) {
			const cache = await UserMutingsCache.init(notifieeId);
			if (await cache.isMuting(data.notifierId)) {
				return;
			}
		}

		publishMainStream(notifieeId, "unreadNotification", packed);

		if (type === "follow" && data.notifierId)
			sendEmailNotification.follow(
				notifieeId,
				await userByIdCache.fetch(data.notifierId, () =>
					Users.findOneByOrFail({ id: data.notifierId }),
				),
			);
		if (type === "receiveFollowRequest" && data.notifierId)
			sendEmailNotification.receiveFollowRequest(
				notifieeId,
				await userByIdCache.fetch(data.notifierId, () =>
					Users.findOneByOrFail({ id: data.notifierId }),
				),
			);
	}, 2000);

	return notification;
}
