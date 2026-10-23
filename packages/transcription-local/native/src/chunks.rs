// Long audio is decoded in pieces cut at pauses: Cohere decodes at most 512
// tokens in one run, so one run over minutes of speech drops most of its words.
// The cut plan is Handy's (src-tauri/src/audio_toolkit/chunking.rs, MIT),
// applied to a whole clip.

use std::iter;
use std::ops::Range;
use transcribe_cpp::{VadOptions, VadSegment, VadSession};

pub const RATE: usize = 16_000;
const TARGET_SECONDS: f64 = 30.0;
const MAX_CHUNK_SAMPLES: usize = 40 * RATE;
const MIN_CHUNK_SAMPLES: usize = 5 * RATE;

// Audio of 40 s or less is one chunk and is never scored.
pub fn chunks(vad: &mut VadSession, pcm: &[f32]) -> transcribe_cpp::Result<Vec<Range<usize>>> {
    let cuts = if pcm.len() <= MAX_CHUNK_SAMPLES {
        Vec::new()
    } else {
        let segments = vad.run(pcm, &VadOptions::default())?.segments;
        plan_cuts(&pauses(&segments, pcm.len()), pcm.len())
    };
    let mut start = 0;
    let mut chunks = Vec::new();
    for cut in cuts.into_iter().chain(iter::once(pcm.len())) {
        chunks.push(start..cut);
        start = cut;
    }
    Ok(chunks)
}

struct Pause {
    cut: usize,
    seconds: f64,
}

// One cut in the middle of each pause, the lead-in and the tail included.
fn pauses(segments: &[VadSegment], samples: usize) -> Vec<Pause> {
    let mut pauses = Vec::new();
    let mut silence_start = 0;
    let speech = segments
        .iter()
        .map(|segment| (segment.start_sample as usize, segment.end_sample as usize))
        .chain(iter::once((samples, samples)));
    for (start, end) in speech {
        if start > silence_start {
            pauses.push(Pause {
                cut: (silence_start + start) / 2,
                seconds: (start - silence_start) as f64 / RATE as f64,
            });
        }
        silence_start = silence_start.max(end);
    }
    pauses
}

// Greedy, left to right: each cut is the best-scoring pause 5-40 s after the
// previous one, preferring long pauses near 30 s and ones that leave at least
// 5 s after them. With no pause, it is a hard cut at 40 s, or halfway when that
// would leave under 5 s.
fn plan_cuts(pauses: &[Pause], samples: usize) -> Vec<usize> {
    let mut cuts = Vec::new();
    let mut start = 0;
    // Each window starts after the last, so earlier pauses never return.
    let mut first = 0;
    while samples - start > MAX_CHUNK_SAMPLES {
        while first < pauses.len() && pauses[first].cut < start + MIN_CHUNK_SAMPLES {
            first += 1;
        }
        // A pause that leaves under 5 s is only used when no other pause will do.
        let mut best: Option<(usize, f64)> = None;
        let mut fallback: Option<(usize, f64)> = None;
        for pause in pauses[first..]
            .iter()
            .take_while(|pause| pause.cut <= start + MAX_CHUNK_SAMPLES)
        {
            let position = (pause.cut - start) as f64 / RATE as f64;
            let off_target = if position > TARGET_SECONDS {
                0.1 * (position - TARGET_SECONDS)
            } else {
                0.05 * (TARGET_SECONDS - position)
            };
            let score = pause.seconds.min(1.0) - off_target;
            if samples - pause.cut >= MIN_CHUNK_SAMPLES && best.is_none_or(|(_, best)| score > best)
            {
                best = Some((pause.cut, score));
            }
            if fallback.is_none_or(|(_, fallback)| score > fallback) {
                fallback = Some((pause.cut, score));
            }
        }
        let hard_cut = if samples - start < MAX_CHUNK_SAMPLES + MIN_CHUNK_SAMPLES {
            start + (samples - start) / 2
        } else {
            start + MAX_CHUNK_SAMPLES
        };
        start = best.or(fallback).map_or(hard_cut, |(cut, _)| cut);
        cuts.push(start);
    }
    cuts
}
