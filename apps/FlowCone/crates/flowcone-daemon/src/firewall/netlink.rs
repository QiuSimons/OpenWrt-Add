//! In-process Netfilter Netlink batch updates for nftables liveness sets.
//!
//! Replaces external `fork/exec /usr/sbin/nft` calls with atomic, in-process
//! Netlink messages (`NFT_MSG_NEWSETELEM`) to refresh keepalive timeouts.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use rustix::net::netlink::SocketAddrNetlink;
use rustix::net::{
    AddressFamily, Protocol, RecvFlags, SendFlags, SocketFlags, SocketType, bind, recv, send,
    socket_with, sockopt,
};

const NETLINK_NETFILTER: u32 = 12;
const NFNL_SUBSYS_NFTABLES: u8 = 10;
const NFNL_MSG_BATCH_BEGIN: u16 = 16;
const NFNL_MSG_BATCH_END: u16 = 17;
const NFT_MSG_NEWSETELEM: u16 = 12;
const NFT_MSG_DELSETELEM: u16 = 14;

const NLM_F_REQUEST: u16 = 0x01;
const NLM_F_ACK: u16 = 0x04;
const NLM_F_CREATE: u16 = 0x0400;
const NLA_F_NESTED: u16 = 0x8000;

const NFTA_SET_ELEM_LIST_TABLE: u16 = 1;
const NFTA_SET_ELEM_LIST_SET: u16 = 2;
const NFTA_SET_ELEM_LIST_ELEMENTS: u16 = 3;

const NFTA_SET_ELEM_KEY: u16 = 1;
const NFTA_SET_ELEM_FLAGS: u16 = 3;
const NFTA_SET_ELEM_TIMEOUT: u16 = 4;
const NFTA_DATA_VALUE: u16 = 1;

const NFT_SET_ELEM_INTERVAL_END: u32 = 1;
const NFPROTO_INET: u8 = 1;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub(crate) struct IpRange {
    pub(crate) start: [u8; 16],
    pub(crate) len: usize,
    pub(crate) end: Option<[u8; 16]>,
}

fn parse_v4_cidr(s: &str) -> Option<([u8; 4], Option<[u8; 4]>)> {
    let (ip_str, prefix_str) = s.split_once('/')?;
    let ip: Ipv4Addr = ip_str.parse().ok()?;
    let prefix: u32 = prefix_str.parse().ok()?;
    if prefix > 32 {
        return None;
    }
    let start = u32::from(ip);
    let host_bits = 32 - prefix;
    let end = if host_bits >= 32 {
        None
    } else {
        let next = start.wrapping_add(1u32 << host_bits);
        if next == 0 {
            None
        } else {
            Some(next.to_be_bytes())
        }
    };
    Some((start.to_be_bytes(), end))
}

fn parse_v6_cidr(s: &str) -> Option<([u8; 16], Option<[u8; 16]>)> {
    let (ip_str, prefix_str) = s.split_once('/')?;
    let ip: Ipv6Addr = ip_str.parse().ok()?;
    let prefix: u32 = prefix_str.parse().ok()?;
    if prefix > 128 {
        return None;
    }
    let start = u128::from(ip);
    let host_bits = 128 - prefix;
    let end = if host_bits >= 128 {
        None
    } else {
        let next = start.wrapping_add(1u128 << host_bits);
        if next == 0 {
            None
        } else {
            Some(next.to_be_bytes())
        }
    };
    Some((start.to_be_bytes(), end))
}

fn v4_range(cidr: &str) -> IpRange {
    let (start, end) = parse_v4_cidr(cidr).expect("valid v4 prefix");
    let mut s16 = [0u8; 16];
    s16[..4].copy_from_slice(&start);
    let e16 = end.map(|e| {
        let mut buf = [0u8; 16];
        buf[..4].copy_from_slice(&e);
        buf
    });
    IpRange {
        start: s16,
        len: 4,
        end: e16,
    }
}

