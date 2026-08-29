use std::sync::mpsc;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample, Stream, StreamConfig};
use serde::Serialize;
use tauri::{Emitter, Manager};

const TARGET_SAMPLE_RATE: u32 = 48_000;
const FRAME_SAMPLES: usize = 960;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioInput {
    name: String,
    is_default: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeAudioFrame {
    pcm: Vec<i16>,
    rms: f32,
    peak: f32,
    channel: usize,
    channel_count: usize,
    captured_at_unix_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeAudioConfig {
    device_name: String,
    sample_rate: u32,
    channel_count: u16,
}

enum AudioCommand {
    Start {
        app: tauri::AppHandle,
        device_name: Option<String>,
        reply: mpsc::Sender<Result<NativeAudioConfig, String>>,
    },
    Stop {
        reply: mpsc::Sender<Result<(), String>>,
    },
}

struct NativeAudioController {
    sender: mpsc::Sender<AudioCommand>,
}

impl NativeAudioController {
    fn new() -> Self {
        let (sender, receiver) = mpsc::channel::<AudioCommand>();
        thread::Builder::new()
            .name("multilinguum-coreaudio".to_string())
            .spawn(move || {
                // CoreAudio streams are thread-affine on macOS. Create, retain, and
                // drop the stream on this dedicated thread; only commands cross the
                // Tauri managed-state boundary.
                let mut active_stream: Option<Stream> = None;
                while let Ok(command) = receiver.recv() {
                    match command {
                        AudioCommand::Start {
                            app,
                            device_name,
                            reply,
                        } => {
                            active_stream.take();
                            let result = open_audio_input(app, device_name).map(
                                |(stream, config)| {
                                    active_stream = Some(stream);
                                    config
                                },
                            );
                            let _ = reply.send(result);
                        }
                        AudioCommand::Stop { reply } => {
                            active_stream.take();
                            let _ = reply.send(Ok(()));
                        }
                    }
                }
            })
            .expect("failed to start CoreAudio controller thread");
        Self { sender }
    }
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

fn build_input_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    app: tauri::AppHandle,
) -> Result<Stream, String>
where
    T: Sample + SizedSample,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels);
    let mut pending = Vec::<i16>::with_capacity(FRAME_SAMPLES * 2);
    let mut active_channel = 0usize;
    let error_app = app.clone();
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                if channels == 0 || data.len() < channels {
                    return;
                }
                let mut energy = vec![0.0f64; channels];
                for frame in data.chunks_exact(channels) {
                    for (index, sample) in frame.iter().enumerate() {
                        let value: f32 = sample.to_sample();
                        energy[index] += f64::from(value * value);
                    }
                }
                if let Some((index, _)) = energy
                    .iter()
                    .enumerate()
                    .max_by(|left, right| left.1.total_cmp(right.1))
                {
                    active_channel = index;
                }
                for frame in data.chunks_exact(channels) {
                    let value: f32 = frame[active_channel].to_sample();
                    pending.push((value.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16);
                }
                while pending.len() >= FRAME_SAMPLES {
                    let pcm: Vec<i16> = pending.drain(..FRAME_SAMPLES).collect();
                    let mut sum = 0.0f64;
                    let mut peak = 0.0f32;
                    for sample in &pcm {
                        let value = f32::from(*sample) / f32::from(i16::MAX);
                        sum += f64::from(value * value);
                        peak = peak.max(value.abs());
                    }
                    let rms = (sum / pcm.len() as f64).sqrt() as f32;
                    let captured_at_unix_ms = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|duration| duration.as_millis() as u64)
                        .unwrap_or_default();
                    let _ = app.emit(
                        "audio-input-frame",
                        NativeAudioFrame {
                            pcm,
                            rms,
                            peak,
                            channel: active_channel,
                            channel_count: channels,
                            captured_at_unix_ms,
                        },
                    );
                }
            },
            move |error| {
                let _ = error_app.emit("audio-input-error", error.to_string());
            },
            None,
        )
        .map_err(|error| error.to_string())
}

fn open_audio_input(
    app: tauri::AppHandle,
    device_name: Option<String>,
) -> Result<(Stream, NativeAudioConfig), String> {
    let host = cpal::default_host();
    let device = match device_name {
        Some(name) => host
            .input_devices()
            .map_err(|error| error.to_string())?
            .find(|device| device.name().ok().as_deref() == Some(name.as_str()))
            .ok_or_else(|| format!("Audio input not found: {name}"))?,
        None => host
            .default_input_device()
            .ok_or_else(|| "No default audio input is available.".to_string())?,
    };
    let name = device.name().map_err(|error| error.to_string())?;
    let supported = device
        .default_input_config()
        .map_err(|error| error.to_string())?;
    if supported.sample_rate().0 != TARGET_SAMPLE_RATE {
        return Err(format!(
            "{name} is running at {} Hz; set it to 48000 Hz in Audio MIDI Setup.",
            supported.sample_rate().0
        ));
    }
    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.into();
    let stream = match sample_format {
        cpal::SampleFormat::F32 => build_input_stream::<f32>(&device, &config, app)?,
        cpal::SampleFormat::I16 => build_input_stream::<i16>(&device, &config, app)?,
        cpal::SampleFormat::U16 => build_input_stream::<u16>(&device, &config, app)?,
        format => return Err(format!("Unsupported input sample format: {format}")),
    };
    stream.play().map_err(|error| error.to_string())?;
    Ok((
        stream,
        NativeAudioConfig {
            device_name: name,
            sample_rate: config.sample_rate.0,
            channel_count: config.channels,
        },
    ))
}

#[tauri::command]
fn start_audio_input(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeAudioController>,
    device_name: Option<String>,
) -> Result<NativeAudioConfig, String> {
    let (reply, response) = mpsc::channel();
    state
        .sender
        .send(AudioCommand::Start {
            app,
            device_name,
            reply,
        })
        .map_err(|error| error.to_string())?;
    response.recv().map_err(|error| error.to_string())?
}

#[tauri::command]
fn stop_audio_input(state: tauri::State<'_, NativeAudioController>) -> Result<(), String> {
    let (reply, response) = mpsc::channel();
    state
        .sender
        .send(AudioCommand::Stop { reply })
        .map_err(|error| error.to_string())?;
    response.recv().map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(NativeAudioController::new())
        .invoke_handler(tauri::generate_handler![
            bootstrap_connection,
            list_audio_inputs,
            start_audio_input,
            stop_audio_input
        ])
        .run(tauri::generate_context!())
        .expect("error while running Multilinguum operator console");
}
