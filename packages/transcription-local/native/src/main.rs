mod chunks;

use clap::Parser;
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::{env, fs, process};
use transcribe_cpp::{Model, RunOptions, Session, VadSession};

// Silero VAD v6.2 (MIT), the file Handy bundles, pinned to Handy's catalog hash.
static SILERO_VAD: &[u8] = include_bytes!("../silero-vad-v6.2-F32.gguf");

#[derive(Parser)]
struct Args {
    #[arg(long)]
    model: PathBuf,
    #[arg(long)]
    language: Option<String>,
}

#[derive(Deserialize)]
struct Request {
    path: PathBuf,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Response {
    Transcript { text: String },
    Error { error: String },
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = Args::parse();
    let mut session = Model::load(&args.model)?.session()?;
    let mut vad = load_vad()?;
    let options = RunOptions {
        language: args.language,
        ..Default::default()
    };
    let mut stdout = io::stdout().lock();
    // One request at a time keeps the model resident without overlapping inference.
    // EOF is the parent's shutdown request; dropping the session frees its weights.
    for line in io::stdin().lock().lines() {
        let request: Request = serde_json::from_str(&line?)?;
        let response =
            transcribe(&mut session, &mut vad, &request.path, &options).unwrap_or_else(|error| {
                Response::Error {
                    error: error.to_string(),
                }
            });
        serde_json::to_writer(&mut stdout, &response)?;
        writeln!(stdout)?;
        stdout.flush()?;
    }
    Ok(())
}

// The VAD ships inside this binary, so hosts copy one file. transcribe.cpp
// loads a model from a path, so the bytes pass through a file removed once
// loaded.
fn load_vad() -> Result<VadSession, Box<dyn Error>> {
    let path = env::temp_dir().join(format!("transcribe-local-vad-{}.gguf", process::id()));
    fs::write(&path, SILERO_VAD)?;
    let model = Model::load(&path);
    fs::remove_file(&path)?;
    Ok(model?.vad_session()?)
}

// The parent decodes audio to transcribe.cpp's input, 16 kHz mono 32-bit
// float samples, in a WAV file.
fn transcribe(
    session: &mut Session,
    vad: &mut VadSession,
    path: &Path,
    options: &RunOptions,
) -> Result<Response, Box<dyn Error>> {
    let pcm = hound::WavReader::open(path)?
        .into_samples::<f32>()
        .collect::<Result<Vec<_>, _>>()?;
    let mut texts = Vec::new();
    for chunk in chunks::chunks(vad, &pcm)? {
        // Cohere can skip words spoken in the first moment of its input, as
        // after a cut through a short pause, so each run starts with half a
        // second of silence.
        let mut input = vec![0.0; chunks::RATE / 2];
        input.extend_from_slice(&pcm[chunk]);
        texts.push(session.run(&input, options)?.text.trim().to_owned());
    }
    texts.retain(|text| !text.is_empty());
    Ok(Response::Transcript {
        text: texts.join(" "),
    })
}
