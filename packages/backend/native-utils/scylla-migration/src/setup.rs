use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, NaiveDate, Utc};
use dialoguer::{theme::ColorfulTheme, Confirm};
use futures::{future, TryStreamExt};
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use scylla::{
    prepared_statement::PreparedStatement, FromRow, FromUserType, IntoUserType, Session,
    SessionBuilder, ValueList,
};
use sea_orm::{entity::*, query::*, Database, DatabaseConnection};
use tokio::sync::Semaphore;
use urlencoding::encode;

use crate::{
    config::{DbConfig, ScyllaConfig},
    entity::{
        drive_file, following, note, note_edit, note_reaction, notification, poll, poll_vote, user,
    },
    error::Error,
};

#[derive(Clone)]
pub(crate) struct Initializer {
    scylla: Arc<Session>,
    postgres_url: String,
    note_since: Option<String>,
    note_skip: u64,
    no_confirm: bool,
}

impl Initializer {
    pub(crate) async fn new(
        scylla_conf: &ScyllaConfig,
        postgres_conf: &DbConfig,
        note_since: Option<String>,
        note_skip: u64,
        no_confirm: bool,
    ) -> Result<Self, Error> {
        let mut builder = SessionBuilder::new().known_nodes(&scylla_conf.nodes);

        match &scylla_conf.credentials {
            Some(credentials) => {
                builder = builder.user(&credentials.username, &credentials.password);
            }
            None => {}
        }

        let session = builder.build().await?;
        session.use_keyspace(&scylla_conf.keyspace, true).await?;

        let conn_url = format!(
            "postgres://{}:{}@{}:{}/{}",
            postgres_conf.user,
            encode(&postgres_conf.pass),
            postgres_conf.host,
            postgres_conf.port,
            postgres_conf.db,
        );

        Ok(Self {
            scylla: Arc::new(session),
            postgres_url: conn_url,
            note_since,
            note_skip,
            no_confirm,
        })
    }