fn v6_range(cidr: &str) -> IpRange {
    let (start, end) = parse_v6_cidr(cidr).expect("valid v6 prefix");
    IpRange {
        start,
        len: 16,
        end,
    }
}

pub(crate) struct NetlinkBatch {
    buf: Vec<u8>,
    seq: u32,
}

impl NetlinkBatch {
    pub(crate) fn new() -> Self {
        let mut batch = Self {
            buf: Vec::with_capacity(1024),
            seq: 1,
        };
        batch.push_batch_begin();
        batch
    }

    fn push_batch_begin(&mut self) {
        // nlmsghdr (16 bytes)
        self.buf.extend_from_slice(&20u32.to_ne_bytes());
        self.buf
            .extend_from_slice(&NFNL_MSG_BATCH_BEGIN.to_ne_bytes());
        self.buf.extend_from_slice(&NLM_F_REQUEST.to_ne_bytes());
        self.buf.extend_from_slice(&self.seq.to_ne_bytes());
        self.buf.extend_from_slice(&0u32.to_ne_bytes());
        // nfgenmsg (4 bytes): family=0, version=0, res_id=htons(NFNL_SUBSYS_NFTABLES)
        self.buf.push(0);
        self.buf.push(0);
        self.buf
            .extend_from_slice(&(NFNL_SUBSYS_NFTABLES as u16).to_be_bytes());
        self.seq += 1;
    }

    fn push_nla(&mut self, nla_type: u16, data: &[u8]) {
        let len = (4 + data.len()) as u16;
        self.buf.extend_from_slice(&len.to_ne_bytes());
        self.buf.extend_from_slice(&nla_type.to_ne_bytes());
        self.buf.extend_from_slice(data);
        let pad = (4 - (data.len() % 4)) % 4;
        self.buf.resize(self.buf.len() + pad, 0);
    }

    fn push_nla_str(&mut self, nla_type: u16, s: &str) {
        let mut bytes = s.as_bytes().to_vec();
        bytes.push(0);
        self.push_nla(nla_type, &bytes);
    }

    fn start_nested(&mut self, nla_type: u16) -> usize {
        let pos = self.buf.len();
        let placeholder_type = nla_type | NLA_F_NESTED;
        self.buf.extend_from_slice(&0u16.to_ne_bytes());
        self.buf.extend_from_slice(&placeholder_type.to_ne_bytes());
        pos
    }

    fn end_nested(&mut self, pos: usize) {
        let len = (self.buf.len() - pos) as u16;
        self.buf[pos..pos + 2].copy_from_slice(&len.to_ne_bytes());
        let pad = (4 - (self.buf.len() % 4)) % 4;
        self.buf.resize(self.buf.len() + pad, 0);
    }

    pub(crate) fn flush_set(&mut self, table: &str, set: &str) {
        let msg_start = self.buf.len();
        self.buf.resize(msg_start + 20, 0);

        self.push_nla_str(NFTA_SET_ELEM_LIST_TABLE, table);
        self.push_nla_str(NFTA_SET_ELEM_LIST_SET, set);

        let msg_len = (self.buf.len() - msg_start) as u32;
        let msg_type = ((NFNL_SUBSYS_NFTABLES as u16) << 8) | NFT_MSG_DELSETELEM;
        let flags = NLM_F_REQUEST;
        self.buf[msg_start..msg_start + 4].copy_from_slice(&msg_len.to_ne_bytes());
        self.buf[msg_start + 4..msg_start + 6].copy_from_slice(&msg_type.to_ne_bytes());
        self.buf[msg_start + 6..msg_start + 8].copy_from_slice(&flags.to_ne_bytes());
        self.buf[msg_start + 8..msg_start + 12].copy_from_slice(&self.seq.to_ne_bytes());
        self.buf[msg_start + 12..msg_start + 16].copy_from_slice(&0u32.to_ne_bytes());
        self.buf[msg_start + 16] = NFPROTO_INET;
        self.buf[msg_start + 17] = 0;
        self.buf[msg_start + 18] = 0;
        self.buf[msg_start + 19] = 0;

        self.seq += 1;
    }

