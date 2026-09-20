//! Owner recovery file format shared with the publishing service.
//!
//! Encoding: `aiolm-recovery-v1.` + base64url (no padding) of the UTF-8 JSON
//! `{version:1, origin:<normalized service origin>,
//! submission_id:<UUIDv4>, secret:<base64url 32 bytes>}`.
//! A recovered owner secret conveys exactly the original authority, never an
//! extra independent password. Both key and backup lost means no automatic
//! author recovery. Unknown fields, oversized files (>4096 bytes), invalid
//! secrets/UUIDs and unexpected service origins are rejected.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};

pub(crate) const RECOVERY_PREFIX: &str = "aiolm-recovery-v1.";
pub(crate) const MAX_RECOVERY_FILE_BYTES: usize = 4096;
pub(crate) const OWNER_SECRET_LEN: usize = 32;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveryPayload {
    version: u8,
    origin: String,
    submission_id: String,
    secret: String,
}

/// Validated owner material decoded from a recovery file or string.
pub(crate) struct RecoveredOwner {
    pub origin: String,
    pub submission_id: String,
    pub secret: [u8; OWNER_SECRET_LEN],
}

/// Encode owner material into the portable recovery string.
pub(crate) fn encode_recovery(
    origin: &str,
    submission_id: &str,
    secret: &[u8; OWNER_SECRET_LEN],
) -> String {
    let payload = RecoveryPayload {
        version: 1,
        origin: origin.into(),
        submission_id: submission_id.into(),
        secret: URL_SAFE_NO_PAD.encode(secret),
    };
    format!(
        "{RECOVERY_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("recovery payload serializes"))
    )
}

/// Decode and strictly validate a recovery string. The caller additionally
/// checks `owner.origin` against the configured service origin.
pub(crate) fn decode_recovery(text: &str) -> Result<RecoveredOwner, String> {
    if text.len() > MAX_RECOVERY_FILE_BYTES {
        return Err("recovery data exceeds the size limit".into());
    }
    let encoded = text
        .trim()
        .strip_prefix(RECOVERY_PREFIX)
        .ok_or("recovery data is not an AioLM owner backup")?;
    if encoded.is_empty() || encoded.len() > MAX_RECOVERY_FILE_BYTES {
        return Err("recovery data has an invalid size".into());
    }
    let json = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "recovery data is not valid base64url")?;
    // Reject noncanonical base64url the way the shared contracts decoder
    // does: trailing bits must re-encode to the identical string.
    if URL_SAFE_NO_PAD.encode(&json) != encoded {
        return Err("recovery data is not canonical base64url".into());
    }
    let payload: RecoveryPayload =
        serde_json::from_slice(&json).map_err(|_| "recovery data failed strict validation")?;
    if payload.version != 1 {
        return Err("recovery data has an unsupported version".into());
    }
    let origin_url = super::config::validate_base_url(&payload.origin)
        .map_err(|_| "recovery data names an invalid service origin")?;
    let origin = super::config::origin_of(&origin_url);
    validate_submission_id(&payload.submission_id)?;
    let secret_text = payload.secret.trim();
    let secret = URL_SAFE_NO_PAD
        .decode(secret_text)
        .map_err(|_| "recovery data holds an invalid owner secret")?;
    if secret.len() != OWNER_SECRET_LEN || URL_SAFE_NO_PAD.encode(&secret) != secret_text {
        return Err("recovery data holds an invalid owner secret".into());
    }
    let mut bytes = [0u8; OWNER_SECRET_LEN];
    bytes.copy_from_slice(&secret);
    Ok(RecoveredOwner {
        origin,
        submission_id: payload.submission_id,
        secret: bytes,
    })
}

