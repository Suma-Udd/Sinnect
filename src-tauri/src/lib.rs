// The desktop shell. It opens the window, starts the engine (a small Node
// process that runs the Claude sessions) and tells the UI how to reach it.

use std::io::Write;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use rand::{distributions::Alphanumeric, Rng};
use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent};

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

/// Bring the window back to the front (from minimized or behind other apps).
#[cfg_attr(not(windows), allow(dead_code))]
fn bring_to_front(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Whether the user is looking at Sinnect right now.
fn window_in_front(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false) && w.is_visible().unwrap_or(true))
        .unwrap_or(false)
}

/// The id Windows knows this app by. The installer puts it on the Start menu
/// shortcut; a dev build isn't installed, so it borrows PowerShell's.
#[cfg(windows)]
fn toast_app_id(app: &tauri::AppHandle) -> String {
    let exe = std::env::current_exe().unwrap_or_default();
    let dev = exe.components().any(|c| c.as_os_str() == "target");
    if dev {
        tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    }
}

/// Show a Windows toast. Clicking it brings Sinnect back and tells the UI
/// which session it was about. Skipped while the window is in front, unless
/// `force` (the settings test button). Returns whether a toast was shown.
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String, session: Option<String>, force: Option<bool>) -> Result<bool, String> {
    if !force.unwrap_or(false) && window_in_front(&app) {
        return Ok(false);
    }
    #[cfg(windows)]
    {
        use tauri_winrt_notification::{Sound, Toast};
        let show = |id: &str| {
            let handle = app.clone();
            let session = session.clone();
            Toast::new(id)
                .title(&title)
                .text1(&body)
                .sound(Some(Sound::Default))
                .on_activated(move |_| {
                    bring_to_front(&handle);
                    let _ = handle.emit_to("main", "toast-click", session.clone());
                    Ok(())
                })
                .show()
        };
        let id = toast_app_id(&app);
        if show(&id).is_err() {
            // An id Windows doesn't know can be refused; PowerShell's always works.
            show(Toast::POWERSHELL_APP_ID).map_err(|e| e.to_string())?;
        }
        return Ok(true);
    }
    #[cfg(not(windows))]
    {
        let _ = (title, body, session);
        Err("native toasts are Windows only".into())
    }
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
        .invoke_handler(tauri::generate_handler![engine_info, stop_engine_for_update, notify])
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
