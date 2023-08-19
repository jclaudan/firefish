CREATE TABLE notification (
	"targetId" ascii,
	"createdAtDate" date,
	"createdAt" timestamp,
	"id" ascii,
	"notifierId" ascii,
	"notifierHost" text,
	"type" ascii,
	"entityId" ascii,
	"reaction" text,
	"choice" int,
	"customBody" text,
	"customHeader" text,
	"customIcon" text,
	PRIMARY KEY (("targetId", "createdAtDate"), "createdAt")
) WITH CLUSTERING ORDER BY ("createdAt" DESC);

CREATE INDEX notification_by_id ON notification ("id");
