//! TCX data plane loading, attachment and A/B dispatcher rotation.

use aya::maps::{MapData, ProgramArray};
use aya::programs::links::LinkOrder;
use aya::programs::tc::{
    SchedClassifier, SchedClassifierLinkId, TcAttach, TcAttachType, qdisc_add_clsact,
};
use std::ffi::CString;

fn load_classifier(bpf: &mut aya::Ebpf, prog_name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let prog: &mut SchedClassifier = bpf
        .program_mut(prog_name)
        .ok_or_else(|| format!("program {} not found", prog_name))?
        .try_into()?;
    prog.load()?;
    Ok(())
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

    let type_name = match attach_type {
        TcAttachType::Ingress => "ingress",
        TcAttachType::Egress => "egress",
    };

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
    let link_id = match prog.attach(
        &c_iface,
        TcAttach::Tcx {
            attach_type,
            order: LinkOrder::last(),
        },
    ) {
        Ok(id) => {
            if log_success {
                println!("flowcone: {} attached via TCX (last)", type_name);
            }
            id
        }
        Err(e) => {
            eprintln!("flowcone: TCX {} fallback to netlink: {:?}", type_name, e);
            prog.attach(&c_iface, TcAttach::Auto(attach_type))?
        }
    };

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
    let id = match prog.attach(
        &c_iface,
        TcAttach::Tcx {
            attach_type,
            order: LinkOrder::last(),
        },
    ) {
        Ok(id) => id,
        Err(e) => {
            eprintln!("flowcone: TCX dispatcher attach fallback: {:?}", e);
            prog.attach(&c_iface, TcAttach::Auto(attach_type))?
        }
    };
    Ok(id)
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
    _frag_target: ProgramArray<MapData>,
    _frag6_target: ProgramArray<MapData>,
    _icmp_target: ProgramArray<MapData>,
    _icmp6_target: ProgramArray<MapData>,
}

fn load_target_map(
    bpf: &mut aya::Ebpf,
    map_name: &str,
    prog_name: &str,
) -> Result<ProgramArray<MapData>, Box<dyn std::error::Error>> {
    let mut map = ProgramArray::try_from(
        bpf.take_map(map_name)
            .ok_or_else(|| format!("map {map_name} not found"))?,
    )?;
    let prog: &SchedClassifier = bpf
        .program(prog_name)
        .ok_or_else(|| format!("program {prog_name} not found"))?
        .try_into()?;
    let fd = prog
        .fd()
        .map_err(|e| -> Box<dyn std::error::Error> { format!("{prog_name} fd: {e}").into() })?;
    map.set(0, fd, 0)
        .map_err(|e| -> Box<dyn std::error::Error> {
            format!("{prog_name} map set: {e}").into()
        })?;
    Ok(map)
}

impl DataPlane {
    fn disp_names(&self) -> (&'static str, &'static str) {
        if self.active == 0 {
            ("flowcone_tcx_ingress_a", "flowcone_tcx_egress_a")
        } else {
            ("flowcone_tcx_ingress_b", "flowcone_tcx_egress_b")
        }
    }

