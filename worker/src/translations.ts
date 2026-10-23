import {chapterSlot} from './chapter-index';
type Dict = Record<string, unknown>;
export function translationRank(language?: string): number {
  return language === 'ar' || !language ? 0 : language === 'en' ? 1 : 2;
}
export function languageName(language: string): string {
  return ({ar:'العربية',en:'الإنجليزية',fr:'الفرنسية',es:'الإسبانية','es-la':'الإسبانية',pt:'البرتغالية','pt-br':'البرتغالية',ja:'اليابانية',ko:'الكورية',zh:'الصينية','zh-hk':'الصينية',ru:'الروسية',tr:'التركية',id:'الإندونيسية',it:'الإيطالية',de:'الألمانية',vi:'الفيتنامية',th:'التايلاندية',pl:'البولندية'} as Record<string,string>)[language] ?? language;
}
export function aggregateSlot(chapter: Dict): string | null {
  return chapterSlot(String(chapter.chapter ?? '')) ?? (typeof chapter.id === 'string' && chapter.id ? `special:${chapter.id}` : null);
}
// One stable discussion per number; candidates prefer Arabic, English, then any available language.
export function translationCandidates(aggregates: Dict[]): Map<string,string[]> {
  const result = new Map<string,string[]>();
  for (const includeOthers of [false,true]) for (const aggregate of aggregates) for (const volume of Object.values((aggregate.volumes ?? {}) as Dict)) {
    for (const raw of Object.values(((volume as Dict).chapters ?? {}) as Dict)) {
      const chapter = raw as Dict;
      const slot = aggregateSlot(chapter);
      if (slot === null) continue;
      const ids = result.get(slot) ?? [];
      for (const id of includeOthers ? ((chapter.others ?? []) as unknown[]) : [chapter.id]) {
        if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
      }
      result.set(slot,ids);
    }
  }
  return result;
}
