//! TCX data plane loading, attachment and A/B dispatcher rotation.

use aya::maps::{MapData, ProgramArray};
use aya::programs::links::LinkOrder;
use aya::programs::tc::{
    NlOptions, SchedClassifier, SchedClassifierLinkId, TcAttach, TcAttachType, qdisc_add_clsact,
};
use std::ffi::CString;

fn load_classifier(bpf: &mut aya::Ebpf, prog_name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let prog: &mut SchedClassifier = bpf
        .program_mut(prog_name)
        .ok_or_else(|| format!("program {} not found", prog_name))?
        .try_into()?;
    prog.load()
        .map_err(|e| -> Box<dyn std::error::Error> { format!("load {prog_name}: {e}").into() })
}

fn attach_tcx_or_netlink(
    prog: &mut SchedClassifier,
    c_iface: &CString,
    attach_type: TcAttachType,
    log_success: bool,
) -> Result<SchedClassifierLinkId, Box<dyn std::error::Error>> {
    let type_name = match attach_type {
        TcAttachType::Ingress => "ingress",
        TcAttachType::Egress => "egress",
    };

    match prog.attach(
        c_iface,
        TcAttach::Tcx {
            attach_type,
            order: LinkOrder::last(),
        },
    ) {
        Ok(id) => {
            if log_success {
                println!("flowcone: {} attached via TCX (last)", type_name);
            }
            Ok(id)
        }
        Err(e) => {
            if log_success {
                eprintln!(
                    "flowcone: TCX {} unavailable ({}), falling back to netlink clsact",
                    type_name, e
                );
            }
            let _ = qdisc_add_clsact(c_iface);
            let id = prog.attach(
                c_iface,
                TcAttach::Netlink {
                    parent: attach_type.into(),
                    options: NlOptions::default(),
                },
            )?;
            if log_success {
                println!("flowcone: {} attached via netlink clsact", type_name);
            }
            Ok(id)
        }
    }
}

fn attach_classifier(
    bpf: &mut aya::Ebpf,
    prog_name: &str,
    iface: &str,
    attach_type: TcAttachType,
    previous: &mut Option<SchedClassifierLinkId>,
    force_new: bool,
    log_success: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let prog: &mut SchedClassifier = bpf
        .program_mut(prog_name)
        .ok_or_else(|| format!("program {} not found", prog_name))?
        .try_into()?;

    // Reuse existing link if valid and interface instance has not changed.
    let old_link = previous
        .take()
        .and_then(|link_id| prog.take_link(link_id).ok());
    if let Some(link) = old_link
        && !force_new
        && let Ok(new_id) = prog.attach_to_link(link)
    {
        *previous = Some(new_id);
        return Ok(());
    }

    let c_iface = CString::new(iface)?;
    let link_id = attach_tcx_or_netlink(prog, &c_iface, attach_type, log_success)?;
    *previous = Some(link_id);
    Ok(())
}

fn loaded_program_id(bpf: &aya::Ebpf, prog_name: &str) -> Result<u32, Box<dyn std::error::Error>> {
    let prog: &SchedClassifier = bpf
        .program(prog_name)
        .ok_or_else(|| format!("program {} not found", prog_name))?
        .try_into()?;
    Ok(prog.info()?.id())
}

fn attach_new_classifier(
    bpf: &mut aya::Ebpf,
    prog_name: &str,
    iface: &str,
    attach_type: TcAttachType,
) -> Result<SchedClassifierLinkId, Box<dyn std::error::Error>> {
    let prog: &mut SchedClassifier = bpf
        .program_mut(prog_name)
        .ok_or_else(|| format!("program {} not found", prog_name))?
        .try_into()?;
    let c_iface = CString::new(iface)?;
    attach_tcx_or_netlink(prog, &c_iface, attach_type, false)
}

fn detach_classifier(bpf: &mut aya::Ebpf, prog_name: &str, id: SchedClassifierLinkId) {
    if let Some(prog) = bpf.program_mut(prog_name)
        && let Ok(prog) = TryInto::<&mut SchedClassifier>::try_into(prog)
    {
        let _ = prog.take_link(id);
    }
}

fn tcx_is_tail(
    iface: &str,
    attach_type: TcAttachType,
    prog_id: u32,
) -> Result<bool, Box<dyn std::error::Error>> {
    let c_iface = CString::new(iface)?;
    let (_, programs) = SchedClassifier::query_tcx(&c_iface, attach_type)?;
    Ok(programs.last().map(|p| p.id() == prog_id).unwrap_or(false))
}

