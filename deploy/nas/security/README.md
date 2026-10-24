# NAS worker 沙箱策略

`seccomp.json` 基于 [Docker 28.5.2 默认策略](https://github.com/moby/moby/blob/v28.5.2/vendor/github.com/moby/profiles/seccomp/default.json)，仅为 amd64 增加 Codex 的固定 namespace flags、受限 mount flags、`umount2(MNT_DETACH)` 和 `pivot_root`。`apparmor.profile` 基于同版 Docker 默认模板，保留 `/proc`、`/sys` 禁止规则，将禁止所有挂载改为允许 bubblewrap 在 `/tmp`、`/newroot` 的指定操作。

仅 worker 使用这组策略；需要同时保留非 root、`cap_drop: ALL`、`no-new-privileges`、只读镜像和默认 masked/read-only system paths。它增加了 worker 在子 user namespace 中可调用的内核接口，不是通用容器策略。已用 Codex CLI 0.159.2、bubblewrap 0.8.0、Docker 28.5.2 和 fnOS AppArmor 3.0.8 在 amd64 验证工作区写入、私有目录拒读和禁用网络。为支持 0.159.2，seccomp 仅加入用户授权的固定 IPC namespace clone flag；AppArmor profile 与其他权限保持不变。新版无凭据 command/exec 10 项隔离检查和 39 项客户端/profile 定向回归通过。基础 `bwrap --proc` 探测可能失败；Codex 自带该错误的兼容处理，仍需验证实际权限 profile。

由管理员显式加载后再启动 worker：

```sh
sudo install -m 644 deploy/nas/security/apparmor.profile /etc/apparmor.d/canvas-nas-worker
sudo apparmor_parser -r -K /etc/apparmor.d/canvas-nas-worker
```

当前 fnOS 的 AppArmor 服务已启用，安装到上述目录后由该服务在启动时加载；尚未实际重启 NAS 验收。未加载时 worker 会拒绝启动。更换 Docker、Codex 或 bubblewrap 版本后重新验证，不改用 `privileged`、`unconfined` 或取消系统路径保护来跳过验证。
