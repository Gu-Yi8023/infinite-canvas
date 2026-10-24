import i18n from "@/i18n";

export type NasProviderKind = "audio" | "video";
export type NasProviderSettings = { endpoint: string; model: string; hasKey: boolean; useProxy: boolean; configured: boolean };
export type NasProviders = Record<NasProviderKind, NasProviderSettings> & { proxyAvailable: boolean };
export type NasProviderInput = { endpoint: string; model: string; apiKey?: string; useProxy: boolean };

async function request(path: string, init?: RequestInit): Promise<NasProviders> {
    const response = await fetch(`/api/providers${path}`, { credentials: "same-origin", cache: "no-store", ...init });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 401 ? i18n.t("config.nas.signInRequired") : data.error || i18n.t("config.nas.settingsFailed"));
    return data as NasProviders;
}

export const getNasProviders = () => request("");
export const saveNasProvider = (kind: NasProviderKind, input: NasProviderInput) => request(`/${kind}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