    pub(crate) fn start(bpf: aya::Ebpf, iface: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let mut bpf = bpf;
        load_classifier(&mut bpf, "flowcone_tcx_ingress").map_err(
            |e| -> Box<dyn std::error::Error> {
                format!("load target flowcone_tcx_ingress: {e}").into()
            },
        )?;
        load_classifier(&mut bpf, "flowcone_tcx_egress").map_err(
            |e| -> Box<dyn std::error::Error> {
                format!("load target flowcone_tcx_egress: {e}").into()
            },
        )?;
        load_classifier(&mut bpf, "flowcone_frag_v6_ingress").map_err(
            |e| -> Box<dyn std::error::Error> {
                format!("load target flowcone_frag_v6_ingress: {e}").into()
            },
        )?;
        load_classifier(&mut bpf, "flowcone_frag_v6_egress").map_err(
            |e| -> Box<dyn std::error::Error> {
                format!("load target flowcone_frag_v6_egress: {e}").into()
            },
        )?;
        load_classifier(&mut bpf, "flowcone_frag_target").map_err(
            |e| -> Box<dyn std::error::Error> {
                format!("load target flowcone_frag_target: {e}").into()
            },
        )?;
        load_classifier(&mut bpf, "flowcone_icmp_target").map_err(
            |e| -> Box<dyn std::error::Error> {
                format!("load target flowcone_icmp_target: {e}").into()
            },
        )?;
        load_classifier(&mut bpf, "flowcone_icmp6_target").map_err(
            |e| -> Box<dyn std::error::Error> {
                format!("load target flowcone_icmp6_target: {e}").into()
            },
        )?;

        for name in [
            "flowcone_tcx_ingress_a",
            "flowcone_tcx_ingress_b",
            "flowcone_tcx_egress_a",
            "flowcone_tcx_egress_b",
        ] {
            load_classifier(&mut bpf, name).map_err(|e| -> Box<dyn std::error::Error> {
                format!("load dispatcher {name}: {e}").into()
            })?;
        }
        let ingress_target = load_target_map(&mut bpf, "INGRESS_TARGET", "flowcone_tcx_ingress")?;
        let egress_target = load_target_map(&mut bpf, "EGRESS_TARGET", "flowcone_tcx_egress")?;
        let frag_target = load_target_map(&mut bpf, "FRAG_TARGET", "flowcone_frag_target")?;
        let mut frag6_target = ProgramArray::try_from(
            bpf.take_map("FRAG6_TARGET")
                .ok_or("map FRAG6_TARGET not found")?,
        )?;
        let prog_frag6_in: &SchedClassifier = bpf
            .program("flowcone_frag_v6_ingress")
            .ok_or("program flowcone_frag_v6_ingress not found")?
            .try_into()?;
        let fd_frag6_in = prog_frag6_in
            .fd()
            .map_err(|e| -> Box<dyn std::error::Error> {
                format!("flowcone_frag_v6_ingress fd: {e}").into()
            })?;
        frag6_target
            .set(0, fd_frag6_in, 0)
            .map_err(|e| -> Box<dyn std::error::Error> {
                format!("FRAG6_TARGET set ingress: {e}").into()
            })?;

        let prog_frag6_out: &SchedClassifier = bpf
            .program("flowcone_frag_v6_egress")
            .ok_or("program flowcone_frag_v6_egress not found")?
            .try_into()?;
        let fd_frag6_out = prog_frag6_out
            .fd()
            .map_err(|e| -> Box<dyn std::error::Error> {
                format!("flowcone_frag_v6_egress fd: {e}").into()
            })?;
        frag6_target
            .set(1, fd_frag6_out, 0)
            .map_err(|e| -> Box<dyn std::error::Error> {
                format!("FRAG6_TARGET set egress: {e}").into()
            })?;
        let icmp_target = load_target_map(&mut bpf, "ICMP_TARGET", "flowcone_icmp_target")?;
        let icmp6_target = load_target_map(&mut bpf, "ICMP6_TARGET", "flowcone_icmp6_target")?;
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
            _frag_target: frag_target,
            _frag6_target: frag6_target,
            _icmp_target: icmp_target,
            _icmp6_target: icmp6_target,
        };
        data_plane.ingress_ids[0] = loaded_program_id(&data_plane.bpf, "flowcone_tcx_ingress_a")?;
        data_plane.ingress_ids[1] = loaded_program_id(&data_plane.bpf, "flowcone_tcx_ingress_b")?;
        data_plane.egress_ids[0] = loaded_program_id(&data_plane.bpf, "flowcone_tcx_egress_a")?;
        data_plane.egress_ids[1] = loaded_program_id(&data_plane.bpf, "flowcone_tcx_egress_b")?;
        data_plane.attach(true, true)?;
        Ok(data_plane)
    }

    /// Attaches the active dispatcher pair.
    pub(crate) fn attach(
        &mut self,
        force_new: bool,
        log_success: bool,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let iface = self.iface.clone();
        let c_iface = CString::new(iface.as_str())?;
        let _ = qdisc_add_clsact(&c_iface);
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
        attach_classifier(
            &mut self.bpf,
            out_name,
            &iface,
            TcAttachType::Egress,
            &mut self.egress,
            force_new,
            log_success,
        )?;
        Ok(())
    }

    /// Rotates active and standby dispatchers to reclaim tail position.
    fn rotate(&mut self, verbose: bool) -> Result<(), Box<dyn std::error::Error>> {
        let new = 1 - self.active;
        let (new_in_name, new_out_name) = if new == 0 {
            ("flowcone_tcx_ingress_a", "flowcone_tcx_egress_a")
        } else {
            ("flowcone_tcx_ingress_b", "flowcone_tcx_egress_b")
        };
        let (old_in_name, old_out_name) = self.disp_names();
        let iface = self.iface.clone();
        let c_iface = CString::new(iface.as_str())?;
        let _ = qdisc_add_clsact(&c_iface);

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
            println!("flowcone: TCX dispatcher rotated A/B with zero WAN gap");
        }
        Ok(())
    }

    pub(crate) fn ensure_last(
        &mut self,
        verbose: bool,
    ) -> Result<bool, Box<dyn std::error::Error>> {
        let iface = self.iface.clone();
        let in_id = self.ingress_ids[self.active];
        let out_id = self.egress_ids[self.active];
        let ingress_tail = match tcx_is_tail(&iface, TcAttachType::Ingress, in_id) {
            Ok(v) => v,
            Err(e) => {
                if verbose {
                    eprintln!("flowcone: TCX ingress order query failed: {:?}", e);
                }
                return Ok(false);
            }
        };
        let egress_tail = match tcx_is_tail(&iface, TcAttachType::Egress, out_id) {
            Ok(v) => v,
            Err(e) => {
                if verbose {
                    eprintln!("flowcone: TCX egress order query failed: {:?}", e);
                }
                return Ok(false);
            }
        };
        if ingress_tail && egress_tail {
            return Ok(false);
        }
        if verbose {
            println!(
                "flowcone: TCX dispatcher no longer last (ingress_last={}, egress_last={}), rotating A/B",
                ingress_tail, egress_tail
            );
        }
        self.rotate(verbose)?;
        Ok(true)
    }

    /// Explicitly detaches active ingress and egress classifiers, restoring default network state.
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
