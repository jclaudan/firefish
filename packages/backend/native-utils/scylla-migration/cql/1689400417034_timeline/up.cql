CREATE TYPE drive_file (
	"id" ascii,
	"type" ascii,
	"createdAt" timestamp,
	"name" text,
	"comment" text,
	"blurhash" text,
	"url" text,
	"thumbnailUrl" text,
	"isSensitive" boolean,
	"isLink" boolean,
	"md5" ascii,
	"size" int,
	"width" int,
	"height" int,
);

CREATE TYPE note_edit_history (
	"content" text,
	"cw" text,
	"files" set<frozen<drive_file>>,
	"updatedAt" timestamp,
);

CREATE TYPE emoji (
	"name" text,
	"url" text,
	"width" int,
	"height" int,
);

CREATE TYPE poll (
	"expiresAt" timestamp,
	"multiple" boolean,
	"choices" map<int, text>,
);

CREATE TABLE note ( -- Store all posts
	"createdAtDate" date, -- For partitioning
	"createdAt" timestamp,
	"id" ascii, -- Post
	"visibility" ascii,
	"content" text,
	"name" text,
	"cw" text,
	"localOnly" boolean,
	"renoteCount" int,
	"repliesCount" int,
	"uri" text,
	"url" text,
	"score" int,
	"files" set<frozen<drive_file>>,
	"visibleUserIds" set<ascii>,
	"mentions" set<ascii>,
	"mentionedRemoteUsers" text,
	"emojis" set<text>,
	"tags" set<text>,
	"hasPoll" boolean,
	"poll" frozen<poll>,
	"threadId" ascii,
	"channelId" ascii, -- Channel
	"userId" ascii, -- User
	"userHost" text,
	"replyId" ascii, -- Reply
	"replyUserId" ascii,
	"replyUserHost" text,
	"replyContent" text,
	"replyCw" text,
	"replyFiles" set<frozen<drive_file>>,
	"renoteId" ascii, -- Boost
	"renoteUserId" ascii,
	"renoteUserHost" text,
	"renoteContent" text,
	"renoteCw" text,
	"renoteFiles" set<frozen<drive_file>>,
	"reactions" map<text, int>, -- Reactions
	"noteEdit" set<frozen<note_edit_history>>, -- Edit History
	"updatedAt" timestamp,
	PRIMARY KEY ("createdAtDate", "createdAt", "userId", "userHost", "visibility")
) WITH CLUSTERING ORDER BY ("createdAt" DESC);

CREATE INDEX note_by_uri ON note ("uri");
CREATE INDEX note_by_url ON note ("url");
CREATE INDEX note_by_reply_id ON note ("replyId");

CREATE MATERIALIZED VIEW note_by_id AS
	SELECT * FROM note
	WHERE "id" IS NOT NULL
	AND "createdAt" IS NOT NULL
	AND "createdAtDate" IS NOT NULL
	AND "userId" IS NOT NULL
	AND "userHost" IS NOT NULL
	AND "visibility" IS NOT NULL
	PRIMARY KEY ("id", "createdAt", "createdAtDate", "userId", "userHost", "visibility")
	WITH CLUSTERING ORDER BY ("createdAt" DESC);

CREATE MATERIALIZED VIEW note_by_user_id AS
	SELECT * FROM note
	WHERE "userId" IS NOT NULL
	AND "createdAt" IS NOT NULL
	AND "createdAtDate" IS NOT NULL
	AND "userHost" IS NOT NULL
	AND "visibility" IS NOT NULL
	PRIMARY KEY ("userId", "createdAt", "createdAtDate", "userHost", "visibility")
	WITH CLUSTERING ORDER BY ("createdAt" DESC);

CREATE MATERIALIZED VIEW note_by_renote_id AS
	SELECT * FROM note
	WHERE "renoteId" IS NOT NULL
	AND "createdAt" IS NOT NULL
	AND "createdAtDate" IS NOT NULL
	AND "userId" IS NOT NULL
	AND "userHost" IS NOT NULL
	AND "visibility" IS NOT NULL
	PRIMARY KEY ("renoteId", "createdAt", "createdAtDate", "userId", "userHost", "visibility")
	WITH CLUSTERING ORDER BY ("createdAt" DESC);

CREATE MATERIALIZED VIEW note_by_renote_id_and_user_id AS
	SELECT "renoteId", "userId", "createdAt", "createdAtDate", "userHost", "visibility", "id" FROM note
	WHERE "renoteId" IS NOT NULL
	AND "createdAt" IS NOT NULL
	AND "createdAtDate" IS NOT NULL
	AND "userId" IS NOT NULL
	AND "userHost" IS NOT NULL
	AND "visibility" IS NOT NULL
	PRIMARY KEY (("renoteId", "userId"), "createdAt", "createdAtDate", "userHost", "visibility")
	WITH CLUSTERING ORDER BY ("createdAt" DESC);

