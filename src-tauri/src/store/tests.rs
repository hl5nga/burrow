use super::*;
use std::os::unix::fs::MetadataExt;
use std::sync::atomic::AtomicU32;

static NEXT_DIR: AtomicU32 = AtomicU32::new(0);

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        let n = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("burrow-store-test-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        Self(dir)
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn sample_command(i: usize) -> Command {
    Command {
        id: format!("cmd-{i}"),
        name: format!("배포 {i}"),
        command: format!("npm run deploy -- --target {i}"),
        description: "프로덕션 배포".repeat(20),
        kind: CommandType::SshProfile,
        ssh_host: Some("home-laptop.tailnet.ts.net".into()),
        tmux_session: Some("burrow".into()),
        transport: Transport::Mosh,
        vpn_pre_connect: Some("tailscale up".into()),
    }
}

#[test]
fn missing_files_are_created_with_defaults_and_presets() {
    let root = TempRoot::new();
    let store = Store::open(root.0.clone()).unwrap();

    assert_eq!(store.load::<ConfigFile>().promotion_threshold, 5);
    assert_eq!(store.load::<GuardrailsFile>().rules.len(), 9);
    assert_eq!(store.load::<SecretsPatternsFile>().patterns.len(), 5);
    assert_eq!(store.load::<KeybindingsFile>().bindings.len(), 18);
    assert!(store.load::<CommandsFile>().commands.is_empty());
    assert!(store.stats().hosts.contains_key("local"));

    for name in [
        "commands.json",
        "config.json",
        "guardrails.json",
        "secrets-patterns.json",
        "keybindings.json",
        "stats.json",
    ] {
        let text = fs::read_to_string(root.0.join(name)).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["version"], CURRENT_VERSION, "{name}");
    }
    assert!(store.take_recoveries().is_empty());
}

#[test]
fn every_kind_round_trips_through_get_and_put() {
    let root = TempRoot::new();
    let store = Store::open(root.0.clone()).unwrap();

    for kind in [
        "commands",
        "stats",
        "config",
        "agent-patterns",
        "guardrails",
        "secrets-patterns",
        "keybindings",
    ] {
        let value = store.get_json(kind).unwrap();
        store.put_json(kind, value.clone()).unwrap();
        assert_eq!(store.get_json(kind).unwrap(), value, "{kind}");
    }

    let mut commands = store.load::<CommandsFile>();
    commands.commands.push(sample_command(1));
    store
        .put_json("commands", serde_json::to_value(&commands).unwrap())
        .unwrap();
    let reopened = Store::open(root.0.clone()).unwrap();
    assert_eq!(reopened.load::<CommandsFile>(), commands);

    assert!(store.get_json("nope").is_err());
    assert!(store
        .put_json(
            "config",
            serde_json::json!({ "promotionThreshold": "five" })
        )
        .is_err());
}

#[test]
fn a_corrupt_file_is_backed_up_and_recreated() {
    let root = TempRoot::new();
    fs::create_dir_all(&root.0).unwrap();
    let broken = "{ \"version\": 1, \"rules\": [ oops";
    fs::write(root.0.join("guardrails.json"), broken).unwrap();

    let store = Store::open(root.0.clone()).unwrap();
    assert_eq!(store.load::<GuardrailsFile>().rules.len(), 9);
    assert_eq!(
        fs::read_to_string(root.0.join("guardrails.json.bak")).unwrap(),
        broken
    );

    let recoveries = store.take_recoveries();
    assert_eq!(recoveries.len(), 1);
    assert!(recoveries[0].file.ends_with("guardrails.json"));
    assert!(store.take_recoveries().is_empty());
    // The recreated file parses on the next load, so no further recovery.
    store.load::<GuardrailsFile>();
    assert!(store.take_recoveries().is_empty());
}

