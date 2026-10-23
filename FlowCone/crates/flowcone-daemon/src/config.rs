#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub iface: String,
    pub btf_path: Option<String>,
    pub enable_v4: bool,
    pub enable_v6: bool,
    pub min_port: u16,
    pub max_port: u16,
    pub timeout_sec: u64,
    pub gc_interval_sec: u64,
    pub bypass_mark_mask: u32,
    pub bypass_mark_val: u32,
    pub manage_nft: bool,
    pub verbose: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            iface: "wan".to_string(),
            btf_path: None,
            enable_v4: true,
            enable_v6: false,
            min_port: 1024,
            max_port: 65535,
            timeout_sec: 120,
            gc_interval_sec: 5,
            bypass_mark_mask: 0,
            bypass_mark_val: 0,
            manage_nft: true,
            verbose: false,
        }
    }
}

pub fn parse_u32_mark(s: &str) -> Option<u32> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u32::from_str_radix(hex, 16).ok()
    } else {
        s.parse::<u32>().ok()
    }
}

fn parse_bool_flag(args: &[String], i: &mut usize) -> bool {
    if *i + 1 < args.len() {
        let next = args[*i + 1].as_str();
        if next == "0" || next == "false" || next == "off" || next == "no" {
            *i += 1;
            return false;
        }
        if next == "1" || next == "true" || next == "on" || next == "yes" {
            *i += 1;
            return true;
        }
    }
    true
}

pub fn parse_args() -> Result<Config, String> {
    let args: Vec<String> = std::env::args().collect();
    let mut cfg = Config::default();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-i" | "--iface" => {
                if i + 1 < args.len() {
                    cfg.iface = args[i + 1].clone();
                    i += 1;
                }
            }
            "-b" | "--btf" => {
                if i + 1 < args.len() {
                    cfg.btf_path = Some(args[i + 1].clone());
                    i += 1;
                }
            }
            "--enable-v4" => {
                cfg.enable_v4 = parse_bool_flag(&args, &mut i);
            }
            "--enable-v6" => {
                cfg.enable_v6 = parse_bool_flag(&args, &mut i);
            }
            "--min-port" => {
                if i + 1 < args.len() {
                    cfg.min_port = args[i + 1].parse().unwrap_or(1024);
                    i += 1;
                }
            }
            "--max-port" => {
                if i + 1 < args.len() {
                    cfg.max_port = args[i + 1].parse().unwrap_or(65535);
                    i += 1;
                }
            }
            "--timeout" => {
                if i + 1 < args.len() {
                    cfg.timeout_sec = args[i + 1].parse().unwrap_or(120);
                    i += 1;
                }
            }
            "--interval" => {
                if i + 1 < args.len() {
                    cfg.gc_interval_sec = args[i + 1].parse().unwrap_or(5);
                    i += 1;
                }
            }
            "--bypass-mark" => {
                if i + 1 < args.len() {
                    let mark_str = &args[i + 1];
                    if let Some((v_str, m_str)) = mark_str.split_once('/') {
                        let val = parse_u32_mark(v_str).unwrap_or(0);
                        let mask = parse_u32_mark(m_str).unwrap_or(val);
                        cfg.bypass_mark_val = val;
                        cfg.bypass_mark_mask = mask;
                    } else if let Some(val) = parse_u32_mark(mark_str) {
                        cfg.bypass_mark_val = val;
                        cfg.bypass_mark_mask = val;
                    }
                    i += 1;
                }
            }
            "--manage-nft" => {
                cfg.manage_nft = parse_bool_flag(&args, &mut i);
            }
            "-v" | "--verbose" => {
                cfg.verbose = true;
            }
            "-h" | "--help" => {
                print_help();
                std::process::exit(0);
            }
            arg => {
                return Err(format!("Unknown option: {}", arg));
            }
        }
        i += 1;
    }

    if cfg.min_port > cfg.max_port {
        return Err(format!(
            "Invalid port range: min-port ({}) > max-port ({})",
            cfg.min_port, cfg.max_port
        ));
    }

    Ok(cfg)
}

pub fn print_help() {
    println!("FlowCone — Dual-Stack RFC 4787 Full-Cone NAT for Linux");
    println!("Usage: flowcone [OPTIONS]");
    println!();
    println!("Options:");
    println!("  -i, --iface <IFACE>        WAN interface (default: wan)");
    println!("  -b, --btf <PATH>           Path to vmlinux BTF (optional, auto-detected)");
    println!("      --enable-v4 <1|0>      Enable IPv4 Full-Cone NAT (default: 1)");
    println!("      --enable-v6 <1|0>      Enable IPv6 Full-Cone NAT (auto-adaptive, default: 0)");
    println!("      --min-port <PORT>      Port pool start (default: 1024)");
    println!("      --max-port <PORT>      Port pool end (default: 65535)");
    println!("      --timeout <SEC>        Binding timeout in seconds (default: 120)");
    println!("      --interval <SEC>       GC sweep interval in seconds (default: 5)");
    println!("      --bypass-mark <VAL[/MASK]> Mark filter to bypass FlowCone (e.g. 0x1/0x1)");
    println!(
        "      --manage-nft <1|0>     Manage firewall nftables rules automatically (default: 1)"
    );
    println!("  -v, --verbose              Verbose output");
    println!("  -h, --help                 Show help");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_u32_mark() {
        assert_eq!(parse_u32_mark("0x4643"), Some(0x4643));
        assert_eq!(parse_u32_mark("0X100"), Some(0x100));
        assert_eq!(parse_u32_mark("1234"), Some(1234));
        assert_eq!(parse_u32_mark("invalid"), None);
    }

    #[test]
    fn test_default_config() {
        let cfg = Config::default();
        assert_eq!(cfg.iface, "wan");
        assert!(cfg.enable_v4);
        assert!(!cfg.enable_v6);
        assert_eq!(cfg.min_port, 1024);
        assert_eq!(cfg.max_port, 65535);
        assert!(cfg.manage_nft);
    }
}
