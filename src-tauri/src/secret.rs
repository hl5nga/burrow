//! Saved SSH passwords, kept in the macOS Keychain (service "Burrow SSH",
//! account = the profile id) — never in Burrow's own files. The webview can
//! ask whether one exists and delete it, but never read it back: only the
//! terminal session code in `pty.rs` fetches it, to answer ssh's prompt.

const SERVICE: &str = "Burrow SSH";

/// Debug builds only: `BURROW_FAKE_KEYCHAIN=<file>` keeps passwords in a JSON
/// file instead of the real Keychain, so the flow can be exercised without the
/// system's authorization prompts (which need someone at the screen).
#[cfg(debug_assertions)]
fn fake_store() -> Option<std::path::PathBuf> {
    std::env::var_os("BURROW_FAKE_KEYCHAIN")
        .filter(|v| !v.is_empty())
        .map(Into::into)
}

#[cfg(debug_assertions)]
fn fake_load(path: &std::path::Path) -> std::collections::HashMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
pub fn get(profile_id: &str) -> Option<String> {
    #[cfg(debug_assertions)]
    if let Some(path) = fake_store() {
        return fake_load(&path).get(profile_id).cloned();
    }
    let bytes = security_framework::passwords::get_generic_password(SERVICE, profile_id).ok()?;
    String::from_utf8(bytes).ok().filter(|p| !p.is_empty())
}

#[cfg(target_os = "macos")]
pub fn set(profile_id: &str, password: &str) -> Result<(), String> {
    #[cfg(debug_assertions)]
    if let Some(path) = fake_store() {
        let mut all = fake_load(&path);
        all.insert(profile_id.to_string(), password.to_string());
        return std::fs::write(&path, serde_json::to_string(&all).unwrap_or_default())
            .map_err(|e| e.to_string());
    }
    security_framework::passwords::set_generic_password(SERVICE, profile_id, password.as_bytes())
        .map_err(|e| format!("키체인에 저장하지 못했습니다: {e}"))
}

#[cfg(target_os = "macos")]
pub fn delete(profile_id: &str) {
    #[cfg(debug_assertions)]
    if let Some(path) = fake_store() {
        let mut all = fake_load(&path);
        all.remove(profile_id);
        let _ = std::fs::write(&path, serde_json::to_string(&all).unwrap_or_default());
        return;
    }
    let _ = security_framework::passwords::delete_generic_password(SERVICE, profile_id);
}

#[cfg(not(target_os = "macos"))]
pub fn get(_profile_id: &str) -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn set(_profile_id: &str, _password: &str) -> Result<(), String> {
    Err("비밀번호 저장은 macOS에서만 지원합니다".into())
}

#[cfg(not(target_os = "macos"))]
pub fn delete(_profile_id: &str) {}

/// Profile ids are generated UUIDs; anything else never reaches the Keychain.
fn valid_profile_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

// `async`: Keychain calls can wait on a system prompt and must never block the UI thread.
#[tauri::command(async)]
pub fn ssh_password_saved(profile_id: String) -> bool {
    valid_profile_id(&profile_id) && get(&profile_id).is_some()
}

#[tauri::command(async)]
pub fn ssh_password_clear(profile_id: String) -> Result<(), String> {
    if !valid_profile_id(&profile_id) {
        return Err("잘못된 프로필 id".into());
    }
    delete(&profile_id);
    Ok(())
}

/// Sends the password the user typed into the dialog to the waiting ssh
/// session, and keeps it in the Keychain if asked. The bytes go straight to the
/// pty — they are not part of the input trace.
#[tauri::command(async)]
pub fn ssh_password_provide(
    state: tauri::State<'_, crate::pty::PtyState>,
    id: u32,
    profile_id: String,
    password: String,
    save: bool,
) -> Result<(), String> {
    if !valid_profile_id(&profile_id) {
        return Err("잘못된 프로필 id".into());
    }
    if password.is_empty() || password.len() > 1024 || password.contains(['\n', '\r', '\0']) {
        return Err("사용할 수 없는 비밀번호입니다".into());
    }
    state.write_secret(id, format!("{password}\r").as_bytes())?;
    if save {
        set(&profile_id, &password)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_generated_profile_ids_reach_the_keychain() {
        assert!(valid_profile_id("a6832841-f491-43ec-b500-45563573716c"));
        for bad in ["", "short", "../../x", "a b c d e f g h", "ghijklmn"] {
            assert!(!valid_profile_id(bad), "{bad}");
        }
    }
}
