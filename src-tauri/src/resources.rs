//! CPU/RAM samples for the corner chip, from this Mac or a profile's host.
//!
//! Remote samples go over the SSH side channel rather than the shell hooks:
//! a hook only runs at a prompt, so values would freeze during long jobs.

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Arc;

use serde::Serialize;

use crate::remote;
use crate::store::Store;

const SCRIPT: &str = include_str!("scripts/resources.sh");

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSample {
    /// Busy CPU over the sample second, 0–100 across all cores.
    pub cpu: f64,
    pub cores: u32,
    pub mem_used: u64,
    pub mem_total: u64,
}

fn parse(out: &str) -> Result<ResourceSample, String> {
    let mut sample = ResourceSample::default();
    let (mut cpu, mut total) = (false, false);
    for line in out.lines() {
        let Some((key, value)) = line
            .trim()
            .strip_prefix("burrow:")
            .and_then(|l| l.split_once(':'))
        else {
            continue;
        };
        match key {
            "cpu" => {
                sample.cpu = value
                    .parse::<f64>()
                    .map_err(|e| e.to_string())?
                    .clamp(0.0, 100.0);
                cpu = true;
            }
            "cores" => sample.cores = value.parse().unwrap_or(0),
            "mem-total" => {
                sample.mem_total = value
                    .parse()
                    .map_err(|_| format!("bad mem-total {value}"))?;
                total = true;
            }
            // awk prints big numbers in exponent form on some systems.
            "mem-used" => sample.mem_used = value.parse::<f64>().map(|v| v as u64).unwrap_or(0),
            _ => {}
        }
    }
    if cpu && total && sample.mem_total > 0 {
        Ok(sample)
    } else {
        Err("이 OS의 CPU/메모리 값을 읽지 못했습니다 (macOS·Linux만 지원)".into())
    }
}

fn sample_local() -> Result<String, String> {
    let mut child = Command::new("/bin/sh")
        .arg("-s")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("no stdin")?
        .write_all(SCRIPT.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `profile_id` None samples this Mac.
#[tauri::command(async)]
pub fn resource_sample(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: Option<String>,
) -> Result<ResourceSample, String> {
    let out = match profile_id {
        None => sample_local()?,
        Some(id) => {
            let profile = remote::load_profile(&store, &id)?;
            remote::side_command(&store, &profile, "sh -s", Some(SCRIPT.as_bytes()))?
        }
    };
    parse(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tagged_lines_among_noise() {
        let out = "Last login: today\nburrow:cpu:12.5\nburrow:cores:8\nburrow:mem-total:17179869184\nburrow:mem-used:1.11817e+10\n";
        let s = parse(out).unwrap();
        assert_eq!(s.cpu, 12.5);
        assert_eq!(s.cores, 8);
        assert_eq!(s.mem_total, 17179869184);
        assert_eq!(s.mem_used, 11181700000);
        assert!(parse("burrow:cores:8\n").is_err());
    }

    #[test]
    fn local_sample_is_plausible() {
        let s = parse(&sample_local().unwrap()).unwrap();
        assert!(s.cores > 0);
        assert!(s.mem_used > 0 && s.mem_used < s.mem_total, "{s:?}");
    }
}