    pub(crate) async fn setup(&self, threads: u32) -> Result<(), Error> {
        println!("Several tables in PostgreSQL are going to be moved to ScyllaDB.");

        let pool = Database::connect(&self.postgres_url).await?;
        let db_backend = pool.get_database_backend();

        println!(
            "{}",
            dialoguer::console::style(
                "This is irreversible! Please backup your PostgreSQL database before you proceed."
            )
            .bold()
        );

        if !self.no_confirm {
            let confirm = Confirm::with_theme(&ColorfulTheme::default())
                .with_prompt("This process may take a while. Do you want to continue?")
                .interact()
                .unwrap_or(false);

            if !confirm {
                println!("Cancelled.");
                return Ok(());
            }
        }

        println!("Copying data from PostgreSQL to ScyllaDB.");
        self.copy(pool.clone(), threads.try_into().unwrap_or(1))
            .await?;

        println!("Dropping constraints from PostgreSQL.");
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

        println!("Dropping tables from PostgreSQL.");
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

    async fn copy(&self, db: DatabaseConnection, threads: usize) -> Result<(), Error> {
        let note_prepared = Arc::new(self.scylla.prepare(INSERT_NOTE).await?);
        let home_prepared = Arc::new(self.scylla.prepare(INSERT_HOME_TIMELINE).await?);
        let reaction_prepared = Arc::new(self.scylla.prepare(INSERT_REACTION).await?);
        let vote_insert_prepared = Arc::new(self.scylla.prepare(INSERT_POLL_VOTE).await?);
        let vote_select_prepared = Arc::new(self.scylla.prepare(SELECT_POLL_VOTE).await?);
        let notification_prepared = Arc::new(self.scylla.prepare(INSERT_NOTIFICATION).await?);

        let mut num_notes = note::Entity::find();

        if let Some(since) = self.note_since.clone() {
            num_notes = num_notes.filter(note::Column::Id.gt(&since));
        }

        let mut num_notes: i64 = num_notes
            .select_only()
            .column_as(note::Column::Id.count(), "count")
            .into_tuple()
            .one(&db)
            .await?
            .unwrap_or_default();
        num_notes -= self.note_skip as i64;
        println!("Posts: {num_notes}");
        let num_reactions: i64 = note_reaction::Entity::find()
            .select_only()
            .column_as(note_reaction::Column::Id.count(), "count")
            .into_tuple()
            .one(&db)
            .await?
            .unwrap_or_default();
        println!("Reactions: {num_reactions}");
        let num_votes: i64 = poll_vote::Entity::find()
            .select_only()
            .column_as(poll_vote::Column::Id.count(), "count")
            .into_tuple()
            .one(&db)
            .await?
            .unwrap_or_default();
        println!("Votes: {num_votes}");
        let num_notifications: i64 = notification::Entity::find()
            .select_only()
            .column_as(notification::Column::Id.count(), "count")
            .into_tuple()
            .one(&db)
            .await?
            .unwrap_or_default();
        println!("Notifications: {num_notifications}");

        const PB_TMPL: &str =
            "{spinner:.green} {prefix} [{elapsed_precise}] [{wide_bar:.cyan/blue}] {pos}/{len} ({eta})";
        let pb_style = ProgressStyle::with_template(PB_TMPL)
            .unwrap()
            .progress_chars("#>-");
        let mp = MultiProgress::new();
        let note_pb = mp.add(
            ProgressBar::new(num_notes as u64)
                .with_style(pb_style.to_owned())
                .with_prefix("Posts"),
        );
        let reaction_pb = mp.add(
            ProgressBar::new(num_reactions as u64)
                .with_style(pb_style.to_owned())
                .with_prefix("Reactions"),
        );
        let vote_pb = mp.add(
            ProgressBar::new(num_votes as u64)
                .with_style(pb_style.to_owned())
                .with_prefix("Votes"),
        );
        let notification_pb = mp.add(
            ProgressBar::new(num_notifications as u64)
                .with_style(pb_style.to_owned())
                .with_prefix("Notifications"),
        );

        let mut tasks = Vec::new();
        let sem = Arc::new(Semaphore::new(threads));

        let mut notes = note::Entity::find().order_by_asc(note::Column::Id);
        if let Some(since_id) = self.note_since.clone() {
            notes = notes.filter(note::Column::Id.gt(&since_id));
        }
        let mut notes = notes.stream(&db).await?;

        let mut copied: u64 = 0;

        while let Some(note) = notes.try_next().await? {
            copied += 1;
            if copied <= self.note_skip {
                continue;
            }
            if let Ok(permit) = Arc::clone(&sem).acquire_owned().await {
                let (s, d, n, h, p) = (
                    self.clone(),
                    db.clone(),
                    note_prepared.clone(),
                    home_prepared.clone(),
                    note_pb.clone(),
                );
                let handler = tokio::spawn(async move {
                    if let Err(e) = s.copy_note(note, d, n, h).await {
                        p.println(format!("Note copy error: {e}"));
                    }
                    p.inc(1);
                    drop(permit);
                });
                tasks.push(handler);
            }

            if tasks.len() > 1000 {
                future::join_all(tasks).await;
                tasks = Vec::new();
            }
        }

        future::join_all(tasks).await;
        tasks = Vec::new();

        let mut reactions = note_reaction::Entity::find()
            .order_by_asc(note_reaction::Column::Id)
            .stream(&db)
            .await?;
        while let Some(reaction) = reactions.try_next().await? {
            if let Ok(permit) = Arc::clone(&sem).acquire_owned().await {
                let (s, r, p) = (self.clone(), reaction_prepared.clone(), reaction_pb.clone());
                let handler = tokio::spawn(async move {
                    if let Err(e) = s.copy_reaction(reaction, r).await {
                        p.println(format!("Reaction copy error: {e}"));
                    }
                    p.inc(1);
                    drop(permit);
                });
                tasks.push(handler);
            }

            if tasks.len() > 1000 {
                future::join_all(tasks).await;
                tasks = Vec::new();
            }
        }

        future::join_all(tasks).await;
        tasks = Vec::new();

        let mut votes = poll_vote::Entity::find()
            .order_by_asc(poll_vote::Column::Id)
            .stream(&db)
            .await?;
        while let Some(vote) = votes.try_next().await? {
            if let Ok(permit) = Arc::clone(&sem).acquire_owned().await {
                let (s, d, sp, ip, p) = (
                    self.clone(),
                    db.clone(),
                    vote_select_prepared.clone(),
                    vote_insert_prepared.clone(),
                    vote_pb.clone(),
                );
                let handler = tokio::spawn(async move {
                    if let Err(e) = s.copy_vote(vote, d, sp, ip).await {
                        p.println(format!("Vote copy error: {e}"));
                    }
                    p.inc(1);
                    drop(permit);
                });
                tasks.push(handler);
            }

            if tasks.len() > 1000 {
                future::join_all(tasks).await;
                tasks = Vec::new();
            }
        }

        future::join_all(tasks).await;
        tasks = Vec::new();

        let mut notifications = notification::Entity::find()
            .order_by_asc(notification::Column::Id)
            .stream(&db)
            .await?;
        while let Some(n) = notifications.try_next().await? {
            if let Ok(permit) = Arc::clone(&sem).acquire_owned().await {
                let (s, d, ps, p) = (
                    self.clone(),
                    db.clone(),
                    notification_prepared.clone(),
                    notification_pb.clone(),
                );
                let handler = tokio::spawn(async move {
                    if let Err(e) = s.copy_notification(n, d, ps).await {
                        p.println(format!("Notification copy error: {e}"));
                    }
                    p.inc(1);
                    drop(permit);
                });
                tasks.push(handler);
            }

            if tasks.len() > 1000 {
                future::join_all(tasks).await;
                tasks = Vec::new();
            }
        }

        future::join_all(tasks).await;

        Ok(())
    }

    async fn copy_note(
        &self,
        note: note::Model,
        db: DatabaseConnection,
        insert_note: Arc<PreparedStatement>,
        insert_home: Arc<PreparedStatement>,
    ) -> Result<(), Error> {
        let reply = match &note.reply_id {
            None => None,
            Some(id) => note::Entity::find_by_id(id).one(&db).await?,
        };
        let renote = match &note.renote_id {
            None => None,
            Some(id) => note::Entity::find_by_id(id).one(&db).await?,
        };

        let files = get_attached_files(Some(note.to_owned()), &db).await?;
        let reply_files = get_attached_files(reply.to_owned(), &db).await?;
        let renote_files = get_attached_files(renote.to_owned(), &db).await?;

        let note_poll = note.find_related(poll::Entity).one(&db).await?;
        let poll_type = match note_poll {
            None => None,
            Some(v) => Some(PollType {
                multiple: v.multiple,
                expires_at: v.expires_at.map(Into::into),
                choices: HashMap::from_iter(
                    v.choices
                        .iter()
                        .enumerate()
                        .map(|(i, v)| ((i + 1) as i32, v.to_string())),
                ),
            }),
        };

        let reactions: HashMap<String, i32> = match note.reactions.as_object() {
            None => HashMap::new(),
            Some(obj) => HashMap::from_iter(
                obj.into_iter()
                    .map(|(k, v)| (k.to_string(), v.as_i64().unwrap_or_default() as i32)),
            ),
        };
        let edits = note.find_related(note_edit::Entity).all(&db).await?;
        let edits = edits.iter().map(|v| async {
            let v = v.to_owned();
            Ok(NoteEditHistoryType {
                content: v.text,
                cw: v.cw,
                files: get_files(v.file_ids, &db).await?,
                updated_at: v.updated_at.into(),
            })
        });
        let edits: Vec<Result<NoteEditHistoryType, Error>> = futures::future::join_all(edits).await;
        let edits: Vec<NoteEditHistoryType> = edits
            .iter()
            .filter_map(|v| v.as_ref().ok())
            .cloned()
            .collect();

        let scylla_note = NoteTable {
            created_at_date: note.created_at.date_naive(),
            created_at: note.created_at.into(),
            id: note.id.clone(),
            visibility: note.visibility.to_value(),
            content: note.text,
            lang: note.lang,
            name: note.name,
            cw: note.cw,
            local_only: note.local_only,
            renote_count: note.renote_count as i32,
            replies_count: note.replies_count as i32,
            uri: note.uri,
            url: note.url,
            score: note.score,
            files,
            visible_user_ids: note.visible_user_ids,
            mentions: note.mentions,
            mentioned_remote_users: note.mentioned_remote_users,
            emojis: note.emojis,
            tags: note.tags,
            has_poll: poll_type.is_some(),
            poll: poll_type,
            thread_id: note.thread_id,
            channel_id: note.channel_id,
            user_id: note.user_id.clone(),
            user_host: note.user_host.unwrap_or("local".to_string()),
            reply_id: note.reply_id,
            reply_user_id: note.reply_user_id,
            reply_user_host: note.reply_user_host,
            reply_content: reply.as_ref().map(|v| v.text.to_owned()).flatten(),
            reply_cw: reply.as_ref().map(|v| v.cw.to_owned()).flatten(),
            reply_files,
            renote_id: note.renote_id,
            renote_user_id: note.renote_user_id,
            renote_user_host: note.renote_user_host,
            renote_content: renote.as_ref().map(|v| v.text.to_owned()).flatten(),
            renote_cw: renote.as_ref().map(|v| v.cw.to_owned()).flatten(),
            renote_files,
            reactions,
            note_edit: edits,
            updated_at: note.updated_at.map(Into::into),
        };

        self.scylla
            .execute(&insert_note, scylla_note.to_owned())
            .await?;

        let s_note = scylla_note.clone();
        let mut home = HomeTimelineTable {
            feed_user_id: s_note.user_id.clone(),
            created_at_date: s_note.created_at_date,
            created_at: s_note.created_at,
            id: s_note.id,
            visibility: s_note.visibility,
            content: s_note.content,
            lang: s_note.lang,
            name: s_note.name,
            cw: s_note.cw,
            local_only: s_note.local_only,
            renote_count: s_note.renote_count,
            replies_count: s_note.replies_count,
            uri: s_note.uri,
            url: s_note.url,
            score: s_note.score,
            files: s_note.files,
            visible_user_ids: s_note.visible_user_ids,
            mentions: s_note.mentions,
            mentioned_remote_users: s_note.mentioned_remote_users,
            emojis: s_note.emojis,
            tags: s_note.tags,
            has_poll: s_note.has_poll,
            poll: s_note.poll,
            thread_id: s_note.thread_id,
            channel_id: s_note.channel_id,
            user_id: s_note.user_id,
            user_host: s_note.user_host.clone(),
            reply_id: s_note.reply_id,
            reply_user_id: s_note.reply_user_id,
            reply_user_host: s_note.reply_user_host,
            reply_content: s_note.reply_content,
            reply_cw: s_note.reply_cw,
            reply_files: s_note.reply_files,
            renote_id: s_note.renote_id,
            renote_user_id: s_note.renote_user_id,
            renote_user_host: s_note.renote_user_host,
            renote_content: s_note.renote_content,
            renote_cw: s_note.renote_cw,
            renote_files: s_note.renote_files,
            reactions: s_note.reactions,
            note_edit: s_note.note_edit,
            updated_at: s_note.updated_at,
        };
        if s_note.user_host == "local" {
            self.scylla.execute(&insert_home, home.clone()).await?;
        }

        let mut local_followers = following::Entity::find()
            .select_only()
            .column(following::Column::FollowerId)
            .filter(following::Column::FolloweeId.eq(note.user_id))
            .filter(following::Column::FollowerHost.is_null())
            .into_tuple::<String>()
            .stream(&db)
            .await?;
        while let Some(follower_id) = local_followers.try_next().await? {
            home.feed_user_id = follower_id;
            // Ignore even if ScyllaDB timeouts so that we can try to insert the note to the remaining timelines.
            let _ = self.scylla.execute(&insert_home, home.clone()).await;
        }

        Ok(())
    }

    async fn copy_reaction(
        &self,
        reaction: note_reaction::Model,
        insert: Arc<PreparedStatement>,
    ) -> Result<(), Error> {
        let scylla_reaction = ReactionTable {
            id: reaction.id,
            note_id: reaction.note_id,
            user_id: reaction.user_id,
            reaction: reaction.reaction,
            created_at: reaction.created_at.into(),
        };
        self.scylla.execute(&insert, scylla_reaction).await?;

        Ok(())
    }

    async fn copy_vote(
        &self,
        vote: poll_vote::Model,
        db: DatabaseConnection,
        select: Arc<PreparedStatement>,
        insert: Arc<PreparedStatement>,
    ) -> Result<(), Error> {
        let voted_user = user::Entity::find_by_id(&vote.user_id).one(&db).await?;
        if let Some(u) = voted_user {
            let mut scylla_vote = PollVoteTable {
                note_id: vote.note_id.to_owned(),
                user_id: vote.user_id.to_owned(),
                user_host: u.host,
                choice: vec![vote.choice],
                created_at: vote.created_at.into(),
            };
            if let Ok(row) = self
                .scylla
                .execute(&select, (vote.note_id, vote.user_id))
                .await?
                .first_row()
            {
                let mut s_vote: PollVoteTable = row.into_typed()?;
                scylla_vote.choice.append(&mut s_vote.choice);
                scylla_vote.choice.dedup();
            }
            self.scylla.execute(&insert, scylla_vote).await?;
        }

        Ok(())
    }

    async fn copy_notification(
        &self,
        model: notification::Model,
        db: DatabaseConnection,
        insert: Arc<PreparedStatement>,
    ) -> Result<(), Error> {
        let notifier = match model.notifier_id.to_owned() {
            None => None,
            Some(id) => user::Entity::find_by_id(&id).one(&db).await?,
        };
        let s_notification = NotificationTable {
            target_id: model.notifiee_id,
            created_at_date: model.created_at.date_naive(),
            created_at: model.created_at.into(),
            id: model.id,
            notifier_id: model.notifier_id,
            notifier_host: notifier.map(|n| n.host).flatten(),
            r#type: model.r#type.to_value(),
            entity_id: model
                .note_id
                .or(model.follow_request_id)
                .or(model.user_group_invitation_id)
                .or(model.app_access_token_id),
            reatcion: model.reaction,
            choice: model.choice,
            custom_body: model.custom_body,
            custom_header: model.custom_header,
            custom_icon: model.custom_icon,
        };
        self.scylla.execute(&insert, s_notification).await?;

        Ok(())
    }
}

fn map_drive_file(file: drive_file::Model) -> DriveFileType {
    DriveFileType {
        id: file.id,
        r#type: file.r#type,
        created_at: file.created_at.into(),
        name: file.name,
        comment: file.comment,
        blurhash: file.blurhash,
        url: file.url,
        thumbnail_url: file.thumbnail_url,
        is_sensitive: file.is_sensitive,
        is_link: file.is_link,
        md5: file.md5,
        size: file.size,
        width: file
            .properties
            .get("width")
            .filter(|v| v.is_number())
            .map(|v| v.as_i64().unwrap_or_default() as i32),
        height: file
            .properties
            .get("height")
            .filter(|v| v.is_number())
            .map(|v| v.as_i64().unwrap_or_default() as i32),
    }
}

async fn get_attached_files(
    note: Option<note::Model>,
    db: &DatabaseConnection,
) -> Result<Vec<DriveFileType>, Error> {
    match note {
        None => Ok(vec![]),
        Some(v) => Ok(get_files(v.file_ids, db).await?),
    }
}

async fn get_files(
    file_ids: Vec<String>,
    db: &DatabaseConnection,
) -> Result<Vec<DriveFileType>, Error> {
    if file_ids.is_empty() {
        Ok(vec![])
    } else {
        let files = drive_file::Entity::find()
            .filter(drive_file::Column::Id.is_in(file_ids))
            .all(db)
            .await?;
        Ok(files.iter().map(|v| map_drive_file(v.to_owned())).collect())
    }
}

#[derive(Debug, Clone, IntoUserType, FromUserType)]
struct DriveFileType {
    id: String,
    r#type: String,
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

#[derive(Debug, Clone, IntoUserType, FromUserType)]
struct NoteEditHistoryType {
    content: Option<String>,
    cw: Option<String>,
    files: Vec<DriveFileType>,
    #[scylla_crate(rename = "updatedAt")]
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, IntoUserType, FromUserType)]
struct PollType {
    #[scylla_crate(rename = "expiresAt")]
    expires_at: Option<DateTime<Utc>>,
    multiple: bool,
    choices: HashMap<i32, String>,
}

#[derive(Clone, ValueList)]
struct NoteTable {
    created_at_date: NaiveDate,
    created_at: DateTime<Utc>,
    id: String,
    visibility: String,
    content: Option<String>,
    lang: Option<String>,
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
    poll: Option<PollType>,
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
    updated_at: Option<DateTime<Utc>>,
}

const INSERT_NOTE: &str = r#"
INSERT INTO note (
"createdAtDate",
"createdAt",
"id",
"visibility",
"content",
"lang",
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

#[derive(Clone, ValueList)]
struct HomeTimelineTable {
    feed_user_id: String,
    created_at_date: NaiveDate,
    created_at: DateTime<Utc>,
    id: String,
    visibility: String,
    content: Option<String>,
    lang: Option<String>,
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
    poll: Option<PollType>,
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
    updated_at: Option<DateTime<Utc>>,
}

const INSERT_HOME_TIMELINE: &str = r#"
INSERT INTO home_timeline (
"feedUserId",
"createdAtDate",
"createdAt",
"id",
"visibility",
"content",
"lang",
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
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"#;

#[derive(ValueList)]
struct ReactionTable {
    id: String,
    note_id: String,
    user_id: String,
    reaction: String,
    created_at: DateTime<Utc>,
}

const INSERT_REACTION: &str = r#"INSERT INTO reaction ("id", "noteId", "userId", "reaction", "createdAt") VALUES (?, ?, ?, ?, ?)"#;

#[derive(ValueList, FromRow)]
struct PollVoteTable {
    note_id: String,
    user_id: String,
    user_host: Option<String>,
    choice: Vec<i32>,
    created_at: DateTime<Utc>,
}

const INSERT_POLL_VOTE: &str = r#"INSERT INTO poll_vote ("noteId", "userId", "userHost", "choice", "createdAt") VALUES (?, ?, ?, ?, ?)"#;
const SELECT_POLL_VOTE: &str = r#"SELECT "noteId", "userId", "userHost", "choice", "createdAt" FROM poll_vote WHERE "noteId" = ? AND "userId" = ?"#;

#[derive(ValueList)]
struct NotificationTable {
    target_id: String,
    created_at_date: NaiveDate,
    created_at: DateTime<Utc>,
    id: String,
    notifier_id: Option<String>,
    notifier_host: Option<String>,
    r#type: String,
    entity_id: Option<String>,
    reatcion: Option<String>,
    choice: Option<i32>,
    custom_body: Option<String>,
    custom_header: Option<String>,
    custom_icon: Option<String>,
}

const INSERT_NOTIFICATION: &str = r#"INSERT INTO notification ("targetId", "createdAtDate", "createdAt", "id", "notifierId", "notifierHost", "type", "entityId", "reaction", "choice", "customBody", "customHeader", "customIcon") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#;
