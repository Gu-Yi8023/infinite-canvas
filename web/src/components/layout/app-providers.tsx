import { saveAs } from "file-saver";
import { NAS_MODE } from "@/constant/runtime-config";
import { approveNasTask, listNasTasks, logoutNas, nasTaskTargetUrl, reconcileNasTask, reconcileNasConversations, cancelNasTask, type NasTask } from "@/services/api/nas-generation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { ProConfigProvider } from "@ant-design/pro-components";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, Button, ConfigProvider, Drawer } from "antd";
import enUS from "antd/es/locale/en_US";
import zhCN from "antd/es/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { useTranslation } from "react-i18next";

import { ClientRootInit } from "@/components/layout/client-root-init";
import type { AppLocale } from "@/i18n";
import { getAntThemeConfig } from "@/lib/app-theme";
import { useThemeStore } from "@/stores/use-theme-store";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30_000,
            retry: false,
            refetchOnWindowFocus: false,
        },
    },
});

export function AppProviders({ children }: { children: ReactNode }) {
    const { i18n, t } = useTranslation();
    const theme = useThemeStore((state) => state.theme);
    const dark = theme === "dark";
    const locale = i18n.resolvedLanguage as AppLocale;

    useEffect(() => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.colorScheme = theme;
    }, [dark, theme]);

    useEffect(() => {
        document.documentElement.lang = locale;
        document.title = t("meta.title");
        document.querySelector('meta[name="description"]')?.setAttribute("content", t("meta.description"));
        dayjs.locale(locale === "zh-CN" ? "zh-cn" : "en");
    }, [locale, t]);

    return (
        <ConfigProvider locale={locale === "zh-CN" ? zhCN : enUS} theme={getAntThemeConfig(dark)}>
            <ProConfigProvider dark={dark}>
                <App>
                    <QueryClientProvider client={queryClient}>
                        <ClientRootInit><NasGenerationApprovals />{children}</ClientRootInit>
                    </QueryClientProvider>
                </App>
            </ProConfigProvider>
        </ConfigProvider>
    );
}

function NasGenerationApprovals() {
    const { modal, message } = App.useApp();
    const [open, setOpen] = useState(false);
    const [tasks, setTasks] = useState<NasTask[]>([]);
    const refresh = () => listNasTasks().then(({ tasks }) => setTasks(tasks)).catch((error: Error) => message.error(error.message));
    useEffect(() => {
        if (!NAS_MODE) return;
        const approval = (event: Event) => {
            const { task } = (event as CustomEvent<{ task: NasTask }>).detail;
            modal.confirm({ title: "Codex 生成任务请求批准", content: `任务 ${task.id}：${task.approval?.method || "执行操作"}`, okText: "允许本次", cancelText: "拒绝", onOk: () => approveNasTask(task, "accept").catch((error: Error) => { message.error(error.message); throw error; }), onCancel: () => approveNasTask(task, "decline").catch((error: Error) => { message.error(error.message); }) });
        };
        const update = (event: Event) => { const task = (event as CustomEvent<NasTask>).detail; setTasks((previous) => [task, ...previous.filter((item) => item.id !== task.id)]); };
        window.addEventListener("nas-generation-task", update);
        const failure = (event: Event) => message.error((event as CustomEvent<string>).detail);
        window.addEventListener("nas-generation-error", failure);
        window.addEventListener("nas-generation-approval", approval);
        return () => { window.removeEventListener("nas-generation-approval", approval); window.removeEventListener("nas-generation-error", failure); window.removeEventListener("nas-generation-task", update); };
    }, [modal, message]);
    if (!NAS_MODE) return null;
    const labels = { queued: "待处理", running: "运行中", approval: "等待批准", succeeded: "生成成功", failed: "失败", cancelled: "已取消", interrupted: "中断，待核对" };
    return <><div className="fixed bottom-3 right-3 z-[80]"><Button type="text" onClick={() => { setOpen(true); void refresh(); }}>NAS 任务</Button></div><Drawer title="NAS 生成任务 · 本设备全部页面" open={open} onClose={() => setOpen(false)}><Button type="text" onClick={() => void logoutNas().catch((error: Error) => message.error(error.message))}>退出 NAS 登录</Button><Button type="text" onClick={() => void refresh()}>刷新任务</Button><Button type="text" onClick={() => void reconcileNasConversations().then(() => { window.dispatchEvent(new Event("nas-generation-receive")); return refresh(); }).catch((error: Error) => message.error(error.message))}>核对并恢复待接收结果</Button><div className="space-y-4">{tasks.map((task) => <div key={task.id} className="py-3 border-b border-current/10"><div className="text-sm">{task.kind === "image" ? "图片" : "文本"} · {labels[task.status]}</div><div className="mt-1 text-xs opacity-60 break-all">{task.target.nodeId || task.target.kind} · {task.id}</div>{task.error ? <p className="mt-2 text-xs">{task.error}</p> : null}<div className="mt-2 flex flex-wrap gap-2">{["queued", "running", "approval"].includes(task.status) ? <Button size="small" type="text" onClick={() => void cancelNasTask(task.id).then(refresh).catch((error: Error) => message.error(error.message))}>取消</Button> : null}{task.status === "interrupted" ? <Button size="small" type="text" onClick={() => void reconcileNasTask(task.id).then(refresh).catch((error: Error) => message.error(error.message))}>核对已有结果</Button> : null}{task.status === "succeeded" ? <a className="text-xs self-center" href={nasTaskTargetUrl(task)}>接收至原目标</a> : null}{task.kind === "text" && task.text ? <Button type="text" size="small" onClick={() => saveAs(new Blob([task.text!], { type: "text/plain;charset=utf-8" }), `codex-${task.id}.txt`)}>下载文本结果</Button> : null}{task.artifacts.map((artifact, index) => <a key={artifact.id} className="text-xs self-center" href={`/api/agent/generation/tasks/${encodeURIComponent(task.id)}/artifacts/${encodeURIComponent(artifact.id)}`} download>下载产物 {index + 1}</a>)}<a className="text-xs self-center" href={nasTaskTargetUrl(task)}>打开原目标</a></div></div>)}</div></Drawer></>;
}
