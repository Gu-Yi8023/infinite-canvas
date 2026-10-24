import { App, Button, Form, Input, Switch, theme } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getNasProviders, saveNasProvider, type NasProviderInput, type NasProviderKind, type NasProviders, type NasProviderSettings } from "@/services/api/nas-providers";
import { loadNasCapabilities } from "@/stores/use-nas-store";

export function ConfigMediaApiSettings() {
    const { t } = useTranslation();
    const { token } = theme.useToken();
    const [settings, setSettings] = useState<NasProviders>();
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const load = async () => {
        setLoading(true);
        setError("");
        try { setSettings(await getNasProviders()); }
        catch (error) { setError(error instanceof Error ? error.message : t("config.nas.settingsFailed")); }
        finally { setLoading(false); }
    };
    useEffect(() => { void load(); }, []);

    return <div className="space-y-3">
        <p className="text-xs" style={{ color: token.colorTextSecondary }}>{t("config.nas.keyStorage")}</p>
        {error ? <div role="alert" style={{ color: token.colorError }}>{error}<Button type="text" loading={loading} onClick={() => void load()}>{t("config.nas.refresh")}</Button></div> : null}
        {!settings && !error ? <p>{t("config.nas.loading")}</p> : null}
        {settings ? (["audio", "video"] as const).map((kind) => <MediaApiForm key={kind} kind={kind} settings={settings[kind]} proxyAvailable={settings.proxyAvailable} onSaved={setSettings} />) : null}
    </div>;
}

function MediaApiForm({ kind, settings, proxyAvailable, onSaved }: { kind: NasProviderKind; settings: NasProviderSettings; proxyAvailable: boolean; onSaved: (settings: NasProviders) => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const { token } = theme.useToken();
    const [form] = Form.useForm<NasProviderInput>();
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const { endpoint, model, hasKey, useProxy } = settings;
    useEffect(() => { form.setFieldsValue({ endpoint, model, useProxy, apiKey: "" }); }, [form, endpoint, model, useProxy, hasKey]);

    const save = async (values: NasProviderInput) => {
        setSaving(true);
        setError("");
        try {
            const apiKey = values.apiKey?.trim();
            const next = await saveNasProvider(kind, { endpoint: values.endpoint.trim(), model: values.model.trim(), useProxy: values.useProxy, ...(apiKey ? { apiKey } : {}) });
            form.setFieldValue("apiKey", "");
            onSaved(next);
            await loadNasCapabilities(true);
            message.success(t("config.nas.settingsSaved"));
        } catch (error) { setError(error instanceof Error ? error.message : t("config.nas.settingsFailed")); }
        finally { setSaving(false); }
    };

    return <section className="rounded-lg border p-3" style={{ borderColor: token.colorBorder }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{t(`config.nas.${kind}Title`)}</h3>
            <span className="text-xs" style={{ color: token.colorTextSecondary }}>{t(settings.configured ? "config.nas.providerConfigured" : "config.nas.providerUnconfigured")}</span>
        </div>
        <p className="mt-1 mb-3 text-xs" style={{ color: token.colorTextSecondary }}>{t(`config.nas.${kind}Protocol`)}</p>
        <Form name={`nas-${kind}`} form={form} layout="vertical" disabled={saving} onFinish={(values) => void save(values)} initialValues={{ endpoint, model, useProxy, apiKey: "" }}>
            <Form.Item name="endpoint" label={t("config.nas.endpoint")} extra={t(`config.nas.${kind}EndpointHint`)} rules={[{ required: true, whitespace: true, message: t("config.nas.endpointRequired") }, { type: "url", message: t("config.nas.endpointRequired") }]}>
                <Input placeholder={kind === "audio" ? "https://api.example.com/v1/audio/speech" : "https://api.example.com/v1/videos"} autoComplete="off" />
            </Form.Item>
            <div className="grid gap-x-4 md:grid-cols-2">
                <Form.Item name="model" label={t("config.nas.providerModel")} rules={[{ required: true, whitespace: true, message: t("config.nas.modelRequired") }]}>
                    <Input placeholder={t("config.nas.modelPlaceholder")} autoComplete="off" />
                </Form.Item>
                <Form.Item name="apiKey" label="API Key" extra={t(hasKey ? "config.nas.keySaved" : "config.nas.keyRequiredHint")} rules={[{ required: !hasKey, whitespace: true, message: t("config.nas.keyRequiredHint") }]}>
                    <Input.Password autoComplete="new-password" placeholder={t(hasKey ? "config.nas.keepKey" : "config.nas.enterKey")} />
                </Form.Item>
            </div>
            <Form.Item name="useProxy" label={t("config.nas.useProxy")} valuePropName="checked" extra={t(proxyAvailable ? "config.nas.proxyHint" : "config.nas.proxyMissing")}>
                <Switch />
            </Form.Item>
            {error ? <p role="alert" className="mb-3" style={{ color: token.colorError }}>{error}</p> : null}
            <div className="flex flex-wrap items-center gap-3">
                <Button type="primary" htmlType="submit" loading={saving}>{t("config.nas.saveProvider")}</Button>
                <span className="text-xs" style={{ color: token.colorTextSecondary }}>{t("config.nas.saveHint")}</span>
            </div>
        </Form>
    </section>;
}
