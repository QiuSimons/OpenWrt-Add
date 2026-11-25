use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, exit};

fn workspace_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .expect("Failed to get workspace root")
        .to_path_buf()
}

fn build_ebpf(release: bool) -> Result<(), Box<dyn std::error::Error>> {
    let root = workspace_root();
    let ebpf_dir = root.join("crates/flowcone-ebpf");
    let daemon_ebpf_dir = root.join("crates/flowcone-daemon/ebpf");
    let dest_bin = daemon_ebpf_dir.join("flowcone-ebpf.bin");

    let bpf_linker_check = Command::new("bpf-linker").arg("--version").output();
    if bpf_linker_check.is_err() {
        eprintln!("error: 'bpf-linker' not found in PATH.");
        eprintln!("Install it with: cargo install bpf-linker");
        exit(1);
    }

    println!(
        "flowcone-xtask: building flowcone-ebpf (release={})",
        release
    );

    let mut args = vec![
        "+nightly",
        "build",
        "--target=bpfel-unknown-none",
        "-Z",
        "build-std=core",
    ];
    if release {
        args.push("--release");
    }

    let status = Command::new("cargo")
        .args(&args)
        .current_dir(&ebpf_dir)
        .status()?;

    if !status.success() {
        eprintln!("error: cargo build failed for flowcone-ebpf");
        exit(1);
    }

    let profile = if release { "release" } else { "debug" };
    let artifact = ebpf_dir.join(format!("target/bpfel-unknown-none/{profile}/flowcone-ebpf"));

    if !artifact.is_file() {
        eprintln!(
            "error: compiled eBPF artifact not found at {}",
            artifact.display()
        );
        exit(1);
    }

    fs::create_dir_all(&daemon_ebpf_dir)?;
    fs::copy(&artifact, &dest_bin)?;

    let metadata = fs::metadata(&dest_bin)?;
    println!(
        "flowcone-xtask: updated {} ({} bytes)",
        dest_bin.display(),
        metadata.len()
    );

    Ok(())
}

fn print_help() {
    println!(
        "FlowCone xtask build scaffolding\n\n\
        Usage: cargo xtask <COMMAND>\n\n\
        Commands:\n  \
          build-ebpf   Build flowcone-ebpf using nightly compiler and update embedded binary\n  \
          help         Print this help message\n\n\
        Options for build-ebpf:\n  \
          --release    Build in release mode (default)"
    );
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let command = args.next();

    match command.as_deref() {
        Some("build-ebpf") => {
            let mut release = true;
            for arg in args {
                if arg == "--debug" {
                    release = false;
                } else if arg == "--release" {
                    release = true;
                }
            }
            build_ebpf(release)?;
        }
        Some("help") | Some("-h") | Some("--help") => {
            print_help();
        }
        Some(cmd) => {
            eprintln!("error: unknown command '{}'", cmd);
            print_help();
            exit(1);
        }
        None => {
            print_help();
        }
    }

    Ok(())
}