CREATE MATERIALIZED VIEW note_by_channel_id AS
	SELECT * FROM note
	WHERE "channelId" IS NOT NULL
	AND "createdAt" IS NOT NULL
	AND "createdAtDate" IS NOT NULL
	AND "userId" IS NOT NULL
	AND "userHost" IS NOT NULL
	AND "visibility" IS NOT NULL
	PRIMARY KEY ("channelId", "createdAt", "createdAtDate", "userId", "userHost", "visibility")
	WITH CLUSTERING ORDER BY ("createdAt" DESC);

CREATE MATERIALIZED VIEW global_timeline AS
	SELECT * FROM note
	WHERE "createdAtDate" IS NOT NULL
	AND "createdAt" IS NOT NULL
	AND "userId" IS NOT NULL
	AND "userHost" IS NOT NULL
	AND "visibility" = 'public'
	PRIMARY KEY ("createdAtDate", "createdAt", "userId", "userHost", "visibility")
	WITH CLUSTERING ORDER BY ("createdAt" DESC);

CREATE MATERIALIZED VIEW local_timeline AS
	SELECT * FROM note
	WHERE "createdAtDate" IS NOT NULL
	AND "createdAt" IS NOT NULL
	AND "userId" IS NOT NULL
	AND "userHost" = 'local'
	AND "visibility" = 'public'
	PRIMARY KEY ("createdAtDate", "createdAt", "userId", "userHost", "visibility")
	WITH CLUSTERING ORDER BY ("createdAt" DESC);

CREATE MATERIALIZED VIEW score_feed AS
	SELECT * FROM note
	WHERE "createdAtDate" IS NOT NULL
	AND "createdAt" IS NOT NULL
	AND "userId" IS NOT NULL
	AND "userHost" IS NOT NULL
	AND "score" IS NOT NULL
	AND "visibility" = 'public'
	AND "score" IS NOT NULL
	PRIMARY KEY ("createdAtDate", "score", "createdAt", "userHost", "userId", "visibility")
	WITH CLUSTERING ORDER BY ("score" DESC, "createdAt" DESC);

CREATE TABLE home_timeline (
	"feedUserId" ascii, -- For partitioning
	"createdAtDate" date, -- For partitioning
	"createdAt" timestamp,
	"id" ascii, -- Post
	"visibility" ascii,
	"content" text,
	"name" text,
	"cw" text,
	"localOnly" boolean,
	"renoteCount" int,
	"repliesCount" int,
	"uri" text,
	"url" text,
	"score" int,
	"files" set<frozen<drive_file>>,
	"visibleUserIds" set<ascii>,
	"mentions" set<ascii>,
	"mentionedRemoteUsers" text,
	"emojis" set<text>,
	"tags" set<text>,
	"hasPoll" boolean,
	"poll" frozen<poll>,
	"threadId" ascii,
	"channelId" ascii, -- Channel
	"userId" ascii, -- User
	"userHost" text,
	"replyId" ascii, -- Reply
	"replyUserId" ascii,
	"replyUserHost" text,
	"replyContent" text,
	"replyCw" text,
	"replyFiles" set<frozen<drive_file>>,
	"renoteId" ascii, -- Boost
	"renoteUserId" ascii,
	"renoteUserHost" text,
	"renoteContent" text,
	"renoteCw" text,
	"renoteFiles" set<frozen<drive_file>>,
	"reactions" map<text, int>, -- Reactions
	"noteEdit" set<frozen<note_edit_history>>, -- Edit History
	"updatedAt" timestamp,
	PRIMARY KEY (("feedUserId", "createdAtDate"), "createdAt", "userId")
) WITH CLUSTERING ORDER BY ("createdAt" DESC);

CREATE INDEX home_by_id ON home_timeline ("id");

CREATE INDEX home_by_feed_user_id ON home_timeline ("feedUserId");

CREATE TABLE reaction (
	"id" text,
	"noteId" ascii,
	"userId" ascii,
	"reaction" text,
	"emoji" frozen<emoji>,
	"createdAt" timestamp,
	PRIMARY KEY ("noteId", "userId") -- this key constraints one reaction per user for the same post
);

CREATE MATERIALIZED VIEW reaction_by_user_id AS
	SELECT * FROM reaction
	WHERE "userId" IS NOT NULL
	AND "createdAt" IS NOT NULL
	AND "noteId" IS NOT NULL
	PRIMARY KEY ("userId", "createdAt", "noteId")
	WITH CLUSTERING ORDER BY ("createdAt" DESC);

CREATE MATERIALIZED VIEW reaction_by_id AS
	SELECT * FROM reaction
	WHERE "noteId" IS NOT NULL
	AND "reaction" IS NOT NULL
	AND "userId" IS NOT NULL
	PRIMARY KEY ("noteId", "reaction", "userId");

CREATE TABLE poll_vote (
	"noteId" ascii,
	"userId" ascii,
	"userHost" text,
	"choice" set<int>,
	"createdAt" timestamp,
	PRIMARY KEY ("noteId", "userId")
);
