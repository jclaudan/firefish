import renderUpdate from "@/remote/activitypub/renderer/update.js";
import { renderActivity } from "@/remote/activitypub/renderer/index.js";
import renderNote from "@/remote/activitypub/renderer/note.js";
import { Users, Notes } from "@/models/index.js";
import type { Note } from "@/models/entities/note.js";
import { deliverToFollowers } from "@/remote/activitypub/deliver-manager.js";
import { deliverToRelays } from "../../relay.js";
import { parseScyllaNote, prepared, scyllaClient } from "@/db/scylla.js";
import { userByIdCache } from "@/services/user-cache.js";

export async function deliverQuestionUpdate(noteId: Note["id"]) {
	let note: Note | null = null;
	if (scyllaClient) {
		const result = await scyllaClient.execute(
			prepared.note.select.byId,
			[noteId],
			{ prepare: true },
		);
		if (result.rowLength > 0) {
			note = parseScyllaNote(result.first());
		}
	} else {
		note = await Notes.findOneBy({ id: noteId });
	}
	if (!note) throw new Error("note not found");

	const user = await userByIdCache.fetchMaybe(note.userId, () =>
		Users.findOneBy({ id: (note as Note).userId }).then(
			(user) => user ?? undefined,
		),
	);
	if (!user) throw new Error("note not found");

	if (Users.isLocalUser(user)) {
		const content = renderActivity(
			renderUpdate(await renderNote(note, false), user),
		);
		deliverToFollowers(user, content);
		deliverToRelays(user, content);
	}
}