#[test]
fn hand_edited_json_loads_despite_missing_and_unknown_fields() {
    let root = TempRoot::new();
    fs::create_dir_all(&root.0).unwrap();
    fs::write(
        root.0.join("commands.json"),
        r#"{
          "commands": [
            { "name": "테스트", "command": "npm test", "type": "shell", "myNote": "extra" },
            { "name": "집 노트북", "command": "", "type": "ssh-profile", "sshHost": "home" }
          ],
          "futureField": true
        }"#,
    )
    .unwrap();
    fs::write(root.0.join("config.json"), r#"{ "promotionThreshold": 3 }"#).unwrap();

    let store = Store::open(root.0.clone()).unwrap();
    let commands = store.load::<CommandsFile>().commands;
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0].name, "테스트");
    assert_eq!(commands[0].transport, Transport::Auto);
    assert_eq!(commands[1].kind, CommandType::SshProfile);
    assert_eq!(commands[1].ssh_host.as_deref(), Some("home"));

    let config = store.load::<ConfigFile>();
    assert_eq!(config.promotion_threshold, 3);
    assert_eq!(config.version, CURRENT_VERSION);
    assert!(store.take_recoveries().is_empty());
}

#[test]
fn stats_are_written_only_on_flush() {
    let root = TempRoot::new();
    let store = Store::open(root.0.clone()).unwrap();
    let on_disk = || fs::read_to_string(root.0.join("stats.json")).unwrap();
    let before = on_disk();

    store.update_stats(|s| {
        let local = s.hosts.entry("local".into()).or_default();
        *local.global.entry("git status".into()).or_default() += 1;
    });
    assert_eq!(on_disk(), before, "update_stats must not write immediately");

    store.flush_stats().unwrap();
    let saved: StatsFile = serde_json::from_str(&on_disk()).unwrap();
    assert_eq!(saved.hosts["local"].global["git status"], 1);

    // Nothing changed since the last flush: the file is left alone.
    fs::write(root.0.join("stats.json"), "sentinel").unwrap();
    store.flush_stats().unwrap();
    assert_eq!(on_disk(), "sentinel");
}

#[test]
fn files_and_directory_are_private() {
    let root = TempRoot::new();
    let store = Store::open(root.0.clone()).unwrap();
    store.load::<CommandsFile>();
    assert_eq!(fs::metadata(&root.0).unwrap().mode() & 0o777, 0o700);
    assert_eq!(
        fs::metadata(root.0.join("commands.json")).unwrap().mode() & 0o777,
        0o600
    );
}

#[test]
fn concurrent_writers_never_expose_a_partial_file() {
    let root = TempRoot::new();
    let store = Arc::new(Store::open(root.0.clone()).unwrap());
    let big = CommandsFile {
        version: CURRENT_VERSION,
        commands: (0..300).map(sample_command).collect(),
    };
    store.save(&big).unwrap();

    let writers: Vec<_> = (0..4)
        .map(|_| {
            let (store, big) = (Arc::clone(&store), big.clone());
            thread::spawn(move || {
                for _ in 0..40 {
                    store.save(&big).unwrap();
                }
            })
        })
        .collect();
    let reader = {
        let path = root.0.join("commands.json");
        thread::spawn(move || {
            for _ in 0..400 {
                let text = fs::read_to_string(&path).unwrap();
                serde_json::from_str::<CommandsFile>(&text).expect("partial file observed");
            }
        })
    };
    for w in writers {
        w.join().unwrap();
    }
    reader.join().unwrap();

    let leftovers: Vec<_> = fs::read_dir(&root.0)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "temp files left behind");
}

/// Child side of `killing_the_writer_mid_write_leaves_a_valid_file`.
#[test]
#[ignore]
fn crash_writer() {
    let Some(root) = std::env::var_os("BURROW_CRASH_ROOT") else {
        return;
    };
    let store = Store::open(PathBuf::from(root)).unwrap();
    let big = CommandsFile {
        version: CURRENT_VERSION,
        commands: (0..2000).map(sample_command).collect(),
    };
    loop {
        store.save(&big).unwrap();
    }
}

#[test]
fn killing_the_writer_mid_write_leaves_a_valid_file() {
    let root = TempRoot::new();
    for round in 0..5 {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store::tests::crash_writer",
                "--ignored",
                "--nocapture",
            ])
            .env("BURROW_CRASH_ROOT", &root.0)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        thread::sleep(Duration::from_millis(300 + round * 70));
        child.kill().unwrap(); // SIGKILL: no chance to clean up
        child.wait().unwrap();

        let text = fs::read_to_string(root.0.join("commands.json")).unwrap();
        let file: CommandsFile = serde_json::from_str(&text).expect("file corrupted by a crash");
        assert!(file.commands.is_empty() || file.commands.len() == 2000);
    }
}
