//! Shapes of the JSON files under `~/.burrow`. Every struct tolerates missing
//! fields (`#[serde(default)]`) and unknown ones so hand-edited files still load.

use std::collections::HashMap;

use serde::{de::DeserializeOwned, Deserialize, Serialize};

pub const CURRENT_VERSION: u32 = 1;

fn current_version() -> u32 {
    CURRENT_VERSION
}

pub trait StoreFile: Serialize + DeserializeOwned + Default + Send + 'static {
    const FILE_NAME: &'static str;
}

// ---------- commands.json ----------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandType {
    #[default]
    Shell,
    SshProfile,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    #[default]
    Auto,
    Ssh,
    Mosh,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Command {
    pub id: String,
    pub name: String,
    pub command: String,
    pub description: String,
    #[serde(rename = "type")]
    pub kind: CommandType,
    pub ssh_host: Option<String>,
    pub tmux_session: Option<String>,
    pub transport: Transport,
    pub vpn_pre_connect: Option<String>,
    /// Run when the last tab using this VPN closes (T31). Optional — an empty
    /// value means Burrow never turns this VPN off on its own, only a
    /// profile the user explicitly filled this in for is auto-disconnected.
    pub vpn_post_disconnect: Option<String>,
    /// Networks where the host is reachable without the VPN (by router).
    pub home_networks: Vec<HomeNetwork>,
}

/// A network recognized by its router's hardware address: macOS hides the
/// Wi-Fi name from apps without location access, the gateway's MAC it doesn't,
/// and unlike a subnet like 192.168.1.x it isn't shared by other networks.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HomeNetwork {
    pub gateway_mac: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CommandsFile {
    #[serde(default = "current_version")]
    pub version: u32,
    pub commands: Vec<Command>,
}

impl Default for CommandsFile {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            commands: Vec::new(),
        }
    }
}

impl StoreFile for CommandsFile {
    const FILE_NAME: &'static str = "commands.json";
}

// ---------- stats.json ----------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HostStats {
    pub global: HashMap<String, u64>,
    pub by_dir: HashMap<String, HashMap<String, u64>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct StatsFile {
    #[serde(default = "current_version")]
    pub version: u32,
    pub hosts: HashMap<String, HostStats>,
}

impl Default for StatsFile {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            hosts: HashMap::from([("local".into(), HostStats::default())]),
        }
    }
}

impl StoreFile for StatsFile {
    const FILE_NAME: &'static str = "stats.json";
}

// ---------- config.json ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ConfigFile {
    #[serde(default = "current_version")]
    pub version: u32,
    pub promotion_threshold: u32,
    pub frequent_panel_open: bool,
    /// Copy a selection as soon as the mouse is released (Linux terminal habit).
    pub copy_on_select: bool,
    /// "local", or an ssh-profile id: skip the startup connection list and
    /// open this one directly. None shows the list.
    pub auto_open_id: Option<String>,
    /// Terminal text size, 1 (smallest) to 5 (largest); 3 is the default.
    /// The actual px values are a frontend concern (src/ui/text-settings.ts).
    pub font_level: u8,
    /// Terminal line spacing, 1 (tight) to 3 (loose); 2 is the default.
    pub line_level: u8,
    /// Color profile id ("dark", "light", "sky", "paper", "mono"); validated
    /// against the known set in the frontend (src/ui/theme-settings.ts), not
    /// here, so a new theme never needs a Rust change.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// UI language ("ko" or "en"). The frontend (src/i18n/index.ts) detects
    /// the OS/browser locale and writes it here the first time it ever
    /// loads config.json, so this Rust-side default is only a placeholder
    /// for the brief window before that happens.
    #[serde(default = "default_locale")]
    pub locale: String,
}

fn default_theme() -> String {
    "dark".into()
}

fn default_locale() -> String {
    "en".into()
}

impl Default for ConfigFile {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            promotion_threshold: 5,
            frequent_panel_open: true,
            copy_on_select: false,
            auto_open_id: None,
            font_level: 3,
            line_level: 2,
            theme: default_theme(),
            locale: default_locale(),
        }
    }
}

impl StoreFile for ConfigFile {
    const FILE_NAME: &'static str = "config.json";
}

// ---------- agent-patterns.json ----------