fn load_target_slots(
    bpf: &mut aya::Ebpf,
    map_name: &str,
    slots: &[(u32, &str)],
) -> Result<ProgramArray<MapData>, Box<dyn std::error::Error>> {
    let mut map = ProgramArray::try_from(
        bpf.take_map(map_name)
            .ok_or_else(|| format!("map {map_name} not found"))?,
    )?;
    for &(idx, prog_name) in slots {
        let prog: &SchedClassifier = bpf
            .program(prog_name)
            .ok_or_else(|| format!("program {prog_name} not found"))?
            .try_into()?;
        let fd = prog
            .fd()
            .map_err(|e| -> Box<dyn std::error::Error> { format!("{prog_name} fd: {e}").into() })?;
        map.set(idx, fd, 0)
            .map_err(|e| -> Box<dyn std::error::Error> {
                format!("{map_name}[{idx}] <- {prog_name}: {e}").into()
            })?;
    }
    Ok(map)
}

/// Manages loaded eBPF programs, target maps, and TCX A/B dispatchers.
pub(crate) struct DataPlane {
    bpf: aya::Ebpf,
    iface: String,
    ingress: Option<SchedClassifierLinkId>,
    egress: Option<SchedClassifierLinkId>,
    ingress_ids: [u32; 2],
    egress_ids: [u32; 2],
    active: usize,
    _ingress_target: ProgramArray<MapData>,
    _egress_target: ProgramArray<MapData>,
    _egress_alloc_target: ProgramArray<MapData>,
    _frag_target: ProgramArray<MapData>,
    _frag6_target: ProgramArray<MapData>,
    _icmp_target: ProgramArray<MapData>,
    _icmp6_target: ProgramArray<MapData>,
}

impl DataPlane {
    fn disp_names(&self) -> (&'static str, &'static str) {
        if self.active == 0 {
            ("flowcone_tcx_ingress_a", "flowcone_tcx_egress_a")
        } else {
            ("flowcone_tcx_ingress_b", "flowcone_tcx_egress_b")
        }
    }

    pub(crate) fn bpf_mut(&mut self) -> &mut aya::Ebpf {
        &mut self.bpf
    }

    pub(crate) fn load(
        mut bpf: aya::Ebpf,
        iface: &str,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        for name in [
            "flowcone_ingress_v4",
            "flowcone_ingress_v6",
            "flowcone_egress_v4",
            "flowcone_egress_v6",
            "flowcone_egress_alloc_v4",
            "flowcone_egress_alloc_v6",
            "flowcone_frag_v4_ingress",
            "flowcone_frag_v4_egress",
            "flowcone_frag_v4_egress_alloc",
            "flowcone_frag_v6_ingress",
            "flowcone_frag_v6_egress",
            "flowcone_frag_v6_egress_alloc",
            "flowcone_icmp_target",
            "flowcone_icmp_egress_target",
            "flowcone_icmp6_target",
            "flowcone_icmp6_egress_target",
            "flowcone_tcx_ingress_a",
            "flowcone_tcx_ingress_b",
            "flowcone_tcx_egress_a",
            "flowcone_tcx_egress_b",
        ] {
            load_classifier(&mut bpf, name)?;
        }

        let ingress_target = load_target_slots(
            &mut bpf,
            "INGRESS_TARGET",
            &[(0, "flowcone_ingress_v4"), (1, "flowcone_ingress_v6")],
        )?;
        let egress_target = load_target_slots(
            &mut bpf,
            "EGRESS_TARGET",
            &[(0, "flowcone_egress_v4"), (1, "flowcone_egress_v6")],
        )?;
        let egress_alloc_target = load_target_slots(
            &mut bpf,
            "EGRESS_ALLOC_TARGET",
            &[
                (0, "flowcone_egress_alloc_v4"),
                (1, "flowcone_egress_alloc_v6"),
            ],
        )?;
        let frag_target = load_target_slots(
            &mut bpf,
            "FRAG_TARGET",
            &[
                (0, "flowcone_frag_v4_ingress"),
                (1, "flowcone_frag_v4_egress"),
                (2, "flowcone_frag_v4_egress_alloc"),
            ],
        )?;
        let frag6_target = load_target_slots(
            &mut bpf,
            "FRAG6_TARGET",
            &[
                (0, "flowcone_frag_v6_ingress"),
                (1, "flowcone_frag_v6_egress"),
                (2, "flowcone_frag_v6_egress_alloc"),
            ],
        )?;
        let icmp_target = load_target_slots(
            &mut bpf,
            "ICMP_TARGET",
            &[
                (0, "flowcone_icmp_target"),
                (1, "flowcone_icmp_egress_target"),
            ],
        )?;
        let icmp6_target = load_target_slots(
            &mut bpf,
            "ICMP6_TARGET",
            &[
                (0, "flowcone_icmp6_target"),
                (1, "flowcone_icmp6_egress_target"),
            ],
        )?;

        let mut data_plane = Self {
            bpf,
            iface: iface.to_string(),
            ingress: None,
            egress: None,
            ingress_ids: [0; 2],
            egress_ids: [0; 2],
            active: 0,
            _ingress_target: ingress_target,
            _egress_target: egress_target,
            _egress_alloc_target: egress_alloc_target,
            _frag_target: frag_target,
            _frag6_target: frag6_target,
            _icmp_target: icmp_target,
            _icmp6_target: icmp6_target,
        };
        data_plane.ingress_ids[0] = loaded_program_id(&data_plane.bpf, "flowcone_tcx_ingress_a")?;
        data_plane.ingress_ids[1] = loaded_program_id(&data_plane.bpf, "flowcone_tcx_ingress_b")?;
        data_plane.egress_ids[0] = loaded_program_id(&data_plane.bpf, "flowcone_tcx_egress_a")?;
        data_plane.egress_ids[1] = loaded_program_id(&data_plane.bpf, "flowcone_tcx_egress_b")?;
        Ok(data_plane)
    }

