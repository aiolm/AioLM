//! Read only the dynamic dependency names needed by Linux runtime packaging.
//! This never executes a downloaded library or depends on a host `readelf`.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

const MAX_METADATA_BYTES: u64 = 16 * 1024 * 1024;
const MAX_NEEDED_LIBRARIES: usize = 4096;
const MAX_LIBRARY_NAME_BYTES: usize = 4096;

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid ELF dependency metadata",
    )
}

fn read_at(file: &mut File, offset: u64, size: u64) -> io::Result<Vec<u8>> {
    if size > MAX_METADATA_BYTES
        || offset.checked_add(size).ok_or_else(invalid)? > file.metadata()?.len()
    {
        return Err(invalid());
    }
    let mut bytes = vec![0; usize::try_from(size).map_err(|_| invalid())?];
    file.seek(SeekFrom::Start(offset))?;
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}

fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

/// Linux runtime targets use ELF64 little-endian. Non-ELF files are ignored,
/// while malformed/unsupported ELF files cannot make a bundle look complete.
pub(super) fn needed_libraries(path: &Path) -> io::Result<Vec<String>> {
    let mut file = File::open(path)?;
    let mut magic = [0; 4];
    if file.read(&mut magic)? != 4 || magic != *b"\x7fELF" {
        return Ok(Vec::new());
    }
    let header = read_at(&mut file, 0, 64)?;
    if header[4] != 2 || header[5] != 1 || header[6] != 1 {
        return Err(invalid());
    }
    let entry_size = u16::from_le_bytes([header[54], header[55]]) as u64;
    let count = u16::from_le_bytes([header[56], header[57]]) as u64;
    if entry_size < 56 || count == 0 || count == 0xffff {
        return Err(invalid());
    }
    let headers = read_at(&mut file, u64_at(&header, 32), entry_size * count)?;
    let mut loads = Vec::new();
    let mut dynamic = None;
    for entry in headers.chunks_exact(entry_size as usize) {
        let kind = u32::from_le_bytes(entry[..4].try_into().unwrap());
        let offset = u64_at(entry, 8);
        let address = u64_at(entry, 16);
        let size = u64_at(entry, 32);
        match kind {
            1 => loads.push((offset, address, size)),
            2 => dynamic = Some((offset, size)),
            _ => {}
        }
    }
    let Some((offset, size)) = dynamic else {
        return Ok(Vec::new());
    };
    if size % 16 != 0 {
        return Err(invalid());
    }
    let table = read_at(&mut file, offset, size)?;
    let mut needed = Vec::new();
    let mut strings_address = None;
    let mut strings_size = None;
    for entry in table.as_chunks::<16>().0 {
        let value = u64_at(entry, 8);
        match u64_at(entry, 0) {
            0 => break,
            1 => {
                if needed.len() == MAX_NEEDED_LIBRARIES {
                    return Err(invalid());
                }
                needed.push(value);
            }
            5 => strings_address = Some(value),
            10 => strings_size = Some(value),
            _ => {}
        }
    }
    if needed.is_empty() {
        return Ok(Vec::new());
    }
    let address = strings_address.ok_or_else(invalid)?;
    let size = strings_size.ok_or_else(invalid)?;
    let offset = loads
        .iter()
        .find_map(|(offset, start, length)| {
            let relative = address.checked_sub(*start)?;
            (relative.checked_add(size)? <= *length)
                .then(|| offset.checked_add(relative))
                .flatten()
        })
        .ok_or_else(invalid)?;
    if offset.checked_add(size).ok_or_else(invalid)? > file.metadata()?.len() {
        return Err(invalid());
    }
    // C++ libraries can have enormous dynamic symbol tables. Read only each
    // needed basename, not the unrelated symbols sharing that string table.
    needed
        .into_iter()
        .map(|index| {
            let remaining = size.checked_sub(index).ok_or_else(invalid)?;
            let bytes = read_at(
                &mut file,
                offset.checked_add(index).ok_or_else(invalid)?,
                remaining.min(MAX_LIBRARY_NAME_BYTES as u64 + 1),
            )?;
            let length = bytes
                .iter()
                .position(|byte| *byte == 0)
                .ok_or_else(invalid)?;
            let name = std::str::from_utf8(&bytes[..length]).map_err(|_| invalid())?;
            if name.is_empty() || name.contains(['/', '\\']) {
                return Err(invalid());
            }
            Ok(name.to_owned())
        })
        .collect()
}

