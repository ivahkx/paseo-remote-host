// The tests read the English catalog, the one this plugin is reviewed in, rather than whatever the device would pick.
import { bindTranslator, createTranslator } from "../shared/i18n";
import en from "../shared/locales/en.json";
import kitEn from "../shared/locales/kit/en.json";

bindTranslator(createTranslator("en", [en, kitEn]));
