//! Anonymous benchmark publishing: owner credentials, recovery and transport.
//!
//! The OS vault holds exactly one 32-byte owner secret per publication
//! (`submission_id`). A small durable registry binds each submission to its
//! exact request-body hash and service origin before any network attempt.
//! Ephemeral upload permits live only in process memory and are revoked when
//! a benchmark measurement starts. Secrets never leave native code: no
//! permit, owner secret or recovery string is ever returned to the WebView.

pub(crate) mod config;
pub(crate) mod errors;
pub(crate) mod guard;
pub(crate) mod permits;
pub(crate) mod recovery;
pub(crate) mod registry;
pub(crate) mod transport;
pub(crate) mod vault;
