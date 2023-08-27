import { Notes } from "@/models/index.js";
import type { CacheableRemoteUser } from "@/models/entities/user.js";
import type { IAnnounce } from "../../type.js";
import { getApId } from "../../type.js";
import deleteNote from "@/services/note/delete.js";
import {
	type ScyllaNote,
	scyllaClient,
	prepared,
	parseScyllaNote,
} from "@/db/scylla.js";
import type { Note } from "@/models/entities/note.js";

export const undoAnnounce = async (
	actor: CacheableRemoteUser,
	activity: IAnnounce,
): Promise<string> => {
	const uri = getApId(activity);

	let note: Note | ScyllaNote | null = null;

	if (scyllaClient) {
		const result = await scyllaClient.execute(
			prepared.note.select.byUri,
			[uri],
			{ prepare: true },
		);
		if (result.rowLength > 0) {
			const candidate = parseScyllaNote(result.first());
			if (candidate.userId === actor.id) {
				note = candidate;
			}
		}
	} else {
		note = await Notes.findOneBy({
			uri,
			userId: actor.id,
		});
	}

	if (!note) return "skip: no such Announce";

	await deleteNote(actor, note);
	return "ok: deleted";
};
