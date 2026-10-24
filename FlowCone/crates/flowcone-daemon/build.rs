use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

fn main() {
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR not set");
    let dest_path = Path::new(&out_dir).join("flowcone-ebpf.bin");

    if let Ok(custom_path) = env::var("FLOWCONE_EBPF_PATH") {
        let p = PathBuf::from(custom_path);
        if p.exists() {
            println!("cargo:rerun-if-changed={}", p.display());
            fs::copy(&p, &dest_path).expect("Failed to copy eBPF binary from FLOWCONE_EBPF_PATH");
            return;
        }
    }

    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set");
    let manifest_path = Path::new(&manifest_dir);

    // Newest artifact wins, so a plain `cargo build` cannot embed a stale
    // binary; the warning covers an edited but not rebuilt eBPF crate.
    println!("cargo:rerun-if-env-changed=FLOWCONE_EBPF_PATH");
    let ebpf_src = manifest_path.join("../flowcone-ebpf/src");
    println!("cargo:rerun-if-changed={}", ebpf_src.display());

    let candidates = [
        manifest_path.join("ebpf/flowcone-ebpf.bin"),
        manifest_path.join("../../target-build/bpfel-unknown-none/release/flowcone-ebpf"),
        manifest_path.join("../../target/bpfel-unknown-none/release/flowcone-ebpf"),
        manifest_path
            .join("../flowcone-ebpf/target-build/bpfel-unknown-none/release/flowcone-ebpf"),
        manifest_path.join("../flowcone-ebpf/target/bpfel-unknown-none/release/flowcone-ebpf"),
    ];

    let mut chosen: Option<(PathBuf, SystemTime)> = None;
    for candidate in &candidates {
        if let Ok(mtime) = fs::metadata(candidate).and_then(|m| m.modified())
            && chosen.as_ref().is_none_or(|(_, newest)| mtime > *newest)
        {
            chosen = Some((candidate.clone(), mtime));
        }
    }

    if let Some((path, mtime)) = chosen {
        if let Some(src_mtime) = newest_mtime(&ebpf_src) {
            // A checkout writes both within a second; only a real edit
            // clears the margin.
            if src_mtime > mtime + Duration::from_secs(60) {
                println!(
                    "cargo:warning={} is older than crates/flowcone-ebpf/src; rebuild it \
                     (cargo +nightly build --release --target=bpfel-unknown-none -Z build-std=core -p flowcone-ebpf) \
                     or set FLOWCONE_EBPF_PATH, otherwise this build embeds the stale binary",
                    path.display()
                );
            }
        }
        println!("cargo:rerun-if-changed={}", path.display());
        fs::copy(&path, &dest_path).expect("Failed to copy eBPF binary");
        return;
    }

    let ebpf_dir = manifest_path.join("../flowcone-ebpf");
    if ebpf_dir.join("Cargo.toml").exists() {
        println!(
            "cargo:warning=flowcone-ebpf binary not found, attempting automatic compilation..."
        );
        let mut cmd = Command::new("cargo");
        cmd.args([
            "+nightly",
            "build",
            "--release",
            "--target=bpfel-unknown-none",
            "-Z",
            "build-std=core",
        ])
        .current_dir(&ebpf_dir)
        .env_remove("RUSTFLAGS")
        .env_remove("CARGO_ENCODED_RUSTFLAGS")
        .env_remove("RUSTC")
        .env_remove("CARGO_BUILD_TARGET");

        if let Ok(status) = cmd.status()
            && status.success()
        {
            for candidate in &candidates {
                if candidate.exists() {
                    println!("cargo:rerun-if-changed={}", candidate.display());
                    fs::copy(candidate, &dest_path).expect("Failed to copy built eBPF binary");
                    return;
                }
            }
        }
    }

    panic!(
        "flowcone-ebpf binary not found. Please compile flowcone-ebpf for target bpfel-unknown-none first:\n\
         cargo +nightly build --release --target=bpfel-unknown-none -Z build-std=core -p flowcone-ebpf\n\
         Or specify FLOWCONE_EBPF_PATH=/path/to/flowcone-ebpf"
    );
}

/// Modification time of the newest file below `dir`.
fn newest_mtime(dir: &Path) -> Option<SystemTime> {
    let mut newest: Option<SystemTime> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let mtime = if path.is_dir() {
            newest_mtime(&path)
        } else {
            entry.metadata().ok().and_then(|m| m.modified().ok())
        };
        if let Some(mtime) = mtime {
            newest = Some(newest.map_or(mtime, |n| n.max(mtime)));
        }
    }
    newest
}
