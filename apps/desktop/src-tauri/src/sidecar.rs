//! Management and lifecycle of the `@glassbeetle/api` Tauri sidecar.
//!
//! Spawns the self-contained API binary on application launch, monitors its
//! health on port 3000, detects port conflicts, and cleanly stops the child
//! process when the window or application closes.

use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

/// The default port the NestJS API listens on.
pub const DEFAULT_PORT: u16 = 3000;

/// Checks whether a TCP port is currently in use on loopback.
pub fn is_port_in_use(port: u16) -> bool {
    match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => {
            drop(listener);
            false
        }
        Err(err) => err.kind() == std::io::ErrorKind::AddrInUse,
    }
}

/// Sends a minimal HTTP probe to the API health endpoint.
///
/// Returns `true` if the server responds with HTTP 200 OK.
pub fn probe_health(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };

    stream
        .set_read_timeout(Some(Duration::from_millis(600)))
        .ok();
    stream
        .set_write_timeout(Some(Duration::from_millis(600)))
        .ok();

    let req = format!(
        "GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }

    let mut buf = [0u8; 256];
    if let Ok(n) = stream.read(&mut buf) {
        let resp = String::from_utf8_lossy(&buf[..n]);
        resp.contains("200 OK") || resp.contains("\"status\":\"ok\"")
    } else {
        false
    }
}

/// Resolves the target triple for the current host platform.
fn current_target_triple() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "x86_64-apple-darwin"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "x86_64-unknown-linux-gnu"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "aarch64-unknown-linux-gnu"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "x86_64-pc-windows-msvc"
    }
    #[cfg(not(any(
        all(
            target_os = "macos",
            any(target_arch = "aarch64", target_arch = "x86_64")
        ),
        all(
            target_os = "linux",
            any(target_arch = "aarch64", target_arch = "x86_64")
        ),
        all(target_os = "windows", target_arch = "x86_64")
    )))]
    {
        "unknown"
    }
}

/// Locates the `glassbeetle-api` binary on disk.
///
/// Checks:
/// 1. Alongside the current executable (packaged application layout).
/// 2. In `apps/desktop/src-tauri/binaries/` with the target-triple suffix (dev / build layout).
/// 3. Relative to the current working directory.
pub fn find_sidecar_binary() -> Result<PathBuf, String> {
    let binary_name = if cfg!(windows) {
        "glassbeetle-api.exe"
    } else {
        "glassbeetle-api"
    };

    let triple_binary_name = if cfg!(windows) {
        format!("glassbeetle-api-{}.exe", current_target_triple())
    } else {
        format!("glassbeetle-api-{}", current_target_triple())
    };

    // 1. Packaged location: next to the main executable
    if let Ok(current_exe) = env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            let candidate = parent.join(binary_name);
            if candidate.is_file() {
                return Ok(candidate);
            }
            let candidate_triple = parent.join(&triple_binary_name);
            if candidate_triple.is_file() {
                return Ok(candidate_triple);
            }
        }
    }

    // 2. Relative to working directory or repository roots
    let candidates = [
        PathBuf::from("binaries").join(&triple_binary_name),
        PathBuf::from("apps/desktop/src-tauri/binaries").join(&triple_binary_name),
        PathBuf::from("../binaries").join(&triple_binary_name),
        PathBuf::from("../../desktop/src-tauri/binaries").join(&triple_binary_name),
        PathBuf::from(binary_name),
    ];

    for candidate in &candidates {
        if candidate.is_file() {
            if let Ok(abs) = candidate.canonicalize() {
                return Ok(abs);
            }
            return Ok(candidate.clone());
        }
    }

    Err(format!(
        "Sidecar binary '{triple_binary_name}' was not found. \
         Run `npm run build:sidecar` or `npm run build:desktop` to compile it."
    ))
}

/// Manages the running sidecar process and guarantees cleanup on shutdown.
pub struct SidecarManager {
    child: Mutex<Option<Child>>,
    stopped: AtomicBool,
}

impl SidecarManager {
    /// Launches the sidecar binary and forwards logs.
    pub fn start(port: u16) -> Result<Self, String> {
        let binary_path = find_sidecar_binary()?;
        log::info!("Launching API sidecar from: {:?}", binary_path);

        let mut cmd = Command::new(&binary_path);
        cmd.env("PORT", port.to_string());
        cmd.env("NODE_ENV", "production");
        cmd.env("GLASSBEETLE_SIDECAR", "1");
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|err| format!("Failed to execute sidecar binary at {binary_path:?}: {err}"))?;

        // Forward stdout to logs
        if let Some(stdout) = child.stdout.take() {
            thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().map_while(Result::ok) {
                    log::info!("[API] {line}");
                }
            });
        }

        // Forward stderr to logs
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    log::warn!("[API] {line}");
                }
            });
        }

        Ok(Self {
            child: Mutex::new(Some(child)),
            stopped: AtomicBool::new(false),
        })
    }

    /// Stops the sidecar child process cleanly.
    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }

        let mut lock = match self.child.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };

        let Some(mut child) = lock.take() else {
            return;
        };

        log::info!("Terminating API sidecar process (pid: {})...", child.id());

        #[cfg(unix)]
        {
            let pid = child.id() as i32;
            unsafe {
                kill(pid, 15); // SIGTERM
            }

            // Wait up to 3 seconds for graceful shutdown
            let start = Instant::now();
            let mut exited = false;
            while start.elapsed() < Duration::from_secs(3) {
                if let Ok(Some(_)) = child.try_wait() {
                    exited = true;
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }

            if !exited {
                log::warn!("Sidecar did not exit after 3s; killing with SIGKILL");
                let _ = child.kill();
                let _ = child.wait();
            }
        }

        #[cfg(not(unix))]
        {
            let _ = child.kill();
            let _ = child.wait();
        }

        log::info!("API sidecar stopped.");
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.stop();
    }
}