    pub(crate) fn add_set_elements(
        &mut self,
        table: &str,
        set: &str,
        ranges: &[IpRange],
        timeout_ms: u64,
    ) {
        let msg_start = self.buf.len();
        self.buf.resize(msg_start + 20, 0);

        self.push_nla_str(NFTA_SET_ELEM_LIST_TABLE, table);
        self.push_nla_str(NFTA_SET_ELEM_LIST_SET, set);

        let elems_nest = self.start_nested(NFTA_SET_ELEM_LIST_ELEMENTS);
        let mut elem_idx: u16 = 1;

        for range in ranges {
            // Element 1: Start key + timeout
            let e1 = self.start_nested(elem_idx);
            self.push_nla(NFTA_SET_ELEM_TIMEOUT, &timeout_ms.to_be_bytes());
            let k1 = self.start_nested(NFTA_SET_ELEM_KEY);
            self.push_nla(NFTA_DATA_VALUE, &range.start[..range.len]);
            self.end_nested(k1);
            self.end_nested(e1);
            elem_idx += 1;

            // Element 2: Interval end key + flags (if present)
            if let Some(end_bytes) = range.end {
                let e2 = self.start_nested(elem_idx);
                self.push_nla(
                    NFTA_SET_ELEM_FLAGS,
                    &NFT_SET_ELEM_INTERVAL_END.to_be_bytes(),
                );
                let k2 = self.start_nested(NFTA_SET_ELEM_KEY);
                self.push_nla(NFTA_DATA_VALUE, &end_bytes[..range.len]);
                self.end_nested(k2);
                self.end_nested(e2);
                elem_idx += 1;
            }
        }

        self.end_nested(elems_nest);

        // Fill nlmsghdr (16 bytes) + nfgenmsg (4 bytes)
        let msg_len = (self.buf.len() - msg_start) as u32;
        let msg_type = ((NFNL_SUBSYS_NFTABLES as u16) << 8) | NFT_MSG_NEWSETELEM;
        let flags = NLM_F_REQUEST | NLM_F_CREATE;
        self.buf[msg_start..msg_start + 4].copy_from_slice(&msg_len.to_ne_bytes());
        self.buf[msg_start + 4..msg_start + 6].copy_from_slice(&msg_type.to_ne_bytes());
        self.buf[msg_start + 6..msg_start + 8].copy_from_slice(&flags.to_ne_bytes());
        self.buf[msg_start + 8..msg_start + 12].copy_from_slice(&self.seq.to_ne_bytes());
        self.buf[msg_start + 12..msg_start + 16].copy_from_slice(&0u32.to_ne_bytes());
        self.buf[msg_start + 16] = NFPROTO_INET;
        self.buf[msg_start + 17] = 0;
        self.buf[msg_start + 18] = 0;
        self.buf[msg_start + 19] = 0;

        self.seq += 1;
    }

    pub(crate) fn finish(mut self) -> Vec<u8> {
        self.buf.extend_from_slice(&20u32.to_ne_bytes());
        self.buf
            .extend_from_slice(&NFNL_MSG_BATCH_END.to_ne_bytes());
        self.buf
            .extend_from_slice(&(NLM_F_REQUEST | NLM_F_ACK).to_ne_bytes());
        self.buf.extend_from_slice(&self.seq.to_ne_bytes());
        self.buf.extend_from_slice(&0u32.to_ne_bytes());
        self.buf.push(0);
        self.buf.push(0);
        self.buf
            .extend_from_slice(&(NFNL_SUBSYS_NFTABLES as u16).to_be_bytes());
        self.buf
    }
}

