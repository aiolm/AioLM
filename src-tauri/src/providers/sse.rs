//! Bounded, strict UTF-8 SSE framing shared by connection verification and serving measurements.

pub(crate) const EVENT_LIMIT: usize = 64 * 1024;

#[derive(Default)]
pub(crate) struct Framer {
    pending: Vec<u8>,
    data: String,
    has_data: bool,
    event_type: Option<String>,
    total: usize,
    skip_lf: bool,
    started: bool,
}

impl Framer {
    fn event(
        &mut self,
        emit: &mut impl FnMut(&str, Option<&str>) -> Result<bool, String>,
    ) -> Result<bool, String> {
        let stop = if self.has_data || self.event_type.as_deref() == Some("error") {
            emit(&self.data, self.event_type.as_deref())?
        } else {
            false
        };
        self.data.clear();
        self.has_data = false;
        self.event_type = None;
        Ok(stop)
    }

    fn line(
        &mut self,
        emit: &mut impl FnMut(&str, Option<&str>) -> Result<bool, String>,
    ) -> Result<bool, String> {
        let line = if self.started {
            self.pending.as_slice()
        } else {
            self.started = true;
            self.pending
                .strip_prefix(b"\xef\xbb\xbf")
                .unwrap_or(&self.pending)
        };
        let line = std::str::from_utf8(line).map_err(|_| "SSE stream is not UTF-8")?;
        if line.is_empty() {
            self.pending.clear();
            return self.event(emit);
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "data" => {
                let separator = usize::from(self.has_data);
                if self
                    .data
                    .len()
                    .saturating_add(separator)
                    .saturating_add(value.len())
                    > EVENT_LIMIT
                {
                    return Err("SSE event exceeds 64 KiB".into());
                }
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
            "event" => self.event_type = Some(value.to_owned()),
            _ => {} // Comments, IDs and retry hints are not completion data.
        }
        self.pending.clear();
        Ok(false)
    }

    /// The callback returns true at its application-level terminator. Bytes
    /// after that event are deliberately not consumed, even within this chunk.
    pub(crate) fn push(
        &mut self,
        chunk: &[u8],
        response_limit: usize,
        mut emit: impl FnMut(&str, Option<&str>) -> Result<bool, String>,
    ) -> Result<bool, String> {
        for &byte in chunk {
            self.total = self.total.saturating_add(1);
            if self.total > response_limit {
                return Err("SSE stream exceeds its response size limit".into());
            }
            if self.skip_lf && byte == b'\n' {
                self.skip_lf = false;
                continue;
            }
            self.skip_lf = false;
            if matches!(byte, b'\r' | b'\n') {
                let stop = self.line(&mut emit)?;
                self.skip_lf = byte == b'\r';
                if stop {
                    return Ok(true);
                }
            } else {
                self.pending.push(byte);
                if self.pending.len() > EVENT_LIMIT {
                    return Err("SSE line exceeds 64 KiB".into());
                }
            }
        }
        Ok(false)
    }
}
