import { App, Button, theme } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { loadNasCapabilities, useNasStore } from "@/stores/use-nas-store";
import { ConfigMediaApiSettings } from "./config-media-api-settings";
import { logoutNas } from "@/services/api/nas-generation";

export function ConfigNasServices() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const { token } = theme.useToken();
    const nas = useNasStore();
    const [refreshing, setRefreshing] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);

    useEffect(() => { void loadNasCapabilities(); }, []);

    const refresh = async () => {
        setRefreshing(true);
        try { await loadNasCapabilities(true); } finally { setRefreshing(false); }
    };
    const logout = async () => {
        setLoggingOut(true);
        try { await logoutNas(); } catch (error) { message.error(error instanceof Error ? error.message : t("config.nas.logoutFailed")); } finally { setLoggingOut(false); }
    };

    const imageStatus = !nas.loaded ? t("config.nas.loading") : nas.image.status === "available" ? t("config.nas.imageAvailable") : nas.image.status === "unavailable" ? t("config.nas.imageUnavailable") : t("config.nas.imageUnverified");

    return (
        <div className="space-y-3 text-sm">
            <section className="rounded-lg border p-3" style={{ borderColor: token.colorBorder }}>
                <div className="font-semibold">{t("config.nas.codexTitle")}</div>
                <p className="mt-1 text-xs" style={{ color: token.colorTextSecondary }}>{t("config.nas.codexDescription")}</p>
                <p className="mt-3">{!nas.loaded ? t("config.nas.loading") : nas.models.length ? t("config.nas.modelCount", { count: nas.models.length }) : t("config.nas.modelsEmpty")}</p>
                <p className="mt-2">{t("config.nas.imageLabel")}: {imageStatus}{nas.loaded && nas.image.reason ? <span className="ml-1">{nas.image.reason}</span> : null}</p>
                {nas.error ? <p className="mt-2" style={{ color: token.colorError }}>{nas.error}</p> : null}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button type="text" loading={refreshing} onClick={() => void refresh()}>{t("config.nas.refresh")}</Button>
                    <a href="/login">{t("config.nas.login")}</a>
                    <Button type="text" loading={loggingOut} onClick={() => void logout()}>{t("config.nas.logout")}</Button>
                </div>
            </section>

            <ConfigMediaApiSettings />
        </div>
    );
}
