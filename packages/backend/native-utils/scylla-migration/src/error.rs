use scylla::{
    cql_to_rust::FromRowError,
    transport::{
        errors::{NewSessionError, QueryError},
        query_result::SingleRowTypedError,
    },
};
use sea_orm::DbErr;
use std::io;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum Error {
    #[error("ScyllaDB session error: {0}")]
    Session(#[from] NewSessionError),
    #[error("ScyllaDB query error: {0}")]
    Query(#[from] QueryError),
    #[error("ScyllaDB conversion error: {0}")]
    Conversion(#[from] FromRowError),
    #[error("ScyllaDB row error: {0}")]
    Row(#[from] SingleRowTypedError),
    #[error("File error: {0}")]
    File(#[from] io::Error),
    #[error("PostgreSQL error: {0}")]
    Postgres(#[from] DbErr),
}
