import type Bull from "bull";
import { queueLogger } from "../../logger.js";
import {
	ChannelNotePinings,
	ClipNotes,
	DriveFiles,
	MutedNotes,
	NoteFavorites,
	NoteUnreads,
	NoteWatchings,
	Notes,
	PromoNotes,
	PromoReads,
	UserNotePinings,
	UserProfiles,
	Users,
} from "@/models/index.js";
import type { DbUserDeleteJobData } from "@/queue/types.js";
import type { Note } from "@/models/entities/note.js";
import type { DriveFile } from "@/models/entities/drive-file.js";
import { MoreThan } from "typeorm";
import { deleteFileSync } from "@/services/drive/delete-file.js";
import { sendEmail } from "@/services/send-email.js";
import meilisearch from "@/db/meilisearch.js";
import { userByIdCache, userDenormalizedCache } from "@/services/user-cache.js";
import {
	parseHomeTimeline,
	parseScyllaNote,
	prepared,
	scyllaClient,
} from "@/db/scylla.js";
import type { Client } from "cassandra-driver";

const logger = queueLogger.createSubLogger("delete-account");

export async function deleteAccount(
	job: Bull.Job<DbUserDeleteJobData>,
): Promise<string | void> {
	logger.info(`Deleting account of ${job.data.user.id} ...`);

	const user = await Users.findOneBy({ id: job.data.user.id });
	if (!user) return;

	{
		// Delete notes
		let cursor: Note["id"] | null = null;

		if (scyllaClient) {
			scyllaClient.eachRow(
				prepared.note.select.byUserId,
				[user.id],
				{ prepare: true },
				(_, row) => {
					const client = scyllaClient as Client;
					const note = parseScyllaNote(row);
					const noteDeleteParams = [
						note.createdAt,
						note.createdAt,
						note.userId,
						note.userHost ?? "local",
						note.visibility,
					] as [Date, Date, string, string, string];
					client.execute(prepared.note.delete, noteDeleteParams, {
						prepare: true,
					});
					client.eachRow(
						prepared.homeTimeline.select.byId,
						[note.id],
						{
							prepare: true,
						},
						(_, row) => {
							const timeline = parseHomeTimeline(row);
							client.execute(
								prepared.homeTimeline.delete,
								[
									timeline.feedUserId,
									timeline.createdAtDate,
									timeline.createdAt,
									timeline.userId,
								],
								{ prepare: true },
							);
						},
					);
					if (meilisearch) {
						meilisearch.deleteNotes([note]);
					}
					ChannelNotePinings.delete({
						noteId: note.id,
					});
					ClipNotes.delete({
						noteId: note.id,
					});
					MutedNotes.delete({
						noteId: note.id,
					});
					NoteFavorites.delete({
						noteId: note.id,
					});
					NoteUnreads.delete({
						noteId: note.id,
					});
					NoteWatchings.delete({
						noteId: note.id,
					});
					PromoNotes.delete({
						noteId: note.id,
					});
					PromoReads.delete({
						noteId: note.id,
					});
					UserNotePinings.delete({
						noteId: note.id,
					});
				},
			);
		} else {
			while (true) {
				const notes = (await Notes.find({
					where: {
						userId: user.id,
						...(cursor ? { id: MoreThan(cursor) } : {}),
					},
					take: 10,
					order: {
						id: 1,
					},
				})) as Note[];

				if (notes.length === 0) {
					break;
				}

				cursor = notes[notes.length - 1].id;

				await Notes.delete(notes.map((note) => note.id));
				if (meilisearch) {
					await meilisearch.deleteNotes(notes);
				}
			}
		}
		logger.succ("All of notes deleted");
	}

	{
		// Delete files
		let cursor: DriveFile["id"] | null = null;

		while (true) {
			const files = (await DriveFiles.find({
				where: {
					userId: user.id,
					...(cursor ? { id: MoreThan(cursor) } : {}),
				},
				take: 10,
				order: {
					id: 1,
				},
			})) as DriveFile[];

			if (files.length === 0) {
				break;
			}

			cursor = files[files.length - 1].id;

			for (const file of files) {
				await deleteFileSync(file);
			}
		}

		logger.succ("All of files deleted");
	}

	{
		// Send email notification
		const profile = await UserProfiles.findOneByOrFail({ userId: user.id });
		if (profile.email && profile.emailVerified) {
			sendEmail(
				profile.email,
				"Account deleted",
				"Your account has been deleted.",
				"Your account has been deleted.",
			);
		}
	}

	// soft指定されている場合は物理削除しない
	if (job.data.soft) {
		// nop
	} else {
		await Users.delete(job.data.user.id);
		await userDenormalizedCache.delete(job.data.user.id);
		await userByIdCache.delete(job.data.user.id);
	}

	return "Account deleted";
}
