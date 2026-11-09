use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

fn modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn newer_than_embedded(embedded: &Path, ebpf_dir: &Path, manifest: &Path) -> bool {
    let Some(embedded_time) = modified(embedded) else {
        return false;
    };
    [
        ebpf_dir.join("src/main.rs"),
        ebpf_dir.join("Cargo.toml"),
        manifest.join("../flowcone-common/src/lib.rs"),
    ]
    .iter()
    .filter_map(|path| modified(path))
    .any(|time| time > embedded_time)
}

fn main() {
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR not set");
    let dest = Path::new(&out_dir).join("flowcone-ebpf.bin");
    let manifest =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set"));
    let ebpf_dir = manifest.join("../flowcone-ebpf");
    let embedded = manifest.join("ebpf/flowcone-ebpf.bin");

    for path in [
        ebpf_dir.join("src"),
        manifest.join("../flowcone-common/src"),
        ebpf_dir.join("Cargo.toml"),
        manifest.join("../flowcone-common/Cargo.toml"),
        ebpf_dir.join(".cargo/config.toml"),
        embedded.clone(),
    ] {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    println!("cargo:rerun-if-env-changed=FLOWCONE_EBPF_PATH");

    if let Ok(value) = env::var("FLOWCONE_EBPF_PATH") {
        let path = PathBuf::from(value);
        if path.is_file() {
            fs::copy(&path, &dest).expect("copy eBPF from FLOWCONE_EBPF_PATH");
            return;
        }
        println!(
            "cargo:warning=FLOWCONE_EBPF_PATH is not a file: {}",
            path.display()
        );
    }

    if embedded.is_file() {
        if newer_than_embedded(&embedded, &ebpf_dir, &manifest) {
            println!(
                "cargo:warning=flowcone-ebpf sources are newer than the embedded binary; set FLOWCONE_EBPF_PATH to a fresh object or rebuild it"
            );
        }
        fs::copy(&embedded, &dest).expect("copy embedded eBPF binary");
        return;
    }

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
    .env_remove("CARGO_BUILD_TARGET")
    .env_remove("CARGO_TARGET_DIR");
    assert!(
        cmd.status().map(|s| s.success()).unwrap_or(false),
        "failed to build flowcone-ebpf"
    );

    let built = ebpf_dir.join("target/bpfel-unknown-none/release/flowcone-ebpf");
    fs::copy(&built, &dest).expect("copy built eBPF binary");
}
