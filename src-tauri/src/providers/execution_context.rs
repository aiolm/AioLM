//! An accepted help run records the execution directory it actually used.
//! Launcher directories must not silently change a reviewed runtime context.
use crate::AppConfig;
use std::path::PathBuf;

pub fn observed(declared: Option<PathBuf>) -> Result<PathBuf, String> {
    declared
        .map(Ok)
        .unwrap_or_else(std::env::current_dir)
        .and_then(|path| path.canonicalize())
        .map_err(|error| error.to_string())
}

pub fn requested(
    declared: Option<PathBuf>,
    requested: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let Some(requested) = requested else {
        return Ok(declared);
    };
    let path = PathBuf::from(requested);
    if requested.len() > 32768 || requested.contains('\0') || !path.is_absolute() || !path.is_dir()
    {
        return Err("choose an existing absolute execution directory".into());
    }
    let path = observed(Some(path))?;
    if let Some(declared) = declared {
        if observed(Some(declared))? != path {
            return Err("the adapter declares another execution directory; use its directory or update the entry point".into());
        }
    }
    Ok(Some(path))
}

pub fn directory(cfg: &AppConfig, declared: Option<PathBuf>) -> Result<Option<PathBuf>, String> {
    if declared.is_some() {
        return Ok(declared);
    }
    // Incomplete legacy launch plans have no selected help context yet.
    let Ok(key) = super::runtime_schema::runtime_key(cfg) else {
        return Ok(None);
    };
    let directory =
        super::runtime_schema::load_accepted(&super::registry::root(), &key.engine, &key.runtime)?
            .and_then(|accepted| accepted.working_directory);
    if directory
        .as_ref()
        .is_some_and(|path| !path.is_absolute() || !path.is_dir())
    {
        return Err("the reviewed execution directory is missing or invalid; choose a working directory and review the runtime again".into());
    }
    Ok(directory)
}
