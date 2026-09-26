//! Read-only file browsing for the folder panel and document viewer: list a
//! directory and read a file, on this Mac or on a profile's host over the SSH
//! side channel. There is deliberately no write, rename or delete here.

use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use serde::Serialize;

use crate::remote;
use crate::store::Store;

/// Bigger files aren't previewed: pulling them over SSH isn't worth it.
pub const MAX_PREVIEW: u64 = 2 * 1024 * 1024;
/// A NUL byte in the first bytes means binary.
const SNIFF: usize = 8192;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    dir: bool,
    link: bool,
    size: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum FileContent {
    Text { text: String, size: u64 },
    TooLarge { size: u64 },
    Binary { size: u64 },
}

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn check_path(path: &str) -> Result<(), String> {
    if path.starts_with('/') && !path.contains(['\0', '\n']) {
        Ok(())
    } else {
        Err(format!("절대 경로가 아닙니다: {path}"))
    }
}

fn sort(mut entries: Vec<Entry>) -> Vec<Entry> {
    entries.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

fn list_local(path: &str) -> Result<Vec<Entry>, String> {
    let entries = std::fs::read_dir(path).map_err(|e| format!("{path}: {e}"))?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let link = entry.file_type().map(|t| t.is_symlink()).unwrap_or(false);
        // Follow links for the kind and size, like `ls -L` would.
        let meta = std::fs::metadata(entry.path()).ok();
        out.push(Entry {
            name: entry.file_name().to_string_lossy().into_owned(),
            dir: meta.as_ref().is_some_and(|m| m.is_dir()),
            link,
            size: meta.map(|m| m.len()).unwrap_or(0),
        });
    }
    Ok(sort(out))
}

// GNU stat (Linux) and BSD stat (macOS) take different flags; both print
// "type|size|name" per entry, following symlinks (-L) for type and size.
const LIST_SCRIPT: &str = r#"cd -- "$1" || exit 3
set -- * .[!.]* ..?*
if stat -c %s / >/dev/null 2>&1; then fmt() { stat -L -c '%F|%s|%n' -- "$@"; }
else fmt() { stat -L -f '%HT|%z|%N' -- "$@"; }; fi
for f; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  if [ -L "$f" ]; then printf 'L'; fi
  fmt "$f" 2>/dev/null || printf 'broken|0|%s\n' "$f"
done
"#;

fn parse_listing(out: &str) -> Vec<Entry> {
    let entries = out
        .lines()
        .filter_map(|line| {
            let (link, line) = match line.strip_prefix('L') {
                // "L" + a type word: a type never starts with an uppercase L
                // in stat's output ("directory", "Directory", "regular file"...)
                // except "Link", which -L never reports.
                Some(rest) if rest.contains('|') => (true, rest),
                _ => (false, line),
            };
            let mut parts = line.splitn(3, '|');
            let kind = parts.next()?.to_lowercase();
            let size = parts.next()?.parse().unwrap_or(0);
            let name = parts.next()?.to_string();
            Some(Entry {
                name,
                dir: kind == "directory",
                link,
                size,
            })
        })
        .collect();
    sort(entries)
}

#[tauri::command(async)]
pub fn fs_list(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: Option<String>,
    path: String,
) -> Result<Vec<Entry>, String> {
    check_path(&path)?;
    match profile_id {
        None => list_local(&path),
        Some(id) => {
            let profile = remote::load_profile(&store, &id)?;
            let command = format!("sh -s -- {}", quote(&path));
            let out =
                remote::side_command(&store, &profile, &command, Some(LIST_SCRIPT.as_bytes()))
                    .map_err(|e| format!("{path}: {e}"))?;
            Ok(parse_listing(&out))
        }
    }
}

fn classify(bytes: Vec<u8>, size: u64) -> FileContent {
    if bytes[..bytes.len().min(SNIFF)].contains(&0) {
        return FileContent::Binary { size };
    }
    FileContent::Text {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        size,
    }
}

fn read_local(path: &Path) -> Result<FileContent, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("폴더입니다".into());
    }
    let size = meta.len();
    if size > MAX_PREVIEW {
        return Ok(FileContent::TooLarge { size });
    }
    let mut bytes = Vec::with_capacity(size as usize);
    std::fs::File::open(path)
        .and_then(|f| f.take(MAX_PREVIEW + 1).read_to_end(&mut bytes))
        .map_err(|e| e.to_string())?;
    Ok(classify(bytes, size))
}

