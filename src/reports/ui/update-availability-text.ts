import type { LocalUiLanguage } from './ui-i18n';

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

function text(values: readonly [string, string, string, string, string, string, string, string, string, string]): UpdateAvailabilityText {
    const [title, checkButton, checking, upToDate, available, error, commandLabel, automaticDisabled, installed, unknown] = values;
    return { title, checkButton, checking, upToDate, available, error, commandLabel, automaticDisabled, installed, unknown };
}

/** Separate namespace keeps every supported locale complete without changing the core dashboard pack contract. */
export const UPDATE_AVAILABILITY_TEXT: Record<LocalUiLanguage, UpdateAvailabilityText> = {
    en: text(['Garda updates', 'Check for updates', 'Checking for updates…', 'Garda {current} is up to date.',
        'Garda update available: {current} → {latest}', 'Could not check for updates. Try again.', 'Update command',
        'Automatic update checks are disabled.', 'Installed Garda: {current}', 'Update information is not available yet.']),
    ar: text(['تحديثات Garda', 'التحقق من التحديثات', 'جارٍ التحقق من التحديثات…', 'Garda {current} محدّثة.',
        'يتوفر تحديث لـ Garda: {current} → {latest}', 'تعذّر التحقق من التحديثات. حاول مرة أخرى.', 'أمر التحديث',
        'التحقق التلقائي من التحديثات معطّل.', 'إصدار Garda المثبّت: {current}', 'معلومات التحديث غير متاحة بعد.']),
    bn: text(['Garda আপডেট', 'আপডেট খুঁজুন', 'আপডেট খোঁজা হচ্ছে…', 'Garda {current} হালনাগাদ আছে।',
        'Garda আপডেট উপলব্ধ: {current} → {latest}', 'আপডেট খোঁজা যায়নি। আবার চেষ্টা করুন।', 'আপডেটের কমান্ড',
        'স্বয়ংক্রিয় আপডেট পরীক্ষা বন্ধ আছে।', 'ইনস্টল করা Garda: {current}', 'আপডেটের তথ্য এখনও পাওয়া যায়নি।']),
    de: text(['Garda-Updates', 'Nach Updates suchen', 'Updates werden geprüft…', 'Garda {current} ist aktuell.',
        'Garda-Update verfügbar: {current} → {latest}', 'Updates konnten nicht geprüft werden. Erneut versuchen.', 'Update-Befehl',
        'Automatische Update-Prüfungen sind deaktiviert.', 'Installierte Garda-Version: {current}', 'Update-Informationen sind noch nicht verfügbar.']),
    es: text(['Actualizaciones de Garda', 'Buscar actualizaciones', 'Buscando actualizaciones…', 'Garda {current} está actualizada.',
        'Actualización de Garda disponible: {current} → {latest}', 'No se pudieron buscar actualizaciones. Inténtalo de nuevo.', 'Comando de actualización',
        'Las comprobaciones automáticas están desactivadas.', 'Garda instalada: {current}', 'La información de actualización aún no está disponible.']),
    fr: text(['Mises à jour de Garda', 'Rechercher des mises à jour', 'Recherche de mises à jour…', 'Garda {current} est à jour.',
        'Mise à jour de Garda disponible : {current} → {latest}', 'Impossible de rechercher des mises à jour. Réessayez.', 'Commande de mise à jour',
        'La recherche automatique de mises à jour est désactivée.', 'Version de Garda installée : {current}', 'Les informations de mise à jour ne sont pas encore disponibles.']),
    hi: text(['Garda अपडेट', 'अपडेट जाँचें', 'अपडेट की जाँच हो रही है…', 'Garda {current} अद्यतित है।',
        'Garda अपडेट उपलब्ध है: {current} → {latest}', 'अपडेट की जाँच नहीं हो सकी। फिर कोशिश करें।', 'अपडेट कमांड',
        'स्वचालित अपडेट जाँच बंद है।', 'इंस्टॉल किया गया Garda: {current}', 'अपडेट की जानकारी अभी उपलब्ध नहीं है।']),
    id: text(['Pembaruan Garda', 'Periksa pembaruan', 'Memeriksa pembaruan…', 'Garda {current} sudah terbaru.',
        'Pembaruan Garda tersedia: {current} → {latest}', 'Tidak dapat memeriksa pembaruan. Coba lagi.', 'Perintah pembaruan',
        'Pemeriksaan pembaruan otomatis dinonaktifkan.', 'Garda terpasang: {current}', 'Informasi pembaruan belum tersedia.']),
    it: text(['Aggiornamenti di Garda', 'Cerca aggiornamenti', 'Ricerca aggiornamenti…', 'Garda {current} è aggiornata.',
        'Aggiornamento di Garda disponibile: {current} → {latest}', 'Impossibile cercare aggiornamenti. Riprova.', 'Comando di aggiornamento',
        'La ricerca automatica degli aggiornamenti è disattivata.', 'Garda installata: {current}', 'Le informazioni sugli aggiornamenti non sono ancora disponibili.']),
    ja: text(['Garda の更新', '更新を確認', '更新を確認中…', 'Garda {current} は最新です。',
        'Garda の更新があります: {current} → {latest}', '更新を確認できませんでした。もう一度お試しください。', '更新コマンド',
        '更新の自動確認は無効です。', 'インストール済みの Garda: {current}', '更新情報はまだありません。']),
    ko: text(['Garda 업데이트', '업데이트 확인', '업데이트 확인 중…', 'Garda {current}은(는) 최신 버전입니다.',
        'Garda 업데이트 사용 가능: {current} → {latest}', '업데이트를 확인할 수 없습니다. 다시 시도하세요.', '업데이트 명령어',
        '자동 업데이트 확인이 비활성화되어 있습니다.', '설치된 Garda: {current}', '업데이트 정보를 아직 사용할 수 없습니다.']),
    nl: text(['Garda-updates', 'Controleren op updates', 'Updates controleren…', 'Garda {current} is bijgewerkt.',
        'Garda-update beschikbaar: {current} → {latest}', 'Kan niet controleren op updates. Probeer het opnieuw.', 'Updateopdracht',
        'Automatische updatecontroles zijn uitgeschakeld.', 'Geïnstalleerde Garda: {current}', 'Update-informatie is nog niet beschikbaar.']),
    pl: text(['Aktualizacje Garda', 'Sprawdź aktualizacje', 'Sprawdzanie aktualizacji…', 'Garda {current} jest aktualna.',
        'Dostępna aktualizacja Garda: {current} → {latest}', 'Nie można sprawdzić aktualizacji. Spróbuj ponownie.', 'Polecenie aktualizacji',
        'Automatyczne sprawdzanie aktualizacji jest wyłączone.', 'Zainstalowana Garda: {current}', 'Informacje o aktualizacji nie są jeszcze dostępne.']),
    pt: text(['Atualizações da Garda', 'Procurar atualizações', 'A procurar atualizações…', 'A Garda {current} está atualizada.',
        'Atualização da Garda disponível: {current} → {latest}', 'Não foi possível procurar atualizações. Tente novamente.', 'Comando de atualização',
        'A verificação automática de atualizações está desativada.', 'Garda instalada: {current}', 'A informação de atualização ainda não está disponível.']),
    'pt-BR': text(['Atualizações da Garda', 'Verificar atualizações', 'Verificando atualizações…', 'A Garda {current} está atualizada.',
        'Atualização da Garda disponível: {current} → {latest}', 'Não foi possível verificar atualizações. Tente novamente.', 'Comando de atualização',
        'A verificação automática de atualizações está desativada.', 'Garda instalada: {current}', 'As informações de atualização ainda não estão disponíveis.']),
    ru: text(['Обновления Garda', 'Проверить обновления', 'Проверяем обновления…', 'Garda {current} — актуальная версия.',
        'Доступна новая версия Garda: {current} → {latest}', 'Не удалось проверить обновления. Попробуйте снова.', 'Команда обновления',
        'Автоматическая проверка обновлений отключена.', 'Установлена Garda: {current}', 'Информация об обновлениях пока недоступна.']),
    sv: text(['Garda-uppdateringar', 'Sök efter uppdateringar', 'Söker efter uppdateringar…', 'Garda {current} är uppdaterad.',
        'Garda-uppdatering tillgänglig: {current} → {latest}', 'Kunde inte söka efter uppdateringar. Försök igen.', 'Uppdateringskommando',
        'Automatiska uppdateringskontroller är avstängda.', 'Installerad Garda: {current}', 'Uppdateringsinformation är ännu inte tillgänglig.']),
    tr: text(['Garda güncellemeleri', 'Güncellemeleri denetle', 'Güncellemeler denetleniyor…', 'Garda {current} güncel.',
        'Garda güncellemesi mevcut: {current} → {latest}', 'Güncellemeler denetlenemedi. Tekrar deneyin.', 'Güncelleme komutu',
        'Otomatik güncelleme denetimleri devre dışı.', 'Yüklü Garda: {current}', 'Güncelleme bilgisi henüz mevcut değil.']),
    uk: text(['Оновлення Garda', 'Перевірити оновлення', 'Перевіряємо оновлення…', 'Garda {current} — актуальна версія.',
        'Доступна нова версія Garda: {current} → {latest}', 'Не вдалося перевірити оновлення. Спробуйте ще раз.', 'Команда оновлення',
        'Автоматичну перевірку оновлень вимкнено.', 'Встановлено Garda: {current}', 'Інформація про оновлення поки недоступна.']),
    vi: text(['Bản cập nhật Garda', 'Kiểm tra cập nhật', 'Đang kiểm tra cập nhật…', 'Garda {current} đã được cập nhật.',
        'Có bản cập nhật Garda: {current} → {latest}', 'Không thể kiểm tra cập nhật. Vui lòng thử lại.', 'Lệnh cập nhật',
        'Đã tắt kiểm tra cập nhật tự động.', 'Garda đã cài đặt: {current}', 'Chưa có thông tin cập nhật.']),
    'zh-CN': text(['Garda 更新', '检查更新', '正在检查更新…', 'Garda {current} 已是最新版本。',
        'Garda 有可用更新：{current} → {latest}', '无法检查更新。请重试。', '更新命令',
        '已禁用自动更新检查。', '已安装的 Garda：{current}', '暂时没有更新信息。'])
};
