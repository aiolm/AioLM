//! Bounded process diagnostics shared by runtime probes, builds and servers.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Retain {
    /// Version banners and help text are parsed from the beginning.
    Head,
    /// Failure diagnostics are usually at the end of a build or server log.
    Tail,
}

pub(crate) struct OutputBuffer {
    bytes: VecDeque<u8>,
    cap: usize,
    retain: Retain,
}

impl OutputBuffer {
    pub(crate) fn new(cap: usize, retain: Retain) -> Self {
        Self {
            bytes: VecDeque::new(),
            cap,
            retain,
        }
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) {
        match self.retain {
            Retain::Head => {
                let room = self.cap - self.bytes.len();
                self.bytes.extend(&chunk[..room.min(chunk.len())]);
            }
            Retain::Tail => {
                if chunk.len() >= self.cap {
                    self.bytes.clear();
                    self.bytes.extend(&chunk[chunk.len() - self.cap..]);
                } else {
                    let room = self.cap - chunk.len();
                    let excess = self.bytes.len().saturating_sub(room);
                    // Discarding the front of a deque does not shift the
                    // retained log on every pipe read. Trim before appending
                    // so an incoming chunk cannot temporarily exceed the cap.
                    self.bytes.drain(..excess);
                    self.bytes.extend(chunk);
                }
            }
        }
    }

    pub(crate) fn snapshot(&self) -> Vec<u8> {
        let (first, second) = self.bytes.as_slices();
        let mut bytes = Vec::with_capacity(self.bytes.len());
        bytes.extend_from_slice(first);
        bytes.extend_from_slice(second);
        bytes
    }

    pub(crate) fn clear(&mut self) {
        self.bytes.clear();
    }
}

/// A supervised reader shares its diagnostics so aborting a task at its join
/// deadline still preserves the output already collected.
pub(crate) type SharedLog = Arc<Mutex<OutputBuffer>>;

pub(crate) fn shared_log(cap: usize, retain: Retain) -> SharedLog {
    Arc::new(Mutex::new(OutputBuffer::new(cap, retain)))
}

pub(crate) fn read_log(log: &SharedLog) -> Vec<u8> {
    log.lock()
        .unwrap_or_else(|error| error.into_inner())
        .snapshot()
}

/// Always drain to EOF, including after the retention limit is reached. Closing
/// the pipe early can fail a writing child or leave it blocked on a full pipe.
pub(crate) async fn drain_stream_into<R>(mut reader: R, log: SharedLog)
where
    R: AsyncRead + Unpin,
{
    let mut chunk = vec![0_u8; 64 * 1024];
    loop {
        let read = match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        // The lock never spans an await, so an aborted task cannot strand it.
        log.lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(&chunk[..read]);
    }
}

pub(crate) async fn drain_stream<R>(reader: R, cap: usize, retain: Retain) -> Vec<u8>
where
    R: AsyncRead + Unpin,
{
    let log = shared_log(cap, retain);
    drain_stream_into(reader, log.clone()).await;
    read_log(&log)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_are_independent_of_pipe_chunk_boundaries() {
        let payload = (0..1003)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        for cap in [0, 1, 7, 64, 1024] {
            for chunk_size in [1, 3, 8, 64, 1003] {
                for retain in [Retain::Head, Retain::Tail] {
                    let mut log = OutputBuffer::new(cap, retain);
                    let mut consumed = 0;
                    for chunk in payload.chunks(chunk_size) {
                        log.push(chunk);
                        log.push(&[]);
                        consumed += chunk.len();
                        let expected = match retain {
                            Retain::Head => &payload[..cap.min(consumed)],
                            Retain::Tail => &payload[consumed.saturating_sub(cap)..consumed],
                        };
                        assert_eq!(
                            log.snapshot(),
                            expected,
                            "{retain:?}, cap {cap}, chunk {chunk_size}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn clearing_diagnostics_starts_a_fresh_log_with_the_same_retention() {
        for retain in [Retain::Head, Retain::Tail] {
            let mut log = OutputBuffer::new(8, retain);
            log.push(b"previous process output");
            log.clear();
            assert!(log.snapshot().is_empty());
            log.push(b"new process");
            assert_eq!(
                log.snapshot(),
                if retain == Retain::Head {
                    b"new proc"
                } else {
                    b" process"
                }
            );
        }
    }

    #[tokio::test]
    async fn a_zero_retention_limit_still_drains_the_entire_pipe() {
        use tokio::io::AsyncWriteExt;

        for retain in [Retain::Head, Retain::Tail] {
            let (reader, mut writer) = tokio::io::duplex(8);
            let drain = tokio::spawn(drain_stream(reader, 0, retain));
            writer
                .write_all(&[b'x'; 4096])
                .await
                .expect("drain a full pipe");
            drop(writer);
            assert!(drain.await.expect("reader completes").is_empty());
        }
    }
}
