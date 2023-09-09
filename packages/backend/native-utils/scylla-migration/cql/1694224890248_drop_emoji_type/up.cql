DROP MATERIALIZED VIEW reaction_by_user_id;
DROP MATERIALIZED VIEW reaction_by_id;
ALTER TABLE reaction DROP "emoji";
DROP TYPE emoji;
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
