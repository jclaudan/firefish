import { In } from "typeorm";
import { Notification } from "@/models/entities/notification.js";
import { awaitAll } from "@/prelude/await-all.js";
import type { Packed } from "@/misc/schema.js";
import type { Note } from "@/models/entities/note.js";
import type { NoteReaction } from "@/models/entities/note-reaction.js";
import type { User } from "@/models/entities/user.js";
import { aggregateNoteEmojis, prefetchEmojis } from "@/misc/populate-emojis.js";
import { db } from "@/db/postgre.js";
import {
	Users,
	Notes,
	UserGroupInvitations,
	AccessTokens,
	NoteReactions,
} from "../index.js";
import {
	parseScyllaNote,
	parseScyllaNotification,
	parseScyllaReaction,
	prepared,
	scyllaClient,
	type ScyllaNotification,
} from "@/db/scylla.js";

export const NotificationRepository = db.getRepository(Notification).extend({
	async pack(
		src: Notification["id"] | Notification | ScyllaNotification,
		options: {
			_hintForEachNotes_?: {
				myReactions: Map<Note["id"], NoteReaction | null>;
			};
		},
	): Promise<Packed<"Notification">> {
		if (scyllaClient) {
			let notification: ScyllaNotification;
			if (typeof src === "object") {
				notification = src as ScyllaNotification;
			} else {
				const result = await scyllaClient.execute(
					prepared.notification.select.byId,
					[src],
					{ prepare: true },
				);
				if (result.rowLength === 0) {
					throw new Error("notification not found");
				}
				notification = parseScyllaNotification(result.first());
			}
			const token =
				notification.type === "app" && notification.entityId
					? await AccessTokens.findOneByOrFail({
							id: notification.entityId,
					  })
					: null;

			let data = null;

			if (notification.entityId) {
				switch (notification.type) {
					case "mention":
					case "reply":
					case "renote":
					case "quote":
					case "reaction":
					case "pollVote":
					case "pollEnded":
						data = {
							note: Notes.pack(
								notification.entityId,
								{ id: notification.targetId },
								{ detail: true, _hint_: options._hintForEachNotes_ },
							),
							reaction: notification.reaction,
							choice: notification.choice,
						};
						break;
					case "groupInvited":
						data = {
							invitation: UserGroupInvitations.pack(notification.entityId),
						};
						break;
					case "app":
						data = {
							body: notification.customBody,
							header: notification.customHeader || token?.name,
							icon: notification.customIcon || token?.iconUrl,
						};
						break;
				}
			}

			return await awaitAll({
				id: notification.id,
				createdAt: notification.createdAt.toISOString(),
				type: notification.type,
				isRead: true, // FIXME: Implement read checker on DragonflyDB
				userId: notification.notifierId,
				user: notification.notifierId
					? Users.pack(notification.notifierId)
					: null,
				...data,
			});
		}

		const notification =
			typeof src === "object"
				? (src as Notification)
				: await this.findOneByOrFail({ id: src });
		const token = notification.appAccessTokenId
			? await AccessTokens.findOneByOrFail({
					id: notification.appAccessTokenId,
			  })
			: null;

		return await awaitAll({
			id: notification.id,
			createdAt: notification.createdAt.toISOString(),
			type: notification.type,
			isRead: notification.isRead,
			userId: notification.notifierId,
			user: notification.notifierId
				? Users.pack(notification.notifier || notification.notifierId)
				: null,
			...(notification.type === "mention"
				? {
						note: Notes.pack(
							notification.note || notification.noteId!,
							{ id: notification.notifieeId },
							{
								detail: true,
								_hint_: options._hintForEachNotes_,
							},
						),
				  }
				: {}),
			...(notification.type === "reply"
				? {
						note: Notes.pack(
							notification.note || notification.noteId!,
							{ id: notification.notifieeId },
							{
								detail: true,
								_hint_: options._hintForEachNotes_,
							},
						),
				  }
				: {}),
			...(notification.type === "renote"
				? {
						note: Notes.pack(
							notification.note || notification.noteId!,
							{ id: notification.notifieeId },
							{
								detail: true,
								_hint_: options._hintForEachNotes_,
							},
						),
				  }
				: {}),
			...(notification.type === "quote"
				? {
						note: Notes.pack(
							notification.note || notification.noteId!,
							{ id: notification.notifieeId },
							{
								detail: true,
								_hint_: options._hintForEachNotes_,
							},
						),
				  }
				: {}),
			...(notification.type === "reaction"
				? {
						note: Notes.pack(
							notification.note || notification.noteId!,
							{ id: notification.notifieeId },
							{
								detail: true,
								_hint_: options._hintForEachNotes_,
							},
						),
						reaction: notification.reaction,
				  }
				: {}),
			...(notification.type === "pollVote"
				? {
						note: Notes.pack(
							notification.note || notification.noteId!,
							{ id: notification.notifieeId },
							{
								detail: true,
								_hint_: options._hintForEachNotes_,
							},
						),
						choice: notification.choice,
				  }
				: {}),
			...(notification.type === "pollEnded"
				? {
						note: Notes.pack(
							notification.note || notification.noteId!,
							{ id: notification.notifieeId },
							{
								detail: true,
								_hint_: options._hintForEachNotes_,
							},
						),
				  }
				: {}),
			...(notification.type === "groupInvited"
				? {
						invitation: UserGroupInvitations.pack(
							notification.userGroupInvitationId!,
						),
				  }
				: {}),
			...(notification.type === "app"
				? {
						body: notification.customBody,
						header: notification.customHeader || token?.name,
						icon: notification.customIcon || token?.iconUrl,
				  }
				: {}),
		});
	},

	async packMany(
		notifications: Notification[] | ScyllaNotification[],
		meId: User["id"],
	) {
		if (notifications.length === 0) return [];

		let notes: Note[] = [];
		let noteIds: Note["id"][] = [];
		let renoteIds: Note["id"][] = [];
		const myReactionsMap = new Map<Note["id"], NoteReaction | null>();

		if (scyllaClient) {
			noteIds = (notifications as ScyllaNotification[])
				.filter((n) => !["groupInvited", "app"].includes(n.type) && n.entityId)
				.map(({ entityId }) => entityId as string);
			notes = await scyllaClient
				.execute(prepared.note.select.byIds, [noteIds], { prepare: true })
				.then((result) => result.rows.map(parseScyllaNote));
			renoteIds = notes
				.filter((note) => !!note.renoteId)
				.map(({ renoteId }) => renoteId as string);
		} else {
			const notes = (notifications as Notification[])
				.filter((x) => !!x.note)
				.map((x) => x.note as Note);
			noteIds = notes.map((n) => n.id);
			renoteIds = notes
				.filter((n) => !!n.renoteId)
				.map((n) => n.renoteId as string);
		}

		const targets = [...noteIds, ...renoteIds];
		let myReactions: NoteReaction[] = [];
		if (scyllaClient) {
			const result = await scyllaClient.execute(
				prepared.reaction.select.byNoteAndUser,
				[targets, [meId]],
				{ prepare: true },
			);
			myReactions = result.rows.map(parseScyllaReaction);
		} else {
			myReactions = await NoteReactions.findBy({
				userId: meId,
				noteId: In(targets),
			});
		}

		for (const target of targets) {
			myReactionsMap.set(
				target,
				myReactions.find((reaction) => reaction.noteId === target) || null,
			);
		}

		await prefetchEmojis(aggregateNoteEmojis(notes));

		const results = await Promise.all(
			notifications.map((x) =>
				this.pack(x, {
					_hintForEachNotes_: {
						myReactions: myReactionsMap,
					},
				}).catch((_) => null),
			),
		);
		return results.filter((x) => x != null);
	},
});