    /// Attaches the active dispatcher pair atomically (detaches ingress if
    /// egress fails).
    pub(crate) fn attach(
        &mut self,
        force_new: bool,
        log_success: bool,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let iface = self.iface.clone();
        let (in_name, out_name) = self.disp_names();
        attach_classifier(
            &mut self.bpf,
            in_name,
            &iface,
            TcAttachType::Ingress,
            &mut self.ingress,
            force_new,
            log_success,
        )?;
        if let Err(e) = attach_classifier(
            &mut self.bpf,
            out_name,
            &iface,
            TcAttachType::Egress,
            &mut self.egress,
            force_new,
            log_success,
        ) {
            if let Some(id) = self.ingress.take() {
                detach_classifier(&mut self.bpf, in_name, id);
            }
            return Err(e);
        }
        Ok(())
    }

    /// Rotates active and standby dispatchers to reclaim TCX tail position.
    fn rotate(&mut self, verbose: bool) -> Result<(), Box<dyn std::error::Error>> {
        let new = 1 - self.active;
        let (new_in_name, new_out_name) = if new == 0 {
            ("flowcone_tcx_ingress_a", "flowcone_tcx_egress_a")
        } else {
            ("flowcone_tcx_ingress_b", "flowcone_tcx_egress_b")
        };
        let (old_in_name, old_out_name) = self.disp_names();
        let iface = self.iface.clone();

        let new_in =
            attach_new_classifier(&mut self.bpf, new_in_name, &iface, TcAttachType::Ingress)?;
        let new_out = match attach_new_classifier(
            &mut self.bpf,
            new_out_name,
            &iface,
            TcAttachType::Egress,
        ) {
            Ok(id) => id,
            Err(e) => {
                detach_classifier(&mut self.bpf, new_in_name, new_in);
                return Err(e);
            }
        };

        let old_in = self.ingress.replace(new_in);
        let old_out = self.egress.replace(new_out);
        self.active = new;
        if let Some(id) = old_in {
            detach_classifier(&mut self.bpf, old_in_name, id);
        }
        if let Some(id) = old_out {
            detach_classifier(&mut self.bpf, old_out_name, id);
        }
        if verbose {
            println!("flowcone: TCX dispatcher rotated A/B");
        }
        Ok(())
    }

    pub(crate) fn ensure_last(&mut self, verbose: bool) -> Result<(), Box<dyn std::error::Error>> {
        let iface = self.iface.clone();
        let in_id = self.ingress_ids[self.active];
        let out_id = self.egress_ids[self.active];
        let ingress_tail = match tcx_is_tail(&iface, TcAttachType::Ingress, in_id) {
            Ok(v) => v,
            Err(e) => {
                if verbose {
                    eprintln!("flowcone: TCX ingress order query skipped: {}", e);
                }
                return Ok(());
            }
        };
        let egress_tail = match tcx_is_tail(&iface, TcAttachType::Egress, out_id) {
            Ok(v) => v,
            Err(e) => {
                if verbose {
                    eprintln!("flowcone: TCX egress order query skipped: {}", e);
                }
                return Ok(());
            }
        };
        if ingress_tail && egress_tail {
            return Ok(());
        }
        if verbose {
            println!(
                "flowcone: TCX dispatcher no longer last (ingress_last={}, egress_last={}), rotating A/B",
                ingress_tail, egress_tail
            );
        }
        self.rotate(verbose)
    }

    pub(crate) fn detach(&mut self) {
        let (in_name, out_name) = self.disp_names();
        if let Some(id) = self.ingress.take() {
            detach_classifier(&mut self.bpf, in_name, id);
        }
        if let Some(id) = self.egress.take() {
            detach_classifier(&mut self.bpf, out_name, id);
        }
    }
}

impl Drop for DataPlane {
    fn drop(&mut self) {
        self.detach();
    }
}
