use std::collections::HashMap;

use futures::TryStreamExt;
use scylla::{Session, SessionBuilder, IntoUserType, FromUserType, ValueList, FromRow};
use sea_orm::{query::*, entity::*, Database};
use urlencoding::encode;

use chrono::{DateTime, Utc, NaiveDate};

use crate::{
    config::{DbConfig, ScyllaConfig},
    entity::note,
    error::Error,
};

pub(crate) struct Initializer {
    scylla: Session,
    postgres_url: String,
}

impl Initializer {
    pub(crate) async fn new(
        scylla_conf: &ScyllaConfig,
        postgres_conf: &DbConfig,
    ) -> Result<Self, Error> {
        let session = SessionBuilder::new()
            .known_nodes(&scylla_conf.nodes)
            .build()
            .await?;

        let conn_url = format!(
            "postgres://{}:{}@{}:{}/{}",
            postgres_conf.user,
            encode(&postgres_conf.pass),
            postgres_conf.host,
            postgres_conf.port,
            postgres_conf.db,
        );

        Ok(Self {
            scylla: session,
            postgres_url: conn_url,
        })
    }

    pub(crate) async fn setup(&self) -> Result<(), Error> {
        let pool = Database::connect(&self.postgres_url).await?;
        let db_backend = pool.get_database_backend();

        let num_notes: i64 = note::Entity::find().select_only().column_as(note::Column::Id.count(), "count").into_tuple().one(&pool).await?.unwrap_or_default();

        println!("{num_notes} posts are being copied.")

        let mut notes = note::Entity::find().stream(&pool).await?;
        while let Some(note) = notes.try_next().await? {
        }

        let fk_pairs = vec![
            ("channel_note_pining", "FK_10b19ef67d297ea9de325cd4502"),
            ("clip_note", "FK_a012eaf5c87c65da1deb5fdbfa3"),
            ("muted_note", "FK_70ab9786313d78e4201d81cdb89"),
            ("note_favorite", "FK_0e00498f180193423c992bc4370"),
            ("note_unread", "FK_e637cba4dc4410218c4251260e4"),
            ("note_watching", "FK_03e7028ab8388a3f5e3ce2a8619"),
            ("promo_note", "FK_e263909ca4fe5d57f8d4230dd5c"),
            ("promo_read", "FK_a46a1a603ecee695d7db26da5f4"),
            ("user_note_pining", "FK_68881008f7c3588ad7ecae471cf"),
        ];
        for (table, fk) in fk_pairs {
            pool.execute(Statement::from_string(
                db_backend.to_owned(),
                format!("ALTER TABLE {} DROP CONSTRAINT \"{}\"", table, fk),
            ))
            .await?;
        }

        let tables = vec![
            "note_reaction",
            "note_edit",
            "poll",
            "poll_vote",
            "notification",
            "note",
        ];
        for table in tables {
            pool.execute(Statement::from_string(
                db_backend,
                format!("DROP TABLE {}", table),
            ))
            .await?;
        }

        Ok(())
    }
}

#[derive(Debug, IntoUserType, FromUserType)]
struct DriveFileType {
    id: String,
    #[scylla_crate(rename = "type")]
    kind: String,
    #[scylla_crate(rename = "createdAt")]
    created_at: DateTime<Utc>,
    name: String,
    comment: Option<String>,
    blurhash: Option<String>,
    url: String,
    #[scylla_crate(rename = "thumbnailUrl")]
    thumbnail_url: Option<String>,
    #[scylla_crate(rename = "isSensitive")]
    is_sensitive: bool,
    #[scylla_crate(rename = "isLink")]
    is_link: bool,
    md5: String,
    size: i32,
    width: Option<i32>,
    height: Option<i32>,
}

#[derive(Debug, IntoUserType, FromUserType)]
struct NoteEditHistoryType {
    content: Option<String>,
    cw: Option<String>,
    files: Vec<DriveFileType>,
    #[scylla_crate(rename = "updatedAt")]
    updated_at: DateTime<Utc>
}

#[derive(Debug, IntoUserType, FromUserType)]
struct EmojiType {
    name: String,
    url: String,
    width: Option<i32>,
    height: Option<i32>,
}

