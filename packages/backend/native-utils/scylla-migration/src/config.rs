use serde::Deserialize;

#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub scylla: Option<ScyllaConfig>,
    pub db: DbConfig,
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScyllaConfig {
    pub nodes: Vec<String>,
    pub keyspace: String,
    pub replication_factor: i32,
    pub credentials: Option<Credentials>,
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct DbConfig {
    pub host: String,
    pub port: u32,
    pub db: String,
    pub user: String,
    pub pass: String,
}
