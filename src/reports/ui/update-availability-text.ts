import type { LocalUiLanguage } from "./ui-i18n";
import ar from "./update-availability-text/lang/ar.json";
import bn from "./update-availability-text/lang/bn.json";
import de from "./update-availability-text/lang/de.json";
import es from "./update-availability-text/lang/es.json";
import fr from "./update-availability-text/lang/fr.json";
import hi from "./update-availability-text/lang/hi.json";
import id from "./update-availability-text/lang/id.json";
import it from "./update-availability-text/lang/it.json";
import ja from "./update-availability-text/lang/ja.json";
import ko from "./update-availability-text/lang/ko.json";
import nl from "./update-availability-text/lang/nl.json";
import pl from "./update-availability-text/lang/pl.json";
import pt from "./update-availability-text/lang/pt.json";
import ptBr from "./update-availability-text/lang/pt-BR.json";
import ru from "./update-availability-text/lang/ru.json";
import sv from "./update-availability-text/lang/sv.json";
import tr from "./update-availability-text/lang/tr.json";
import uk from "./update-availability-text/lang/uk.json";
import vi from "./update-availability-text/lang/vi.json";
import zhCn from "./update-availability-text/lang/zh-CN.json";

interface UpdateAvailabilityText {
    title: string;
    checkButton: string;
    checking: string;
    upToDate: string;
    available: string;
    error: string;
    commandLabel: string;
    automaticDisabled: string;
    installed: string;
    unknown: string;
}

export const UPDATE_AVAILABILITY_TEXT: Record<LocalUiLanguage, UpdateAvailabilityText> = {
    en: {
        title: "Garda updates",
        checkButton: "Check for updates",
        checking: "Checking for updates…",
        upToDate: "Garda {current} is up to date.",
        available: "Garda update available: {current} → {latest}",
        error: "Could not check for updates. Try again.",
        commandLabel: "Update command",
        automaticDisabled: "Automatic update checks are disabled.",
        installed: "Installed Garda: {current}",
        unknown: "Update information is not available yet."
    },
    ar,
    bn,
    de,
    es,
    fr,
    hi,
    id,
    it,
    ja,
    ko,
    nl,
    pl,
    pt,
    "pt-BR": ptBr,
    ru,
    sv,
    tr,
    uk,
    vi,
    "zh-CN": zhCn
};