#[cfg(test)]
pub(super) fn fixture(dependencies: &[&str]) -> Vec<u8> {
    let dynamic_offset = 64 + 2 * 56;
    let dynamic_size = (dependencies.len() + 3) * 16;
    let strings_offset = dynamic_offset + dynamic_size;
    let mut strings = vec![0];
    let mut indices = Vec::new();
    for dependency in dependencies {
        indices.push(strings.len() as u64);
        strings.extend_from_slice(dependency.as_bytes());
        strings.push(0);
    }
    let mut bytes = vec![0; strings_offset + strings.len()];
    bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
    bytes[32..40].copy_from_slice(&64_u64.to_le_bytes());
    bytes[54..56].copy_from_slice(&56_u16.to_le_bytes());
    bytes[56..58].copy_from_slice(&2_u16.to_le_bytes());
    bytes[64..68].copy_from_slice(&1_u32.to_le_bytes());
    let file_size = bytes.len() as u64;
    bytes[96..104].copy_from_slice(&file_size.to_le_bytes());
    bytes[120..124].copy_from_slice(&2_u32.to_le_bytes());
    bytes[128..136].copy_from_slice(&(dynamic_offset as u64).to_le_bytes());
    bytes[152..160].copy_from_slice(&(dynamic_size as u64).to_le_bytes());
    let entries = indices.into_iter().map(|index| (1_u64, index)).chain([
        (5, strings_offset as u64),
        (10, strings.len() as u64),
        (0, 0),
    ]);
    for (index, (tag, value)) in entries.enumerate() {
        let offset = dynamic_offset + index * 16;
        bytes[offset..offset + 8].copy_from_slice(&tag.to_le_bytes());
        bytes[offset + 8..offset + 16].copy_from_slice(&value.to_le_bytes());
    }
    bytes[strings_offset..].copy_from_slice(&strings);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn dependencies_are_read_without_loading_the_library() {
        let path = std::env::temp_dir().join(format!("aiolm-elf-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, fixture(&["libamdhip64.so.7", "libc.so.6"])).unwrap();
        assert_eq!(
            needed_libraries(&path).unwrap(),
            ["libamdhip64.so.7", "libc.so.6"]
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn large_symbol_tables_only_read_the_referenced_dependency_names() {
        let path = std::env::temp_dir().join(format!("aiolm-elf-{}", uuid::Uuid::new_v4()));
        let mut bytes = fixture(&["libamdhip64.so.7"]);
        let strings_offset = u64_at(&bytes, 200);
        let dependency_offset = MAX_METADATA_BYTES * 5;
        let name = b"libamdhip64.so.7\0";
        let strings_size = dependency_offset + name.len() as u64;
        let file_size = strings_offset + strings_size;
        bytes[96..104].copy_from_slice(&file_size.to_le_bytes());
        bytes[184..192].copy_from_slice(&dependency_offset.to_le_bytes());
        bytes[216..224].copy_from_slice(&strings_size.to_le_bytes());
        let mut file = File::create(&path).unwrap();
        file.write_all(&bytes).unwrap();
        file.set_len(file_size).unwrap();
        file.seek(SeekFrom::Start(strings_offset + dependency_offset))
            .unwrap();
        file.write_all(name).unwrap();
        drop(file);
        assert_eq!(needed_libraries(&path).unwrap(), ["libamdhip64.so.7"]);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn malformed_dependency_metadata_is_bounded_and_rejected() {
        let path = std::env::temp_dir().join(format!("aiolm-elf-{}", uuid::Uuid::new_v4()));
        let original = fixture(&["libamdhip64.so.7"]);
        let mut cases = vec![b"\x7fELF".to_vec(), fixture(&["../libamdhip64.so.7"])];
        cases.push(fixture(&vec!["librepeated.so"; MAX_NEEDED_LIBRARIES + 1]));
        cases.push(fixture(&[&"x".repeat(MAX_LIBRARY_NAME_BYTES + 1)]));
        for (offset, value) in [
            (32, u64::MAX),
            (152, MAX_METADATA_BYTES + 16),
            (184, u64::MAX),
        ] {
            let mut bytes = original.clone();
            bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
            cases.push(bytes);
        }
        let mut unterminated = original;
        *unterminated.last_mut().unwrap() = b'x';
        cases.push(unterminated);
        for bytes in cases {
            std::fs::write(&path, bytes).unwrap();
            assert!(needed_libraries(&path).is_err());
        }
        std::fs::remove_file(path).unwrap();
    }
}
