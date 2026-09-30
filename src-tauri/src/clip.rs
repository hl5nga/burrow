//! Pasting a clipboard image into a terminal: the image becomes a file on the
//! tab's host (this Mac, or a profile's host over the side channel) and the
//! path is what gets pasted — AI CLIs like Claude Code read images by path.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::remote;
use crate::store::Store;

/// Clipboard images older than this are removed on the next upload.
const KEEP_MINUTES: u32 = 24 * 60;

fn file_name() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("clip-{ms}.png")
}

/// Writes the pasteboard's PNG to `path` with AppleScript — the native
/// pasteboard, so no clipboard plugin and no permission prompt.
fn clipboard_png(path: &Path) -> Result<(), String> {
    let script = [
        "set f to open for access (POSIX file (item 1 of argv)) with write permission",
        "try",
        "write (the clipboard as «class PNGf») to f",
        "on error e",
        "close access f",
        "error e",
        "end try",
        "close access f",
    ];
    let mut cmd = Command::new("osascript");
    cmd.arg("-e").arg("on run argv");
    for line in script {
        cmd.arg("-e").arg(line);
    }
    let out = cmd
        .arg("-e")
        .arg("end run")
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if out.status.success() && size > 0 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())
    } else {
        let _ = std::fs::remove_file(path);
        Err("클립보드에 이미지가 없습니다".into())
    }
}

fn local_dir(store: &Store) -> Result<PathBuf, String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    let uid = std::fs::metadata(store.root())
        .map_err(|e| e.to_string())?
        .uid();
    let dir = PathBuf::from(format!("/tmp/burrow-{uid}"));
    let _ = std::fs::DirBuilder::new().mode(0o700).create(&dir);
    // /tmp is shared: refuse a directory someone else made.
    let meta = std::fs::symlink_metadata(&dir).map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.uid() != uid {
        return Err(format!("{}를 쓸 수 없습니다", dir.display()));
    }
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    Ok(dir)
}

fn prune_local(dir: &Path) {
    let cutoff = std::time::Duration::from_secs(u64::from(KEEP_MINUTES) * 60);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > cutoff);
        if old && name.to_string_lossy().starts_with("clip-") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Saves the clipboard image on the tab's host and returns the file's path.
/// `profile_id` None means this Mac.
#[tauri::command(async)]
pub fn clip_image_save(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: Option<String>,
) -> Result<String, String> {
    let dir = local_dir(&store)?;
    prune_local(&dir);
    let local = dir.join(file_name());
    clipboard_png(&local)?;
    let Some(id) = profile_id else {
        return Ok(local.display().to_string());
    };
    let profile = remote::load_profile(&store, &id)?;
    let bytes = std::fs::read(&local).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&local);
    let name = file_name();
    // One round trip: private dir, prune, stream the bytes in, print the path.
    let script = format!(
        "umask 077; d=/tmp/burrow-$(id -u); mkdir -p \"$d\" && chmod 700 \"$d\" && \
         [ -O \"$d\" ] || {{ echo \"$d is not ours\" >&2; exit 1; }}; \
         find \"$d\" -name 'clip-*' -mmin +{KEEP_MINUTES} -delete 2>/dev/null; \
         cat > \"$d/{name}\" && printf '%s\\n' \"$d/{name}\""
    );
    let out = remote::side_command(&store, &profile, &script, Some(&bytes))?;
    out.lines()
        .rev()
        .find(|l| l.ends_with(&name))
        .map(str::to_string)
        .ok_or_else(|| "원격 경로를 받지 못했습니다".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_plain_and_unique_enough() {
        let a = file_name();
        std::thread::sleep(std::time::Duration::from_millis(2));
        assert!(a.starts_with("clip-") && a.ends_with(".png"));
        assert_ne!(a, file_name());
        assert!(a
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.'));
    }

    #[test]
    fn pruning_removes_only_old_clips() {
        let dir = std::env::temp_dir().join(format!("bclip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("clip-1.png");
        let other = dir.join("notes.txt");
        let fresh = dir.join("clip-2.png");
        for p in [&old, &other, &fresh] {
            std::fs::write(p, b"x").unwrap();
        }
        let past = SystemTime::now() - std::time::Duration::from_secs(25 * 3600);
        for p in [&old, &other] {
            std::fs::File::options()
                .write(true)
                .open(p)
                .unwrap()
                .set_modified(past)
                .unwrap();
        }
        prune_local(&dir);
        assert!(!old.exists());
        assert!(other.exists() && fresh.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

/// Puts text on the system clipboard. Done natively because a copy triggered
/// by the native Edit menu arrives without a browser user gesture, and the
/// webview refuses `navigator.clipboard` / `execCommand("copy")` without one.
#[tauri::command]
pub fn clip_text_write(text: String) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    // pbcopy decodes stdin by the process locale: with a non-UTF-8 one the
    // Korean text lands on the clipboard as mojibake. LC_ALL beats every other
    // locale variable, so the app's own environment can't matter.
    let mut child = Command::new("pbcopy")
        .env("LC_ALL", "UTF-8")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("no stdin")?
        .write_all(text.as_bytes())
        .map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}
