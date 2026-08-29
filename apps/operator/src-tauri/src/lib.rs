use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioInput {
    name: String,
    is_default: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapConnection {
    processor_url: Option<String>,
    processor_token: Option<String>,
    audio_device_label: Option<String>,
}

#[tauri::command]
fn bootstrap_connection(app: tauri::AppHandle) -> BootstrapConnection {
    let persisted = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|directory| std::fs::read_to_string(directory.join("connection.env")).ok());
    let persisted_value = |key: &str| {
        persisted.as_deref().and_then(|contents| {
            contents.lines().find_map(|line| {
                line.strip_prefix(&format!("{key}="))
                    .map(ToOwned::to_owned)
            })
        })
    };
    BootstrapConnection {
        processor_url: std::env::var("MULTILINGUUM_PROCESSOR_URL")
            .ok()
            .or_else(|| persisted_value("PROCESSOR_URL")),
        processor_token: std::env::var("MULTILINGUUM_PROCESSOR_TOKEN")
            .ok()
            .or_else(|| persisted_value("PROCESSOR_TOKEN")),
        audio_device_label: persisted_value("AUDIO_DEVICE_LABEL"),
    }
}

#[tauri::command]
fn list_audio_inputs() -> Result<Vec<AudioInput>, String> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|device| device.name().ok());
    let devices = host.input_devices().map_err(|error| error.to_string())?;
    devices
        .map(|device| {
            let name = device.name().map_err(|error| error.to_string())?;
            Ok(AudioInput {
                is_default: default_name.as_deref() == Some(name.as_str()),
                name,
            })
        })
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            bootstrap_connection,
            list_audio_inputs
        ])
        .run(tauri::generate_context!())
        .expect("error while running Multilinguum operator console");
}
