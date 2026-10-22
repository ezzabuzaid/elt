use clap::{Parser, ValueEnum};
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use transcribe_rs::onnx::{Quantization, canary::CanaryModel, cohere::CohereModel};
use transcribe_rs::{SpeechModel, TranscribeOptions};

#[derive(Clone, ValueEnum)]
enum Engine {
    Cohere,
    Canary,
}

#[derive(Parser)]
struct Args {
    #[arg(long)]
    engine: Engine,
    #[arg(long)]
    directory: PathBuf,
}

#[derive(Deserialize)]
struct Request {
    path: PathBuf,
    language: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Segment {
    text: String,
    start_second: f32,
    end_second: f32,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Response {
    Transcript {
        text: String,
        segments: Vec<Segment>,
    },
    Error {
        error: String,
    },
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let mut model: Box<dyn SpeechModel> = match args.engine {
        Engine::Cohere => Box::new(CohereModel::load(&args.directory, &Quantization::Int8)?),
        Engine::Canary => Box::new(CanaryModel::load(&args.directory, &Quantization::Int8)?),
    };
    let mut stdout = io::stdout().lock();
    // One request at a time keeps the model resident without overlapping inference.
    // EOF is the parent's shutdown request; dropping the model frees its weights.
    for line in io::stdin().lock().lines() {
        let request: Request = serde_json::from_str(&line?)?;
        let options = TranscribeOptions {
            language: request.language,
            ..Default::default()
        };
        let response = match model.transcribe_file(&request.path, &options) {
            Ok(result) => Response::Transcript {
                text: result.text,
                segments: result
                    .segments
                    .unwrap_or_default()
                    .into_iter()
                    .map(|segment| Segment {
                        text: segment.text,
                        start_second: segment.start,
                        end_second: segment.end,
                    })
                    .collect(),
            },
            Err(error) => Response::Error {
                error: error.to_string(),
            },
        };
        serde_json::to_writer(&mut stdout, &response)?;
        writeln!(stdout)?;
        stdout.flush()?;
    }
    Ok(())
}