/// Screen-text regexes for one AI CLI. Nothing about a tool's wording lives
/// in code: when a CLI changes its UI, only this file needs editing.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentPattern {
    /// Name shown on the dashboard.
    pub label: String,
    /// First word of a command that starts this tool (from the exec hook).
    pub commands: Vec<String>,
    /// Screen text that identifies the tool when no exec event says so
    /// (inside tmux, or on hosts without hooks).
    pub detect: Vec<String>,
    pub waiting_approval: Vec<String>,
    pub working: Vec<String>,
    pub error: Vec<String>,
    /// The tool finished its turn and waits for the next instruction.
    pub idle: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentPatternsFile {
    #[serde(default = "current_version")]
    pub version: u32,
    /// Which generation of the built-in presets this file has absorbed. Files
    /// from before a newer generation get the new phrases added once (their own
    /// edits stay; a phrase deleted afterwards is not brought back).
    #[serde(default = "no_presets_yet", rename = "presetRevision")]
    pub preset_revision: u32,
    pub tools: HashMap<String, AgentPattern>,
}

/// Bump when agent-presets.json gains phrases users should get too.
pub const PRESET_REVISION: u32 = 2;

fn no_presets_yet() -> u32 {
    0
}

impl AgentPatternsFile {
    /// Adds every preset phrase the file doesn't have yet; true if anything changed.
    pub fn absorb_presets(&mut self) -> bool {
        if self.preset_revision >= PRESET_REVISION {
            return false;
        }
        for (id, preset) in agent_presets() {
            let Some(mine) = self.tools.get_mut(&id) else {
                self.tools.insert(id, preset);
                continue;
            };
            fn union(mine: &mut Vec<String>, preset: Vec<String>) {
                for phrase in preset {
                    if !mine.contains(&phrase) {
                        mine.push(phrase);
                    }
                }
            }
            union(&mut mine.commands, preset.commands);
            union(&mut mine.detect, preset.detect);
            union(&mut mine.waiting_approval, preset.waiting_approval);
            union(&mut mine.working, preset.working);
            union(&mut mine.error, preset.error);
            union(&mut mine.idle, preset.idle);
        }
        self.preset_revision = PRESET_REVISION;
        true
    }
}

/// Wording as of mid-2026; a best effort, meant to be edited. The same JSON
/// feeds the frontend's classifier tests.
pub fn agent_presets() -> HashMap<String, AgentPattern> {
    serde_json::from_str(include_str!("agent-presets.json")).expect("agent-presets.json is valid")
}

impl Default for AgentPatternsFile {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            preset_revision: PRESET_REVISION,
            tools: agent_presets(),
        }
    }
}

impl StoreFile for AgentPatternsFile {
    const FILE_NAME: &'static str = "agent-patterns.json";
}

// ---------- guardrails.json ----------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    #[default]
    Warn,
    Block,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct GuardrailRule {
    pub id: String,
    pub pattern: String,
    pub severity: Severity,
    pub label: String,
    pub enabled: bool,
}

