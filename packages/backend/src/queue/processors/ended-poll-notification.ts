import type Bull from "bull";
import { Notes, PollVotes } from "@/models/index.js";
import { queueLogger } from "../logger.js";
import type { EndedPollNotificationJobData } from "@/queue/types.js";
import { createNotification } from "@/services/create-notification.js";
import { deliverQuestionUpdate } from "@/services/note/polls/update.js";
import {
	parseScyllaNote,
	parseScyllaPollVote,
	prepared,
	scyllaClient,
	type ScyllaNote,
} from "@/db/scylla.js";
import type { Note } from "@/models/entities/note.js";

const logger = queueLogger.createSubLogger("ended-poll-notification");

export async function endedPollNotification(
	job: Bull.Job<EndedPollNotificationJobData>,
	done: any,
): Promise<void> {
	let note: Note | ScyllaNote | null = null;
	if (scyllaClient) {
		const result = await scyllaClient.execute(
			prepared.note.select.byId,
			[job.data.noteId],
			{ prepare: true },
		);
		if (result.rowLength > 0) {
			note = parseScyllaNote(result.first());
		}
	} else {
		note = await Notes.findOneBy({ id: job.data.noteId });
	}

	if (!note?.hasPoll) {
		done();
		return;
	}

	const userIds = [note.userId];

	if (scyllaClient) {
		const votes = await scyllaClient
			.execute(prepared.poll.select, [note.id], { prepare: true })
			.then((result) => result.rows.map(parseScyllaPollVote));
		const localVotes = votes.filter((vote) => !vote.userHost);
		userIds.push(...localVotes.map(({ userId }) => userId));
	} else {
		const votes = await PollVotes.createQueryBuilder("vote")
			.select("vote.userId")
			.where("vote.noteId = :noteId", { noteId: note.id })
			.innerJoinAndSelect("vote.user", "user")
			.andWhere("user.host IS NULL")
			.getMany();

		userIds.push(...votes.map((v) => v.userId));
	}

	for (const userId of new Set(userIds)) {
		createNotification(userId, "pollEnded", {
			noteId: note.id,
		});
	}

	// Broadcast the poll result once it ends
	if (!note.localOnly) await deliverQuestionUpdate(note.id);

	done();
}
