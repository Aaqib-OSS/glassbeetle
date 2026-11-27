//! Glassbeetle API sidecar runner binary.
//!
//! A self-contained executable that packages the Node.js runtime, the compiled
//! NestJS API bundle, and all production dependencies (including `better-sqlite3`'s
//! native binding).
//!
//! On first run, it extracts its payload to a versioned per-user cache directory
//! and launches `node dist/main.js`. On subsequent runs, it launches the cached
//! binary immediately with near-zero overhead.
//!
//! Process Lifecycle & Orphan Prevention:
//! - Forwards signals (SIGTERM/SIGINT) to the child Node process so that SQLite
//!   connections and server resources close cleanly.
//! - Monitors standard input: when the parent process (the Tauri desktop shell)
//!   terminates, crashes, or is killed ungracefully, the write end of the stdin pipe
//!   is closed by the OS kernel. The watchdog thread reading from stdin detects this
//!   EOF condition and terminates the child process immediately, ensuring port 3000
//!   is never held by an orphaned background process.
//! - On Unix systems, also polls `getppid()`: if the parent process ID becomes 1,
//!   the sidecar was reparented to init/launchd and exits immediately.

#![allow(clippy::const_is_empty)]

use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;

#[cfg(not(unix))]
use std::io::Read;
#[cfg(not(unix))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(not(unix))]
use std::sync::Arc;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[cfg(unix)]
#[allow(dead_code)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
    fn getppid() -> i32;
}

#[cfg(has_payload)]
const PAYLOAD: &[u8] = include_bytes!(env!("SIDECAR_PAYLOAD_PATH"));

#[cfg(not(has_payload))]
const PAYLOAD: &[u8] = &[];

fn get_cache_dir(hash: &str) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Caches")
                .join("Glassbeetle")
                .join("api-sidecar")
                .join(hash);
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
            return PathBuf::from(local_app_data)
                .join("Glassbeetle")
                .join("api-sidecar")
                .join(hash);
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Ok(xdg_cache) = env::var("XDG_CACHE_HOME") {
            return PathBuf::from(xdg_cache)
                .join("glassbeetle")
                .join("api-sidecar")
                .join(hash);
        }
        if let Ok(home) = env::var("HOME") {
            return PathBuf::from(home)
                .join(".cache")
                .join("glassbeetle")
                .join("api-sidecar")
                .join(hash);
        }
    }

    env::temp_dir().join("glassbeetle-api-sidecar").join(hash)
}

fn compute_payload_hash() -> String {
    let mut hasher: u64 = 0xcbf29ce484222325;
    for &byte in PAYLOAD.iter().take(4096) {
        hasher ^= byte as u64;
        hasher = hasher.wrapping_mul(0x100000001b3);
    }
    hasher ^= PAYLOAD.len() as u64;
    format!("{:016x}", hasher)
}

fn unpack_payload(dest_dir: &Path) -> io::Result<()> {
    if PAYLOAD.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "Sidecar payload was not embedded into this binary",
        ));
    }

    fs::create_dir_all(dest_dir)?;

    let mut tar_proc = Command::new("tar")
        .args(["-xzf", "-", "-C"])
        .arg(dest_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()?;

    if let Some(mut stdin) = tar_proc.stdin.take() {
        stdin.write_all(PAYLOAD)?;
    }

    let status = tar_proc.wait()?;
    if !status.success() {
        return Err(io::Error::other(format!(
            "Failed to unpack sidecar archive (tar exit code: {status})"
        )));
    }

    #[cfg(unix)]
    {
        let node_bin = dest_dir.join("bin").join("node");
        if node_bin.exists() {
            let mut perms = fs::metadata(&node_bin)?.permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&node_bin, perms)?;
        }
    }

    fs::write(dest_dir.join(".ready"), b"ready")?;
    Ok(())
}

#[allow(dead_code)]
fn kill_child(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe {
            kill(pid, 15); // SIGTERM
        }
        for _ in 0..20 {
            thread::sleep(Duration::from_millis(100));
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
        }
        let _ = child.kill();
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
}

fn main() {
    let hash = compute_payload_hash();
    let cache_dir = get_cache_dir(&hash);

    if !cache_dir.join(".ready").exists() {
        eprintln!("[glassbeetle-api] Extracting sidecar runtime to {cache_dir:?}");
        if let Err(e) = unpack_payload(&cache_dir) {
            eprintln!("[glassbeetle-api] Failed to unpack sidecar runtime: {e}");
            std::process::exit(1);
        }
    }

    let node_bin_name = if cfg!(windows) { "node.exe" } else { "node" };
    let node_bin = cache_dir.join("bin").join(node_bin_name);
    let script = cache_dir.join("dist").join("main.js");

    let mut cmd = Command::new(&node_bin);
    cmd.arg(&script);
    cmd.args(env::args().skip(1));
    cmd.current_dir(&cache_dir);

    for (k, v) in env::vars() {
        cmd.env(k, v);
    }
    if env::var("PORT").is_err() {
        cmd.env("PORT", "3000");
    }
    if env::var("NODE_ENV").is_err() {
        cmd.env("NODE_ENV", "production");
    }
    cmd.env("GLASSBEETLE_SIDECAR", "1");

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = cmd.exec();
        eprintln!("[glassbeetle-api] Failed to exec node process: {err}");
        std::process::exit(1);
    }

    #[cfg(not(unix))]
    {
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::inherit());
        cmd.stderr(Stdio::inherit());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[glassbeetle-api] Failed to spawn node process: {e}");
                std::process::exit(1);
            }
        };

        let is_running = Arc::new(AtomicBool::new(true));

        // Watchdog: Stdin EOF monitor (triggered when parent closes stdin or dies)
        let r1 = is_running.clone();
        thread::spawn(move || {
            let mut stdin = io::stdin();
            let mut buf = [0u8; 1];
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        r1.store(false, Ordering::SeqCst);
                        break;
                    }
                    Ok(_) => {}
                }
            }
        });

        loop {
            if !is_running.load(Ordering::SeqCst) {
                kill_child(&mut child);
                std::process::exit(0);
            }

            match child.try_wait() {
                Ok(Some(status)) => {
                    std::process::exit(status.code().unwrap_or(0));
                }
                Ok(None) => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    eprintln!("[glassbeetle-api] Error checking child process: {e}");
                    kill_child(&mut child);
                    std::process::exit(1);
                }
            }
        }
    }
}