/// Decode and strictly validate raw recovery file bytes.
pub(crate) fn decode_recovery_file(bytes: &[u8]) -> Result<RecoveredOwner, String> {
    if bytes.len() > MAX_RECOVERY_FILE_BYTES {
        return Err("recovery file exceeds the size limit".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "recovery file is not valid UTF-8")?;
    decode_recovery(text)
}

/// Submission ids are lowercase UUIDv4, matching the shared contracts
/// validator byte for byte.
pub(crate) fn validate_submission_id(submission_id: &str) -> Result<(), String> {
    let bytes = submission_id.as_bytes();
    let lowercase_hex = |byte: u8| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte);
    let valid = bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || lowercase_hex(*byte));
    if !valid || uuid::Uuid::parse_str(submission_id).is_err() {
        return Err("submission id is not a UUIDv4".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn fixture_secret() -> [u8; OWNER_SECRET_LEN] {
        let mut secret = [0u8; OWNER_SECRET_LEN];
        for (index, byte) in secret.iter_mut().enumerate() {
            *byte = (index as u8).wrapping_mul(37).wrapping_add(11);
        }
        secret
    }

    #[test]
    fn recovery_round_trip_is_stable() {
        let secret = fixture_secret();
        let encoded = encode_recovery(
            "https://benchmarks.example.test",
            "0196f9e2-7d2c-4b5e-9f1a-2b3c4d5e6f70",
            &secret,
        );
        assert!(encoded.starts_with(RECOVERY_PREFIX));
        let owner = decode_recovery(&encoded).unwrap();
        assert_eq!(owner.origin, "https://benchmarks.example.test");
        assert_eq!(owner.submission_id, "0196f9e2-7d2c-4b5e-9f1a-2b3c4d5e6f70");
        assert_eq!(owner.secret, secret);
        // Encoding is deterministic: the same material always yields the
        // same string, so website and native fixtures can be compared byte
        // for byte.
        assert_eq!(
            encoded,
            encode_recovery(
                "https://benchmarks.example.test",
                "0196f9e2-7d2c-4b5e-9f1a-2b3c4d5e6f70",
                &secret,
            )
        );
    }

    #[test]
    fn recovery_fixture_vector() {
        // Fixed vector both sides of the wire contract can assert against.
        let mut secret = [0u8; OWNER_SECRET_LEN];
        for (index, byte) in secret.iter_mut().enumerate() {
            *byte = index as u8 + 1;
        }
        let encoded = encode_recovery(
            "https://benchmarks.example.test",
            "123e4567-e89b-42d3-a456-426614174000",
            &secret,
        );
        let owner = decode_recovery(&encoded).unwrap();
        assert_eq!(owner.secret, secret);
        assert_eq!(owner.origin, "https://benchmarks.example.test");
    }

    #[test]
    fn recovery_agrees_with_the_shared_contracts_fixture() {
        // Byte-for-byte fixture exported in @aiolm/benchmark-contracts
        // (RECOVERY_FIXTURE): all-zero 32-byte secret, fixed UUIDv4.
        let expected = "aiolm-recovery-v1.eyJ2ZXJzaW9uIjoxLCJvcmlnaW4iOiJodHRwczovL2JlbmNobWFya3MuZXhhbXBsZS50ZXN0Iiwic3VibWlzc2lvbl9pZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsInNlY3JldCI6IkFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUEifQ";
        let owner = decode_recovery(expected).unwrap();
        assert_eq!(owner.origin, "https://benchmarks.example.test");
        assert_eq!(owner.submission_id, "00000000-0000-4000-8000-000000000001");
        assert_eq!(owner.secret, [0u8; OWNER_SECRET_LEN]);
        assert_eq!(
            encode_recovery(&owner.origin, &owner.submission_id, &owner.secret),
            expected
        );
    }

    #[test]
    fn recovery_rejects_noncanonical_base64url() {
        // 'AB' carries nonzero trailing bits decoding to the same byte as
        // 'AA'; the shared decoder rejects it and so must native code.
        assert!(decode_recovery("aiolm-recovery-v1.AB").is_err());
        // A 32-zero-byte secret encodes canonically to 43 'A's. Flipping the
        // last character to 'B' sets nonzero trailing bits while decoding to
        // identical bytes; strict decoding must still reject it.
        let mut noncanonical = "A".repeat(42);
        noncanonical.push('B');
        let payload = serde_json::json!({
            "version": 1,
            "origin": "https://benchmarks.example.test",
            "submission_id": "123e4567-e89b-42d3-a456-426614174000",
            "secret": noncanonical,
        });
        let encoded = format!(
            "{RECOVERY_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap())
        );
        assert!(decode_recovery(&encoded).is_err());
        let secret = fixture_secret();
        let valid = encode_recovery(
            "https://benchmarks.example.test",
            "123e4567-e89b-42d3-a456-426614174000",
            &secret,
        );
        // Padded encoding is rejected: canonical form has no padding.
        let padded = format!(
            "{RECOVERY_PREFIX}{}=",
            valid.strip_prefix(RECOVERY_PREFIX).unwrap()
        );
        assert!(decode_recovery(&padded).is_err());
        // Uppercase UUIDs disagree with the shared lowercase validator.
        let upper = encode_recovery(
            "https://benchmarks.example.test",
            "123E4567-E89B-42D3-A456-426614174000",
            &secret,
        );
        assert!(decode_recovery(&upper).is_err());
    }

    #[test]
    fn recovery_rejects_malformed_input() {
        let secret = fixture_secret();
        let valid = encode_recovery(
            "https://benchmarks.example.test",
            "123e4567-e89b-42d3-a456-426614174000",
            &secret,
        );
        assert!(decode_recovery("").is_err());
        assert!(decode_recovery("aiolm-recovery-v0.e30").is_err());
        assert!(decode_recovery("not-base64!!!").is_err());
        // Unknown fields are rejected.
        let mut payload: serde_json::Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(valid.strip_prefix(RECOVERY_PREFIX).unwrap())
                .unwrap(),
        )
        .unwrap();
        payload["extra"] = serde_json::json!("nope");
        let tampered = format!(
            "{RECOVERY_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap())
        );
        assert!(decode_recovery(&tampered).is_err());
        // Wrong version, non-v4 UUID, short secret and bad origin.
        for payload in [
            serde_json::json!({"version":2,"origin":"https://benchmarks.example.test","submission_id":"123e4567-e89b-42d3-a456-426614174000","secret":URL_SAFE_NO_PAD.encode(secret)}),
            serde_json::json!({"version":1,"origin":"https://benchmarks.example.test","submission_id":"not-a-uuid","secret":URL_SAFE_NO_PAD.encode(secret)}),
            serde_json::json!({"version":1,"origin":"https://benchmarks.example.test","submission_id":"6ba7b810-9dad-11d1-80b4-00c04fd430c8","secret":URL_SAFE_NO_PAD.encode(secret)}),
            serde_json::json!({"version":1,"origin":"https://benchmarks.example.test","submission_id":"123e4567-e89b-42d3-a456-426614174000","secret":URL_SAFE_NO_PAD.encode([1u8; 16])}),
            serde_json::json!({"version":1,"origin":"http://remote.example.test","submission_id":"123e4567-e89b-42d3-a456-426614174000","secret":URL_SAFE_NO_PAD.encode(secret)}),
        ] {
            let encoded = format!(
                "{RECOVERY_PREFIX}{}",
                URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap())
            );
            assert!(decode_recovery(&encoded).is_err(), "{payload}");
        }
        // Oversized files and non-UTF8 are rejected before parsing.
        assert!(decode_recovery_file(&vec![b'x'; MAX_RECOVERY_FILE_BYTES + 1]).is_err());
        assert!(decode_recovery_file(&[0xff, 0xfe]).is_err());
    }
}