/// Size first, so a huge file never comes over the wire.
fn read_script(path: &str) -> String {
    format!(
        "f={p}; [ -f \"$f\" ] || {{ echo 'burrow:not-a-file'; exit 0; }}; \
         s=$(wc -c < \"$f\" | tr -d ' '); echo \"burrow:size:$s\"; \
         if [ \"$s\" -le {MAX_PREVIEW} ]; then cat -- \"$f\"; fi",
        p = quote(path)
    )
}

#[tauri::command(async)]
pub fn fs_read(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: Option<String>,
    path: String,
) -> Result<FileContent, String> {
    check_path(&path)?;
    match profile_id {
        None => read_local(Path::new(&path)),
        Some(id) => {
            let profile = remote::load_profile(&store, &id)?;
            let script = read_script(&path);
            let out = remote::side_command(&store, &profile, &script, None)?;
            let (head, body) = out.split_once('\n').unwrap_or((&out, ""));
            if head == "burrow:not-a-file" {
                return Err("파일이 아닙니다".into());
            }
            let size = head
                .strip_prefix("burrow:size:")
                .and_then(|s| s.parse().ok())
                .ok_or("원격 파일 크기를 읽지 못했습니다")?;
            if size > MAX_PREVIEW {
                return Ok(FileContent::TooLarge { size });
            }
            Ok(classify(body.as_bytes().to_vec(), size))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_parses_both_stat_dialects() {
        let gnu = "directory|4096|src\nregular file|12|README.md\nLregular file|3|link.txt\nbroken|0|dead\n";
        let bsd = "Directory|128|src\nRegular File|12|a|b.md\n";
        let g = parse_listing(gnu);
        assert_eq!(
            g[0],
            Entry {
                name: "src".into(),
                dir: true,
                link: false,
                size: 4096
            }
        );
        assert!(g.iter().any(|e| e.name == "link.txt" && e.link && !e.dir));
        let b = parse_listing(bsd);
        assert!(b[0].dir);
        assert_eq!(b[1].name, "a|b.md", "names may contain the separator");
    }

    #[test]
    fn local_script_matches_std_listing() {
        let dir = std::env::temp_dir().join(format!("bfs-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("b.txt"), "hello").unwrap();
        std::fs::write(dir.join(".hidden"), "").unwrap();
        std::fs::write(dir.join("it's here.md"), "x").unwrap();
        std::os::unix::fs::symlink(dir.join("b.txt"), dir.join("ln")).unwrap();
        let out = std::process::Command::new("sh")
            .args(["-c", LIST_SCRIPT, "sh", dir.to_str().unwrap()])
            .output()
            .unwrap();
        let listed = parse_listing(&String::from_utf8_lossy(&out.stdout));
        assert_eq!(listed, list_local(dir.to_str().unwrap()).unwrap());
        assert_eq!(listed[0].name, "sub");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn remote_read_script_succeeds_for_large_files_without_sending_them() {
        let dir = std::env::temp_dir().join(format!("bfrs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let big = dir.join("it's big");
        std::fs::write(&big, vec![b'a'; MAX_PREVIEW as usize + 1]).unwrap();
        let out = std::process::Command::new("sh")
            .args(["-c", &read_script(big.to_str().unwrap())])
            .output()
            .unwrap();
        assert!(out.status.success());
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            format!("burrow:size:{}", MAX_PREVIEW + 1)
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_refuse_binary_and_large_files() {
        let dir = std::env::temp_dir().join(format!("bfr-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("t.md"), "# 제목\n").unwrap();
        std::fs::write(dir.join("b.bin"), [1u8, 0, 2]).unwrap();
        std::fs::write(dir.join("big"), vec![b'a'; MAX_PREVIEW as usize + 1]).unwrap();
        assert!(matches!(
            read_local(&dir.join("t.md")).unwrap(),
            FileContent::Text { .. }
        ));
        assert!(matches!(
            read_local(&dir.join("b.bin")).unwrap(),
            FileContent::Binary { .. }
        ));
        assert!(matches!(
            read_local(&dir.join("big")).unwrap(),
            FileContent::TooLarge { .. }
        ));
        assert!(check_path("relative").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
