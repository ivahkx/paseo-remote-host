// Language binding for a plugin with no server. Agent Observatory's client/i18n-client.tsx fetches its catalog from the
// plugin server and supports user-supplied language files; this plugin has no server, so it simply binds the two
// catalogs it ships with, chosen by the device's language. English is layered under Chinese so a gap reads as English
// rather than as a raw message id.
import { bindTranslator, catalogName, createTranslator, normalizeLanguage } from "../shared/i18n";
import zh from "../shared/locales/zh-CN.json";
import en from "../shared/locales/en.json";
import kitZh from "../shared/locales/kit/zh-CN.json";
import kitEn from "../shared/locales/kit/en.json";

/** The device's language as a BCP 47 tag; "" when neither Intl nor the browser says. */
function deviceLanguage(): string {
  try {
    const tag = normalizeLanguage(Intl.DateTimeFormat().resolvedOptions().locale);
    if (tag) return tag;
  } catch {
    // Hermes without Intl: ask the browser, if there is one.
  }
  try {
    const browser = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator;
    return normalizeLanguage(browser?.languages?.[0] ?? browser?.language ?? "");
  } catch {
    return "";
  }
}

/** The bound catalog's own name for its language ("English", "简体中文"), for the instruction that asks a model for it. */
let boundName = catalogName(en) ?? "English";
export const pluginLanguageName = (): string => boundName;

/** Binds the plugin's text to the device's language. Called once when the plugin is contributed. */
export function bindPluginLanguage(): void {
  const chinese = deviceLanguage().toLowerCase().startsWith("zh");
  boundName = (chinese ? catalogName(zh) : catalogName(en)) ?? boundName;
  bindTranslator(chinese
    ? createTranslator("zh-CN", [zh, kitZh, en, kitEn])
    : createTranslator("en", [en, kitEn]));
}