#[derive(Debug, IntoUserType, FromUserType)]
struct PollType {
    #[scylla_crate(rename = "expiresAt")]
    expires_at: Option<DateTime<Utc>>,
    multiple: bool,
    choices: HashMap<i32, String>,
}

#[derive(ValueList)]
struct NoteTable {
    created_at_date: NaiveDate,
    created_at: DateTime<Utc>,
    id: String,
    visibility: String,
    content: Option<String>,
    name: Option<String>,
    cw: Option<String>,
    local_only: bool,
    renote_count: i32,
    replies_count: i32,
    uri: Option<String>,
    url: Option<String>,
    score: i32,
    files: Vec<DriveFileType>,
    visible_user_ids: Vec<String>,
    mentions: Vec<String>,
    mentioned_remote_users: String,
    emojis: Vec<String>,
    tags: Vec<String>,
    has_poll: bool,
    poll: PollType,
    thread_id: Option<String>,
    channel_id: Option<String>,
    user_id: String,
    user_host: String,
    reply_id: Option<String>,
    reply_user_id: Option<String>,
    reply_user_host: Option<String>,
    reply_content: Option<String>,
    reply_cw: Option<String>,
    reply_files: Vec<DriveFileType>,
    renote_id: Option<String>,
    renote_user_id: Option<String>,
    renote_user_host: Option<String>,
    renote_content: Option<String>,
    renote_cw: Option<String>,
    renote_files: Vec<DriveFileType>,
    reactions: HashMap<String, i32>,
    note_edit: Vec<NoteEditHistoryType>,
    updated_at: DateTime<Utc>,
}

const INSERT_NOTE: &str = r#"
INSERT INTO note (
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
"poll",
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
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"#;

#[derive(ValueList)]
struct HomeTimelineTable {
    feed_user_id: String,
    created_at_date: NaiveDate,
    created_at: DateTime<Utc>,
    id: String,
    visibility: String,
    content: Option<String>,
    name: Option<String>,
    cw: Option<String>,
    local_only: bool,
    renote_count: i32,
    replies_count: i32,
    uri: Option<String>,
    url: Option<String>,
    score: i32,
    files: Vec<DriveFileType>,
    visible_user_ids: Vec<String>,
    mentions: Vec<String>,
    mentioned_remote_users: String,
    emojis: Vec<String>,
    tags: Vec<String>,
    has_poll: bool,
    poll: PollType,
    thread_id: Option<String>,
    channel_id: Option<String>,
    user_id: String,
    user_host: String,
    reply_id: Option<String>,
    reply_user_id: Option<String>,
    reply_user_host: Option<String>,
    reply_content: Option<String>,
    reply_cw: Option<String>,
    reply_files: Vec<DriveFileType>,
    renote_id: Option<String>,
    renote_user_id: Option<String>,
    renote_user_host: Option<String>,
    renote_content: Option<String>,
    renote_cw: Option<String>,
    renote_files: Vec<DriveFileType>,
    reactions: HashMap<String, i32>,
    note_edit: Vec<NoteEditHistoryType>,
    updated_at: DateTime<Utc>,
}

const INSERT_HOME_TIMELINE: &str = r#"
INSERT INTO home_timeline (
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
"poll",
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
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"#;

#[derive(ValueList)]
struct ReactionTable {
    id: String,
    note_id: String,
    user_id: String,
    reaction: String,
    emoji: EmojiType,
    created_at: DateTime<Utc>,
}

const INSERT_REACTION: &str = r#"INSERT INTO reaction ("id", "noteId", "userId", "reaction", "emoji", "createdAt") VALUES (?, ?, ?, ?, ?, ?)"#;

#[derive(ValueList)]
struct PollVoteTable {
    note_id: String,
    user_id: String,
    user_host: String,
    choice: Vec<i32>,
    created_at: DateTime<Utc>,
}

const INSERT_POLL_VOTE: &str = r#"INSERT INTO poll_vote ("noteId", "userId", "userHost", "choice", "createdAt") VALUES (?, ?, ?, ?, ?)"#;

#[derive(ValueList)]
struct NotificationTable {
    target_id: String,
    created_at_date: NaiveDate,

}
