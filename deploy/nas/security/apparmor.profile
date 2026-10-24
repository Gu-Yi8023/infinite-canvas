# Scoped to the NAS worker; load explicitly with apparmor_parser before starting it.
# Based on Docker 28.5.2's generated docker-default template.
# Validated with Codex 0.146.0, bubblewrap 0.8.0, and fnOS AppArmor 3.0.8 on amd64.
# Requires cap_drop ALL, uid 1000, NNP, read_only, and matching seccomp profile.
# No unconfined mode, blanket mount rule, profile transition, or daemon change.
#include <tunables/global>

profile canvas-nas-worker flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  network,
  capability,
  file,
  umount,
  signal (receive) peer=unconfined,
  signal (receive) peer=runc,
  signal (receive) peer=crun,
  signal (send,receive) peer=canvas-nas-worker,
  ptrace (trace,read,tracedby,readby) peer=canvas-nas-worker,

  # Preserve Docker's proc/sys protections.
  deny @{PROC}/* w,
  deny @{PROC}/{[^1-9],[^1-9][^0-9],[^1-9s][^0-9y][^0-9s],[^1-9][^0-9][^0-9][^0-9/]*}/** w,
  deny @{PROC}/sys/[^k]** w,
  deny @{PROC}/sys/kernel/{?,??,[^s][^h][^m]**} w,
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/kcore rwklx,
  deny /sys/[^f]*/** wklx,
  deny /sys/f[^s]*/** wklx,
  deny /sys/fs/[^c]*/** wklx,
  deny /sys/fs/c[^g]*/** wklx,
  deny /sys/fs/cg[^r]*/** wklx,
  deny /sys/firmware/** rwklx,
  deny /sys/devices/virtual/powercap/** rwklx,
  deny /sys/kernel/security/** rwklx,

  # Replace Docker's blanket deny mount with bwrap's staging operations.
  mount options=(rw,silent,rslave) -> /,
  mount options=(rw,silent,rprivate) -> /oldroot/,
  mount fstype=tmpfs options=(rw,nosuid,nodev) tmpfs -> /tmp/,
  mount options=(rw,silent,rbind) /tmp/newroot/ -> /tmp/newroot/,
  mount options=(rw,silent,rbind) -> /newroot/{,**},
  mount fstype=tmpfs options=(rw,nosuid,nodev) tmpfs -> /newroot/{,**},
  mount fstype=proc options=(rw,nosuid,nodev,noexec) proc -> /newroot/proc/,
  mount fstype=devpts options=(rw,nosuid,noexec) devpts -> /newroot/dev/pts/,

  # The seccomp mask requires BIND|REMOUNT|NOSUID|SILENT. AppArmor constrains destinations.
  mount options in (ro,rw,nosuid,nodev,noexec,bind,remount,silent,noatime,nodiratime,relatime) -> /newroot/{,**},
  pivot_root oldroot=/tmp/oldroot/ /tmp/,
  pivot_root oldroot=/newroot/ /newroot/,
}
