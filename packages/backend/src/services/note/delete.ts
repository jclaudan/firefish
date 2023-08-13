import { Brackets, In } from "typeorm";
import { publishNoteStream } from "@/services/stream.js";
import renderDelete from "@/remote/activitypub/renderer/delete.js";
import renderAnnounce from "@/remote/activitypub/renderer/announce.js";
import renderUndo from "@/remote/activitypub/renderer/undo.js";
import { renderActivity } from "@/remote/activitypub/renderer/index.js";
import renderTombstone from "@/remote/activitypub/renderer/tombstone.js";
import config from "@/config/index.js";
import type { User, ILocalUser, IRemoteUser } from "@/models/entities/user.js";
import type { Note, IMentionedRemoteUsers } from "@/models/entities/note.js";
import { Notes, Users, Instances } from "@/models/index.js";
import {
	notesChart,
	perUserNotesChart,
	instanceChart,
} from "@/services/chart/index.js";
import {
	deliverToFollowers,
	deliverToUser,
} from "@/remote/activitypub/deliver-manager.js";
import { countSameRenotes } from "@/misc/count-same-renotes.js";
import { registerOrFetchInstanceDoc } from "../register-or-fetch-instance-doc.js";
import { deliverToRelays } from "../relay.js";
import meilisearch from "@/db/meilisearch.js";
import {
	parseHomeTimeline,
	parseScyllaNote,
	prepared,
	scyllaClient,
} from "@/db/scylla.js";

/**
 * Delete a post
 * @param user Poster
 * @param note Post
 */
export default async function (
	user: { id: User["id"]; uri: User["uri"]; host: User["host"] },
	note: Note,
	quiet = false,
) {
	const deletedAt = new Date();

	// If no other boosts exists except this (potentially boost) post
	if (
		note.renoteId &&
		(await countSameRenotes(user.id, note.renoteId, note.id)) === 0
	) {
		if (scyllaClient) {
			const result = await scyllaClient.execute(
				prepared.note.select.byId,
				[note.renoteId],
				{ prepare: true },
			);
			if (result.rowLength > 0) {
				const renote = parseScyllaNote(result.first());
				const count = isNaN(renote.renoteCount) ? 0 : renote.renoteCount;
				const score = isNaN(renote.score) ? 0 : renote.score;
				await scyllaClient.execute(
					prepared.note.update.renoteCount,
					[
						Math.max(count - 1, 0),
						Math.max(score - 1, 0),
						renote.createdAt,
						renote.createdAt,
						renote.userId,
						renote.userHost ?? "local",
						renote.visibility,
					],
					{ prepare: true },
				);
				const homeTimelines = await scyllaClient
					.execute(prepared.homeTimeline.select.byId, [renote.id], {
						prepare: true,
					})
					.then((result) => result.rows.map(parseHomeTimeline));
				// Do not issue BATCH because different home timelines involve different partitions
				for (const timeline of homeTimelines) {
					scyllaClient.execute(
						prepared.homeTimeline.update.renoteCount,
						[
							Math.max(count - 1, 0),
							Math.max(score - 1, 0),
							timeline.feedUserId,
							timeline.createdAtDate,
							timeline.createdAt,
							timeline.userId,
						],
						{ prepare: true },
					);
				}
			}
		} else {
			Notes.decrement({ id: note.renoteId }, "renoteCount", 1);
			Notes.decrement({ id: note.renoteId }, "score", 1);
		}
	}

	if (note.replyId) {
		if (scyllaClient) {
			const result = await scyllaClient.execute(
				prepared.note.select.byId,
				[note.replyId],
				{ prepare: true },
			);
			if (result.rowLength > 0) {
				const reply = parseScyllaNote(result.first());
				const count = isNaN(reply.repliesCount) ? 0 : reply.repliesCount;
				await scyllaClient.execute(
					prepared.note.update.repliesCount,
					[
						Math.max(count - 1, 0),
						reply.createdAt,
						reply.createdAt,
						reply.userId,
						reply.userHost ?? "local",
						reply.visibility,
					],
					{ prepare: true },
				);
				const homeTimelines = await scyllaClient
					.execute(prepared.homeTimeline.select.byId, [reply.id], {
						prepare: true,
					})
					.then((result) => result.rows.map(parseHomeTimeline));
				// Do not issue BATCH because different home timelines involve different partitions
				for (const timeline of homeTimelines) {
					scyllaClient.execute(
						prepared.homeTimeline.update.repliesCount,
						[
							Math.max(count - 1, 0),
							timeline.feedUserId,
							timeline.createdAtDate,
							timeline.createdAt,
							timeline.userId,
						],
						{ prepare: true },
					);
				}
			}
		} else {
			await Notes.decrement({ id: note.replyId }, "repliesCount", 1);
		}
	}

	if (!quiet) {
		publishNoteStream(note.id, "deleted", {
			deletedAt: deletedAt,
		});

		//#region Deliver Delete activity if it's from a local account
		if (Users.isLocalUser(user) && !note.localOnly) {
			let renote: Note | null = null;

			// if deletd note is renote
			if (
				note.renoteId &&
				note.text == null &&
				!note.hasPoll &&
				(note.fileIds == null || note.fileIds.length === 0)
			) {
				if (scyllaClient) {
					const result = await scyllaClient.execute(
						prepared.note.select.byId,
						[note.renoteId],
						{ prepare: true },
					);
					if (result.rowLength > 0) renote = parseScyllaNote(result.first());
				} else {
					renote = await Notes.findOneBy({
						id: note.renoteId,
					});
				}
			}

			const content = renderActivity(
				renote
					? renderUndo(
							renderAnnounce(
								renote.uri || `${config.url}/notes/${renote.id}`,
								note,
							),
							user,
					  )
					: renderDelete(
							renderTombstone(`${config.url}/notes/${note.id}`),
							user,
					  ),
			);

			deliverToConcerned(user, note, content);
		}

		// also deliever delete activity to cascaded notes
		const cascadingNotes = (await findCascadingNotes(note)).filter(
			(note) => !note.localOnly,
		); // filter out local-only notes
		for (const cascadingNote of cascadingNotes) {
			if (!cascadingNote.user) continue;
			if (!Users.isLocalUser(cascadingNote.user)) continue;
			const content = renderActivity(
				renderDelete(
					renderTombstone(`${config.url}/notes/${cascadingNote.id}`),
					cascadingNote.user,
				),
			);
			deliverToConcerned(cascadingNote.user, cascadingNote, content);
		}
		//#endregion

		// 統計を更新
		notesChart.update(note, false);
		perUserNotesChart.update(user, note, false);

		if (Users.isRemoteUser(user)) {
			registerOrFetchInstanceDoc(user.host).then((i) => {
				Instances.decrement({ id: i.id }, "notesCount", 1);
				instanceChart.updateNote(i.host, note, false);
			});
		}
	}

	if (scyllaClient) {
		const date = new Date(note.createdAt.getTime());
		await scyllaClient.execute(
			prepared.note.delete,
			[date, date, note.userId, note.userHost ?? "local", note.visibility],
			{
				prepare: true,
			},
		);

		const homeTimelines = await scyllaClient
			.execute(prepared.homeTimeline.select.byId, [note.id], { prepare: true })
			.then((result) => result.rows.map(parseHomeTimeline));
		for (const timeline of homeTimelines) {
			// No need to wait
			scyllaClient.execute(prepared.homeTimeline.delete, [
				timeline.feedUserId,
				timeline.createdAtDate,
				timeline.createdAt,
				timeline.userId,
			]);
		}
	}

	await Notes.delete({
		id: note.id,
		userId: user.id,
	});

	if (meilisearch) {
		await meilisearch.deleteNotes(note.id);
	}
}

