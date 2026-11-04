// The desktop shell. It opens the window, starts the engine (a small Node
// process that runs the Claude sessions) and tells the UI how to reach it.

use std::io::Write;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use rand::{distributions::Alphanumeric, Rng};
use serde::Serialize;
use tauri::{Manager, RunEvent};

/// Tiny startup trace in the temp folder, so a stuck launch can be diagnosed.
fn trace(msg: &str) {
    use std::io::Write as _;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("sinnect-start.log"))
    {
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = writeln!(f, "{t} {msg}");
    }
}

#[derive(Clone, Serialize)]
struct EngineInfo {
    port: u16,
    token: String,
}

struct EngineState {
    info: EngineInfo,
    child: Mutex<Option<Child>>,
}

#[tauri::command]
fn engine_info(state: tauri::State<EngineState>) -> EngineInfo {
    state.info.clone()
}

/// Called right before an update installs: the installer can't replace
/// node.exe while the engine is still running.
#[tauri::command]
fn stop_engine_for_update(state: tauri::State<EngineState>) {
    stop_engine(&state);
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(4317)
}

/// Windows sometimes hands out paths like \\?\C:\... which Node can't use.
fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy().into_owned();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p,
    }
}

/// Where the engine script and the Node binary live.
fn engine_paths(app: &tauri::App) -> (PathBuf, PathBuf) {
    if cfg!(debug_assertions) {
        // Development: system Node and the engine built in the repo.
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        return (PathBuf::from("node"), root.join("packages/engine/dist/engine.mjs"));
    }
    // Installed app: Node ships next to the exe, the engine in resources.
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();
    let node = exe_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let script = app
        .path()
        .resource_dir()
        .map(|d| d.join("engine").join("engine.mjs"))
        .unwrap_or_default();
    (plain(node), plain(script))
}

fn start_engine(app: &tauri::App, info: &EngineInfo) -> Option<Child> {
    let (node, script) = engine_paths(app);
    trace(&format!("engine node={} script={}", node.display(), script.display()));
    let data_dir = app.path().app_data_dir().ok().map(plain);
    let log = data_dir.as_ref().and_then(|d| {
        let _ = std::fs::create_dir_all(d);
        std::fs::File::create(d.join("engine.log")).ok()
    });
    if !node.exists() && node.is_absolute() {
        eprintln!("[sinnect] node not found at {}", node.display());
    }
    let mut cmd = Command::new(node);
    cmd.arg(script)
        .env("SINNECT_PORT", info.port.to_string())
        .env("SINNECT_TOKEN", &info.token)
        .env("SINNECT_PARENT_STDIN", "1")
        .stdin(Stdio::piped());
    if let Some(f) = log {
        if let Ok(f2) = f.try_clone() {
            cmd.stdout(Stdio::from(f)).stderr(Stdio::from(f2));
        }
    }
    if let Some(dir) = data_dir {
        cmd.env("SINNECT_DATA", dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.spawn() {
        Ok(child) => {
            trace("engine spawned");
            Some(child)
        }
        Err(err) => {
            trace(&format!("engine spawn failed: {err}"));
            eprintln!("[sinnect] could not start the engine: {err}");
            None
        }
    }
}

fn stop_engine(state: &EngineState) {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            // Closing stdin asks the engine to stop its sessions cleanly.
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.flush();
            }
            std::thread::sleep(std::time::Duration::from_millis(400));
            let _ = child.kill();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    trace(&format!("start cwd={:?}", std::env::current_dir().ok()));
    let token: String = rand::thread_rng().sample_iter(&Alphanumeric).take(32).map(char::from).collect();
    let info = EngineInfo { port: free_port(), token };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![engine_info, stop_engine_for_update])
        .setup(move |app| {
            trace("setup");
            let child = start_engine(app, &info);
            app.manage(EngineState { info: info.clone(), child: Mutex::new(child) });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Sinnect");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<EngineState>() {
                stop_engine(&state);
            }
        }
    });
}
