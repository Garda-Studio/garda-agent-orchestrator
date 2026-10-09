/** Selection labels reuse the dashboard's English fallback for other locales. */
export const BACKUP_SELECTION_TEXT = {
    en: {
        preview: { label: 'Preview selected deletion' }, confirm: { label: 'Delete confirmed backups' }, cancel: { label: 'Cancel' },
        irreversible: { label: 'Deletion is irreversible. Recovery points will be lost.' }, finalPoint: { label: 'I acknowledge loss of the final recovery point.' },
        phrase: { label: 'Type the exact phrase:' }, lost: { label: 'Recovery points lost' }, remaining: { label: 'Recovery points remaining' },
        removed: { label: 'Removed IDs' }, retained: { label: 'Retained IDs' }, stale: { label: 'Inventory changed; request a fresh preview.' },
        rejected: { label: 'Deletion preview rejected.' }, uncertain: { label: 'Deletion outcome or inventory is uncertain; refresh before another action.' },
        select: { label: 'Select backup' }, filter: { label: 'Filter backups by ID' },
        sort: { label: 'Sort backups' }, newest: { label: 'Newest first' }, id: { label: 'ID' },
        all: { label: 'Select all filtered backups' }, clear: { label: 'Clear selection' },
        selected: { label: 'Selected backups' }, bytes: { label: 'bytes' },
        unknownSize: { label: 'Size unavailable' }, unavailable: { label: 'Backup inventory unavailable; selection retained.' }
    },
    ru: {
        preview: { label: 'Предпросмотр удаления выбранных копий' }, confirm: { label: 'Удалить подтверждённые копии' }, cancel: { label: 'Отмена' },
        irreversible: { label: 'Удаление необратимо. Точки восстановления будут потеряны.' }, finalPoint: { label: 'Подтверждаю потерю последней точки восстановления.' },
        phrase: { label: 'Введите точную фразу:' }, lost: { label: 'Потеряно точек восстановления' }, remaining: { label: 'Осталось точек восстановления' },
        removed: { label: 'Удалённые ID' }, retained: { label: 'Сохранённые ID' }, stale: { label: 'Список изменился; запросите новый предпросмотр.' },
        rejected: { label: 'Предпросмотр удаления отклонён.' }, uncertain: { label: 'Результат удаления или список неизвестен; обновите перед новым действием.' },
        select: { label: 'Выбрать резервную копию' }, filter: { label: 'Фильтр копий по ID' },
        sort: { label: 'Сортировка копий' }, newest: { label: 'Сначала новые' }, id: { label: 'ID' },
        all: { label: 'Выбрать все копии по фильтру' }, clear: { label: 'Снять выбор' },
        selected: { label: 'Выбрано копий' }, bytes: { label: 'байт' },
        unknownSize: { label: 'Размер недоступен' }, unavailable: { label: 'Список копий недоступен; выбор сохранён.' }
    }
};
