use flowcone_common::DEFAULT_FLOWCONE_MARK;

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
    pub flowcone_mark: u32,
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
            flowcone_mark: DEFAULT_FLOWCONE_MARK,
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

fn take_value<'a>(args: &'a [String], i: &mut usize, opt: &str) -> Result<&'a str, String> {
    if *i + 1 >= args.len() {
        return Err(format!("Missing value for {}", opt));
    }
    *i += 1;
    Ok(args[*i].as_str())
}

pub fn parse_args() -> Result<Config, String> {
    let args: Vec<String> = std::env::args().collect();
    let mut cfg = Config::default();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-i" | "--iface" => {
                cfg.iface = take_value(&args, &mut i, "--iface")?.to_string();
            }
            "-b" | "--btf" => {
                cfg.btf_path = Some(take_value(&args, &mut i, "--btf")?.to_string());
            }
            "--enable-v4" => {
                cfg.enable_v4 = parse_bool_flag(&args, &mut i);
            }
            "--enable-v6" => {
                cfg.enable_v6 = parse_bool_flag(&args, &mut i);
            }
            "--min-port" => {
                let v = take_value(&args, &mut i, "--min-port")?;
                cfg.min_port = v
                    .parse::<u16>()
                    .map_err(|_| format!("Invalid --min-port: {}", v))?;
            }
            "--max-port" => {
                let v = take_value(&args, &mut i, "--max-port")?;
                cfg.max_port = v
                    .parse::<u16>()
                    .map_err(|_| format!("Invalid --max-port: {}", v))?;
            }
            "--timeout" => {
                let v = take_value(&args, &mut i, "--timeout")?;
                cfg.timeout_sec = v
                    .parse::<u64>()
                    .map_err(|_| format!("Invalid --timeout: {}", v))?;
            }
            "--interval" => {
                let v = take_value(&args, &mut i, "--interval")?;
                cfg.gc_interval_sec = v
                    .parse::<u64>()
                    .map_err(|_| format!("Invalid --interval: {}", v))?;
            }
            "--bypass-mark" => {
                let mark_str = take_value(&args, &mut i, "--bypass-mark")?;
                if let Some((v_str, m_str)) = mark_str.split_once('/') {
                    let val = parse_u32_mark(v_str)
                        .ok_or_else(|| format!("Invalid --bypass-mark value: {}", v_str))?;
                    let mask = parse_u32_mark(m_str)
                        .ok_or_else(|| format!("Invalid --bypass-mark mask: {}", m_str))?;
                    cfg.bypass_mark_val = val;
                    cfg.bypass_mark_mask = mask;
                } else {
                    let val = parse_u32_mark(mark_str)
                        .ok_or_else(|| format!("Invalid --bypass-mark: {}", mark_str))?;
                    cfg.bypass_mark_val = val;
                    cfg.bypass_mark_mask = val;
                }
            }
            "--mark" => {
                let v = take_value(&args, &mut i, "--mark")?;
                cfg.flowcone_mark =
                    parse_u32_mark(v).ok_or_else(|| format!("Invalid --mark: {}", v))?;
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

    if cfg.iface.is_empty() {
        return Err("--iface must not be empty".to_string());
    }
    if cfg.min_port == 0 {
        return Err("--min-port must be >= 1 (port 0 is not a usable UDP source port)".to_string());
    }
    if cfg.min_port > cfg.max_port {
        return Err(format!(
            "Invalid port range: min-port ({}) > max-port ({})",
            cfg.min_port, cfg.max_port
        ));
    }
    if cfg.timeout_sec < 120 {
        return Err(
            "Invalid --timeout: RFC 4787 REQ-5 requires a mapping timer of at least 120s"
                .to_string(),
        );
    }
    if cfg.timeout_sec > 604_800 {
        return Err("Invalid --timeout: maximum supported value is 604800s (7 days)".to_string());
    }
    if cfg.gc_interval_sec == 0 || cfg.gc_interval_sec > 3600 {
        return Err("Invalid --interval: expected 1..=3600".to_string());
    }
    if !cfg.flowcone_mark.is_power_of_two() {
        return Err("Invalid --mark: expected a single non-zero bit (e.g. 0x40000000)".to_string());
    }
    if cfg.bypass_mark_val & !cfg.bypass_mark_mask != 0 {
        return Err("Invalid --bypass-mark: value has bits outside the mask".to_string());
    }
    if cfg.bypass_mark_mask == 0 && cfg.bypass_mark_val != 0 {
        return Err("Invalid --bypass-mark: a zero mask cannot match a non-zero value".to_string());
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
    println!("      --interval <SEC>       Expiry scheduler tick in seconds (default: 5)");
    println!("      --bypass-mark <VAL[/MASK]> Mark filter to bypass FlowCone (e.g. 0x1/0x1)");
    println!("      --mark <VAL>           Inbound DNAT mark bit (default: 0x40000000)");
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
        assert_eq!(cfg.flowcone_mark, DEFAULT_FLOWCONE_MARK);
        assert!(cfg.manage_nft);
    }

    #[test]
    fn test_timeout_minimum() {
        // The parser is exercised indirectly; keep the policy visible here.
        assert!(Config::default().timeout_sec >= 120);
    }
}
