CREATE TYPE emoji (
	"name" text,
	"url" text,
	"width" int,
	"height" int,
);
ALTER TABLE reaction ADD "emoji" frozen<emoji>;
