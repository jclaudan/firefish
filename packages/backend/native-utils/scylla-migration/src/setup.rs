use scylla::{Session, SessionBuilder};
use sqlx::{Connection, PgConnection};
use urlencoding::encode;

use crate::{
    config::{DbConfig, ScyllaConfig},
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
        let pairs = vec![
            ("channel_note_pining", "FK_10b19ef67d297ea9de325cd4502"),
            ("clip_note", "FK_a012eaf5c87c65da1deb5fdbfa3"),
            ("muted_note", "FK_70ab9786313d78e4201d81cdb89"),
            ("note_edit", "FK_702ad5ae993a672e4fbffbcd38c"),
            ("note_favorite", "FK_0e00498f180193423c992bc4370"),
            ("note_unread", "FK_e637cba4dc4410218c4251260e4"),
            ("note_watching", "FK_03e7028ab8388a3f5e3ce2a8619"),
            ("promo_note", "FK_e263909ca4fe5d57f8d4230dd5c"),
            ("promo_read", "FK_a46a1a603ecee695d7db26da5f4"),
            ("user_note_pining", "FK_68881008f7c3588ad7ecae471cf"),
        ];

        let mut conn = PgConnection::connect(&self.postgres_url).await?;

        for (table, fk) in pairs {
            sqlx::query(&format!("ALTER TABLE {} DROP CONSTRAINT \"{}\"", table, fk))
                .execute(&mut conn)
                .await?;
        }

        Ok(())
    }
}
