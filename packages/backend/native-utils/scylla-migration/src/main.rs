use scylla_migration::{cli::run_cli, error::Error};

#[tokio::main]
async fn main() -> Result<(), Error> {
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_panic(info);
        std::process::exit(1);
    }));

    run_cli().await?;

    Ok(())
}