async function findCascadingNotes(note: Note) {
	const cascadingNotes: Note[] = [];

	const recursive = async (noteId: string) => {
		let notes: Note[] = [];

		if (scyllaClient) {
			const replies = await scyllaClient.execute(
				prepared.note.select.byReplyId,
				[noteId],
				{ prepare: true },
			);
			if (replies.rowLength > 0) {
				notes.push(...replies.rows.map(parseScyllaNote));
			}
			const renotes = await scyllaClient.execute(
				prepared.note.select.byRenoteId,
				[noteId],
				{ prepare: true },
			);
			if (renotes.rowLength > 0) {
				notes.push(
					...renotes.rows.map(parseScyllaNote).filter((note) => !!note.text),
				);
			}
		} else {
			const query = Notes.createQueryBuilder("note")
				.where("note.replyId = :noteId", { noteId })
				.orWhere(
					new Brackets((q) => {
						q.where("note.renoteId = :noteId", { noteId }).andWhere(
							"note.text IS NOT NULL",
						);
					}),
				)
				.leftJoinAndSelect("note.user", "user");
			notes = await query.getMany();
		}

		for (const reply of notes) {
			cascadingNotes.push(reply);
			await recursive(reply.id);
		}
	};
	await recursive(note.id);

	return cascadingNotes.filter((note) => note.userHost === null); // filter out non-local users
}

async function getMentionedRemoteUsers(note: Note) {
	const where = [] as any[];

	// mention / reply / dm
	const uris = (
		JSON.parse(note.mentionedRemoteUsers) as IMentionedRemoteUsers
	).map((x) => x.uri);
	if (uris.length > 0) {
		where.push({ uri: In(uris) });
	}

	// renote / quote
	if (note.renoteUserId) {
		where.push({
			id: note.renoteUserId,
		});
	}

	if (where.length === 0) return [];

	return (await Users.find({
		where,
	})) as IRemoteUser[];
}

async function deliverToConcerned(
	user: { id: ILocalUser["id"]; host: null },
	note: Note,
	content: any,
) {
	deliverToFollowers(user, content);
	deliverToRelays(user, content);
	const remoteUsers = await getMentionedRemoteUsers(note);
	for (const remoteUser of remoteUsers) {
		deliverToUser(user, content, remoteUser);
	}
}
