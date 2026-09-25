//! zsh startup wrappers that add Burrow's command/prompt hooks without touching
//! the user's dotfiles. They are embedded in the binary and written next to the
//! store on every launch so they always match this build.

use std::fs;
use std::path::{Path, PathBuf};

pub const FILES: &[(&str, &str)] = &[
    (".zshenv", include_str!("../../shell/zsh/.zshenv")),
    (".zprofile", include_str!("../../shell/zsh/.zprofile")),
    (".zshrc", include_str!("../../shell/zsh/.zshrc")),
    (
        "burrow-hooks.zsh",
        include_str!("../../shell/zsh/burrow-hooks.zsh"),
    ),
];

/// Writes the wrappers into `<store root>/shell/zsh` and returns that directory.
pub fn install(store_root: &Path) -> std::io::Result<PathBuf> {
    let dir = store_root.join("shell").join("zsh");
    fs::create_dir_all(&dir)?;
    for (name, contents) in FILES {
        let path = dir.join(name);
        if fs::read_to_string(&path).ok().as_deref() != Some(*contents) {
            fs::write(&path, contents)?;
        }
    }
    Ok(dir)
}

/// Identifies this build's hook files, so an older copy on a remote host can be
/// detected (FNV-1a over names and contents; stable across Rust versions).
pub fn version() -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for (name, contents) in FILES {
        for byte in name.bytes().chain([0]).chain(contents.bytes()).chain([0]) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{hash:016x}")
}
