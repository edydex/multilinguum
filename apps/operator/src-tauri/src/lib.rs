use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioInput {
    name: String,
    is_default: bool,
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
        .invoke_handler(tauri::generate_handler![list_audio_inputs])
        .run(tauri::generate_context!())
        .expect("error while running Multilinguum operator console");
}
