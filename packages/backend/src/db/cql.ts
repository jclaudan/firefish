export const scyllaQueries = {
	note: {
		insert: `INSERT INTO note (
				"createdAtDate",
				"createdAt",
				"id",
				"visibility",
				"content",
				"name",
				"cw",
				"localOnly",
				"renoteCount",
				"repliesCount",
				"uri",
				"url",
				"score",
				"files",
				"visibleUserIds",
				"mentions",
				"mentionedRemoteUsers",
				"emojis",
				"tags",
				"hasPoll",
				"threadId",
				"channelId",
				"userId",
				"userHost",
				"replyId",
				"replyUserId",
				"replyUserHost",
				"replyContent",
				"replyCw",
				"replyFiles",
				"renoteId",
				"renoteUserId",
				"renoteUserHost",
				"renoteContent",
				"renoteCw",
				"renoteFiles",
				"reactions",
				"noteEdit",
				"updatedAt"
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		select: {
			byDate: `SELECT * FROM note WHERE "createdAtDate" = ?`,
			byUri: `SELECT * FROM note WHERE "uri" = ?`,
			byUrl: `SELECT * FROM note WHERE "url" = ?`,
			byId: `SELECT * FROM note WHERE "id" = ?`,
			byUserId: `SELECT * FROM note_by_user_id WHERE "userId" IN ?`,
			byRenoteId: `SELECT * FROM note_by_renote_id WHERE "renoteId" = ?`,
			byReplyId: `SELECT * FROM note WHERE "replyId" = ?`
		},
		delete: `DELETE FROM note WHERE "createdAtDate" = ? AND "createdAt" = ? AND "userId" = ? AND "userHost" = ? AND "visibility" = ?`,
		update: {
			renoteCount: `UPDATE note SET
				"renoteCount" = ?,
				"score" = ?
				WHERE "createdAtDate" = ? AND "createdAt" = ? AND "userId" = ? AND "userHost" = ? AND "visibility" = ? IF EXISTS`,
			repliesCount: `UPDATE note SET
				"repliesCount" = ?
				WHERE "createdAtDate" = ? AND "createdAt" = ? AND "userId" = ? AND "userHost" = ? AND "visibility" = ? IF EXISTS`,
			reactions: `UPDATE note SET
				"emojis" = ?,
				"reactions" = ?,
				"score" = ?
				WHERE "createdAtDate" = ? AND "createdAt" = ? AND "userId" = ? AND "userHost" = ? AND "visibility" = ? IF EXISTS`,
		},
	},
	homeTimeline: {
		insert: `INSERT INTO home_timeline (
				"feedUserId",
				"createdAtDate",
				"createdAt",
				"id",
				"visibility",
				"content",
				"name",
				"cw",
				"localOnly",
				"renoteCount",
				"repliesCount",
				"uri",
				"url",
				"score",
				"files",
				"visibleUserIds",
				"mentions",
				"mentionedRemoteUsers",
				"emojis",
				"tags",
				"hasPoll",
				"threadId",
				"channelId",
				"userId",
				"userHost",
				"replyId",
				"replyUserId",
				"replyUserHost",
				"replyContent",
				"replyCw",
				"replyFiles",
				"renoteId",
				"renoteUserId",
				"renoteUserHost",
				"renoteContent",
				"renoteCw",
				"renoteFiles",
				"reactions",
				"noteEdit",
				"updatedAt"
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		select: {
			byUserAndDate: `SELECT * FROM home_timeline WHERE "feedUserId" = ? AND "createdAtDate" = ?`,
			byId: `SELECT * FROM home_timeline WHERE "id" = ?`,
		},
		delete: `DELETE FROM home_timeline WHERE "feedUserId" = ? AND "createdAtDate" = ? AND "createdAt" = ? AND "userId" = ?`,
		update: {
			renoteCount: `UPDATE home_timeline SET
				"renoteCount" = ?,
				"score" = ?
				WHERE "feedUserId" = ? AND "createdAtDate" = ? AND "createdAt" = ? AND "userId" = ? IF EXISTS`,
			repliesCount: `UPDATE home_timeline SET
				"repliesCount" = ?
				WHERE "feedUserId" = ? AND "createdAtDate" = ? AND "createdAt" = ? AND "userId" = ? IF EXISTS`,
			reactions: `UPDATE home_timeline SET
				"emojis" = ?,
				"reactions" = ?,
				"score" = ?
				WHERE "feedUserId" = ? AND "createdAtDate" = ? AND "createdAt" = ? AND "userId" = ? IF EXISTS`,
		}
	},
	localTimeline: {
		select: {
			byDate: `SELECT * FROM local_timeline WHERE "createdAtDate" = ?`,
		},
	},
	globalTimeline: {
		select: {
			byDate: `SELECT * FROM global_timeline WHERE "createdAtDate" = ?`,
		},
	},
	reaction: {
		insert: `INSERT INTO reaction
			("id", "noteId", "userId", "reaction", "emoji", "createdAt")
			VALUES (?, ?, ?, ?, ?, ?)`,
		select: {
			byNoteId: `SELECT * FROM reaction_by_id WHERE "noteId" IN ?`,
			byUserId: `SELECT * FROM reaction_by_user_id WHERE "userId" IN ?`,
			byNoteAndUser: `SELECT * FROM reaction WHERE "noteId" IN ? AND "userId" IN ?`,
			byId: `SELECT * FROM reaction WHERE "id" IN ?`,
		},
		delete: `DELETE FROM reaction WHERE "noteId" = ? AND "userId" = ?`,
	},
};