/// Refresh liveness set timeouts via an in-process Netlink batch transaction.
pub(crate) fn refresh_liveness_netlink(
    table: &str,
    enable_v4: bool,
    enable_v6: bool,
    is_v6_masq: bool,
) -> Result<(), &'static str> {
    if !enable_v4 && !enable_v6 {
        return Ok(());
    }

    let timeout_ms = super::fw4::LIVENESS_TIMEOUT_SEC * 1000;
    let mut batch = NetlinkBatch::new();

    if enable_v4 {
        let v4_ranges: Vec<IpRange> = flowcone_common::INTERNAL_V4_PREFIXES
            .iter()
            .map(|&p| v4_range(p))
            .collect();
        batch.flush_set(table, super::fw4::SET_V4);
        batch.add_set_elements(table, super::fw4::SET_V4, &v4_ranges, timeout_ms);

        let fwd4_range = [v4_range("0.0.0.0/0")];
        batch.flush_set(table, super::fw4::SET_FWD4);
        batch.add_set_elements(table, super::fw4::SET_FWD4, &fwd4_range, timeout_ms);
    }

    if enable_v6 {
        let mut v6_ranges = Vec::with_capacity(2);
        if is_v6_masq {
            v6_ranges.push(v6_range("2000::/3"));
        }
        v6_ranges.push(v6_range("fc00::/7"));
        batch.flush_set(table, super::fw4::SET_V6);
        batch.add_set_elements(table, super::fw4::SET_V6, &v6_ranges, timeout_ms);

        let fwd6_range = [v6_range("::/0")];
        batch.flush_set(table, super::fw4::SET_FWD6);
        batch.add_set_elements(table, super::fw4::SET_FWD6, &fwd6_range, timeout_ms);
    }

    let batch_bytes = batch.finish();

    let proto = Protocol::from_raw(
        std::num::NonZeroU32::new(NETLINK_NETFILTER).ok_or("invalid netlink netfilter proto")?,
    );
    let sock = socket_with(
        AddressFamily::NETLINK,
        SocketType::RAW,
        SocketFlags::CLOEXEC,
        Some(proto),
    )
    .map_err(|_| "netlink socket error")?;

    bind(&sock, &SocketAddrNetlink::new(0, 0)).map_err(|_| "netlink bind error")?;

    let _ = sockopt::set_socket_timeout(
        &sock,
        sockopt::Timeout::Recv,
        Some(Duration::from_millis(500)),
    );

    send(&sock, &batch_bytes, SendFlags::empty()).map_err(|_| "netlink send error")?;

    let mut reply_buf = [0u8; 1024];
    let (n, _) =
        recv(&sock, &mut reply_buf, RecvFlags::empty()).map_err(|_| "netlink recv error")?;

    if n >= 20 {
        let nlmsg_type = u16::from_ne_bytes([reply_buf[4], reply_buf[5]]);
        if nlmsg_type == 2 {
            // NLMSG_ERROR: 0 indicates success ACK
            let errno =
                i32::from_ne_bytes([reply_buf[16], reply_buf[17], reply_buf[18], reply_buf[19]]);
            if errno == 0 {
                return Ok(());
            }
        }
    }

    Err("netlink batch rejected by kernel")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_v4_cidr() {
        let (start, end) = parse_v4_cidr("10.0.0.0/8").unwrap();
        assert_eq!(start, [10, 0, 0, 0]);
        assert_eq!(end, Some([11, 0, 0, 0]));

        let (start, end) = parse_v4_cidr("192.168.0.0/16").unwrap();
        assert_eq!(start, [192, 168, 0, 0]);
        assert_eq!(end, Some([192, 169, 0, 0]));

        let (start, end) = parse_v4_cidr("240.0.0.0/4").unwrap();
        assert_eq!(start, [240, 0, 0, 0]);
        assert_eq!(end, None); // Wraps around, interval extends to end of range

        let (start, end) = parse_v4_cidr("0.0.0.0/0").unwrap();
        assert_eq!(start, [0, 0, 0, 0]);
        assert_eq!(end, None);
    }

    #[test]
    fn test_parse_v6_cidr() {
        let (start, end) = parse_v6_cidr("fc00::/7").unwrap();
        assert_eq!(start[0], 0xfc);
        assert_eq!(end.unwrap()[0], 0xfe);

        let (start, end) = parse_v6_cidr("2000::/3").unwrap();
        assert_eq!(start[0], 0x20);
        assert_eq!(end.unwrap()[0], 0x40);

        let (start, end) = parse_v6_cidr("::/0").unwrap();
        assert_eq!(start, [0u8; 16]);
        assert_eq!(end, None);
    }

    #[test]
    fn test_batch_serialization_layout() {
        let mut batch = NetlinkBatch::new();
        batch.flush_set("fw4", "flowcone_v4");
        let ranges = [v4_range("10.0.0.0/8")];
        batch.add_set_elements("fw4", "flowcone_v4", &ranges, 15000);
        let bytes = batch.finish();

        // Must start with BATCH_BEGIN (type 16, len 20)
        assert!(bytes.len() > 80);
        let len0 = u32::from_ne_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        let type0 = u16::from_ne_bytes([bytes[4], bytes[5]]);
        assert_eq!(len0, 20);
        assert_eq!(type0, NFNL_MSG_BATCH_BEGIN);

        // Next message is flush_set (NFT_MSG_DELSETELEM = 14)
        let flush_type = u16::from_ne_bytes([bytes[24], bytes[25]]);
        assert_eq!(
            flush_type,
            ((NFNL_SUBSYS_NFTABLES as u16) << 8) | NFT_MSG_DELSETELEM
        );

        // Ends with BATCH_END (type 17, len 20)
        let last_start = bytes.len() - 20;
        let last_len = u32::from_ne_bytes([
            bytes[last_start],
            bytes[last_start + 1],
            bytes[last_start + 2],
            bytes[last_start + 3],
        ]);
        let last_type = u16::from_ne_bytes([bytes[last_start + 4], bytes[last_start + 5]]);
        assert_eq!(last_len, 20);
        assert_eq!(last_type, NFNL_MSG_BATCH_END);
    }

    #[test]
    fn test_refresh_liveness_nonexistent_table_fails_gracefully() {
        // If unprivileged, socket creation fails gracefully;
        // if privileged, kernel rejects non-existent table gracefully.
        let res = refresh_liveness_netlink("non_existent_table_xyz", true, false, false);
        assert!(res.is_err());
    }

    #[test]
    fn test_refresh_liveness_atomic_reset() {
        let setup = std::process::Command::new("nft")
            .args([
                "-f",
                "-",
            ])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                if let Some(ref mut stdin) = child.stdin {
                    let _ = stdin.write_all(
                        b"add table inet flowcone_nl_test\n\
                          add set inet flowcone_nl_test flowcone_v4 { type ipv4_addr; flags interval,timeout; }\n\
                          add set inet flowcone_nl_test flowcone_fwd4 { type ipv4_addr; flags interval,timeout; }\n\
                          add set inet flowcone_nl_test flowcone_v6 { type ipv6_addr; flags interval,timeout; }\n\
                          add set inet flowcone_nl_test flowcone_fwd6 { type ipv6_addr; flags interval,timeout; }\n"
                    );
                }
                child.wait()
            });

        let Ok(status) = setup else { return };
        if !status.success() {
            return;
        }

        let res1 = refresh_liveness_netlink("flowcone_nl_test", true, true, false);
        assert!(res1.is_ok());

        std::thread::sleep(Duration::from_millis(300));

        let res2 = refresh_liveness_netlink("flowcone_nl_test", true, true, false);
        assert!(res2.is_ok());

        let _ = std::process::Command::new("nft")
            .args(["delete", "table", "inet", "flowcone_nl_test"])
            .output();
    }
}
