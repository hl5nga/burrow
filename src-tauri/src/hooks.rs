//! zsh startup wrappers that add Burrow's command/prompt hooks without touching
//! the user's dotfiles. They are embedded in the binary and written next to the
//! store on every launch so they always match this build.

use std::fs;
use std::path::{Path, PathBuf};

const FILES: &[(&str, &str)] = &[
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
