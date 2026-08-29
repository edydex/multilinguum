import type { Language } from '@multilinguum/protocol';

export const defaultGlossary: Readonly<Record<Language, Readonly<Record<string, string>>>> = {
  en: {
    Бытие: 'Genesis',
    Исход: 'Exodus',
    Евангелие: 'Gospel',
    Господь: 'the Lord',
    благодать: 'grace',
    оправдание: 'justification',
  },
  ru: {
    Genesis: 'Бытие',
    Exodus: 'Исход',
    Gospel: 'Евангелие',
    Lord: 'Господь',
    grace: 'благодать',
    justification: 'оправдание',
  },
  es: {
    Бытие: 'Génesis',
    Исход: 'Éxodo',
    Евангелие: 'Evangelio',
    Господь: 'el Señor',
    благодать: 'gracia',
    оправдание: 'justificación',
  },
  uk: {
    Бытие: 'Буття',
    Исход: 'Вихід',
    Евангелие: 'Євангеліє',
    Господь: 'Господь',
    благодать: 'благодать',
    оправдание: 'виправдання',
  },
};