impl Default for GuardrailRule {
    fn default() -> Self {
        Self {
            id: String::new(),
            pattern: String::new(),
            severity: Severity::Warn,
            label: String::new(),
            enabled: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct GuardrailsFile {
    #[serde(default = "current_version")]
    pub version: u32,
    pub rules: Vec<GuardrailRule>,
}

fn rule(id: &str, pattern: &str, severity: Severity, label: &str) -> GuardrailRule {
    GuardrailRule {
        id: id.into(),
        pattern: pattern.into(),
        severity,
        label: label.into(),
        enabled: true,
    }
}

impl Default for GuardrailsFile {
    fn default() -> Self {
        use Severity::{Block, Warn};
        // zsh `=~` uses POSIX ERE, so no \s, \b or lookarounds here.
        Self {
            version: CURRENT_VERSION,
            rules: vec![
                rule(
                    "preset-rm-rf-root-home",
                    r"rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*[[:space:]]+(/|~|\$HOME)([[:space:]]|/?$)",
                    Block,
                    "루트·홈 디렉토리 재귀 삭제",
                ),
                rule(
                    "preset-git-force-push",
                    r"git[[:space:]]+push([[:space:]].*)?[[:space:]](--force|-f)([[:space:]]|$)",
                    Block,
                    "git 강제 푸시",
                ),
                rule(
                    "preset-sql-drop",
                    r"[Dd][Rr][Oo][Pp][[:space:]]+([Tt][Aa][Bb][Ll][Ee]|[Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee])",
                    Warn,
                    "DB 테이블·데이터베이스 삭제",
                ),
                rule(
                    "preset-kubectl-delete-all",
                    r"kubectl[[:space:]]+delete([[:space:]].*)?[[:space:]]--all",
                    Block,
                    "kubectl 전체 삭제",
                ),
                rule(
                    "preset-mkfs",
                    r"(^|[[:space:];&|])mkfs",
                    Block,
                    "파일시스템 포맷",
                ),
                rule(
                    "preset-dd-device",
                    r"dd[[:space:]].*of=/dev/",
                    Block,
                    "디스크 장치에 직접 쓰기",
                ),
                rule(
                    "preset-chmod-777-root",
                    r"chmod[[:space:]]+-R[[:space:]]+777[[:space:]]+/([[:space:]]|$)",
                    Block,
                    "루트 전체 권한 개방",
                ),
                rule(
                    "preset-docker-prune-all",
                    r"docker[[:space:]]+system[[:space:]]+prune([[:space:]].*)?[[:space:]]-a",
                    Warn,
                    "Docker 이미지·컨테이너 전체 정리",
                ),
                rule(
                    "preset-terraform-destroy",
                    r"terraform[[:space:]]+destroy",
                    Block,
                    "Terraform 인프라 삭제",
                ),
                rule(
                    "preset-pipe-to-shell",
                    r"(curl|wget)[^|]*\|[[:space:]]*(sudo[[:space:]]+)?(ba|z)?sh([[:space:]]|$)",
                    Warn,
                    "받은 스크립트를 바로 셸로 실행",
                ),
            ],
        }
    }
}

impl StoreFile for GuardrailsFile {
    const FILE_NAME: &'static str = "guardrails.json";
}

// ---------- secrets-patterns.json ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SecretPattern {
    pub id: String,
    pub pattern: String,
    pub label: String,
    pub enabled: bool,
}

impl Default for SecretPattern {
    fn default() -> Self {
        Self {
            id: String::new(),
            pattern: String::new(),
            label: String::new(),
            enabled: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SecretsPatternsFile {
    #[serde(default = "current_version")]
    pub version: u32,
    pub patterns: Vec<SecretPattern>,
}

fn secret(id: &str, pattern: &str, label: &str) -> SecretPattern {
    SecretPattern {
        id: id.into(),
        pattern: pattern.into(),
        label: label.into(),
        enabled: true,
    }
}

impl Default for SecretsPatternsFile {
    fn default() -> Self {
        // Matched in the frontend with JavaScript regular expressions.
        Self {
            version: CURRENT_VERSION,
            patterns: vec![
                secret(
                    "preset-aws-access-key",
                    r"AKIA[0-9A-Z]{16}",
                    "AWS 액세스 키",
                ),
                secret(
                    "preset-github-token",
                    r"gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}",
                    "GitHub 토큰",
                ),
                secret(
                    "preset-slack-token",
                    r"xox[baprs]-[A-Za-z0-9-]{10,}",
                    "Slack 토큰",
                ),
                secret(
                    "preset-private-key",
                    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
                    "개인 키 블록",
                ),
                secret(
                    "preset-env-secret",
                    r"\b[A-Za-z0-9_]*(SECRET|TOKEN|PASSWORD|API_KEY|Secret|Token|Password|secret|token|password|api_key)[A-Za-z0-9_]*\s*=\s*\S+",
                    ".env 형식 비밀 값",
                ),
            ],
        }
    }
}

impl StoreFile for SecretsPatternsFile {
    const FILE_NAME: &'static str = "secrets-patterns.json";
}

// ---------- keybindings.json ----------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Keybinding {
    pub action: String,
    pub keys: String,
    pub disable_in_alt_screen: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct KeybindingsFile {
    #[serde(default = "current_version")]
    pub version: u32,
    pub bindings: Vec<Keybinding>,
}

fn bind(action: &str, keys: &str) -> Keybinding {
    Keybinding {
        action: action.into(),
        keys: keys.into(),
        disable_in_alt_screen: false,
    }
}

impl Default for KeybindingsFile {
    fn default() -> Self {
        let mut bindings = vec![
            bind("toggle-command-palette", "Cmd+K"),
            bind("toggle-frequent-panel", "Cmd+J"),
            bind("new-tab", "Cmd+T"),
            bind("close-tab", "Cmd+W"),
            bind("next-tab", "Cmd+Shift+]"),
            bind("previous-tab", "Cmd+Shift+["),
            bind("search-scrollback", "Cmd+F"),
            bind("open-command-manager", "Cmd+,"),
            bind("split-pane", "Cmd+D"),
            bind("toggle-agent-dashboard", "Cmd+Shift+A"),
            bind("copy", "Cmd+C"),
            bind("open-keybindings", "Cmd+/"),
            bind("toggle-file-browser", "Cmd+Shift+E"),
        ];
        bindings.extend((1..=9).map(|n| bind(&format!("select-tab-{n}"), &format!("Cmd+{n}"))));
        Self {
            version: CURRENT_VERSION,
            bindings,
        }
    }
}

impl StoreFile for KeybindingsFile {
    const FILE_NAME: &'static str = "keybindings.json";
}
