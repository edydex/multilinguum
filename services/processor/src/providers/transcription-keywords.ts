const churchTerms = {
  en: [
    'Bible',
    'Scripture',
    'Gospel',
    'Jesus Christ',
    'Holy Spirit',
    'grace',
    'justification',
    'sanctification',
  ],
  ru: [
    'Библия',
    'Писание',
    'Евангелие',
    'Иисус Христос',
    'Святой Дух',
    'благодать',
    'оправдание',
    'освящение',
  ],
};

const common = new Set(
  'the this that these those then when where what which who why how and but for with from into our your their his her its we you he she they it god lord jesus christ holy spirit bible scripture gospel'.split(
    ' ',
  ),
);

/** Local extraction: no notes or API key are sent to another model. Hints are vocabulary, not instructions. */
export function transcriptionKeywords(language: 'en' | 'ru', texts: readonly string[]): string[] {
  const terms = new Map<string, { text: string; count: number; proper: boolean }>();
  for (const text of texts) {
    // Bound processing independently of the upload limit. Include every selected document.
    for (const word of text.slice(0, 64_000).match(/[\p{L}][\p{L}\p{M}’'-]{2,59}/gu) ?? []) {
      const key = word.toLocaleLowerCase(language);
      if (common.has(key)) continue;
      const old = terms.get(key);
      const proper = /^\p{Lu}/u.test(word);
      terms.set(key, {
        text: old?.text ?? word,
        count: (old?.count ?? 0) + 1,
        proper: proper || Boolean(old?.proper),
      });
    }
  }
  const ranked = [...terms.values()].sort(
    (a, b) =>
      Number(b.proper) - Number(a.proper) ||
      b.count - a.count ||
      a.text.localeCompare(b.text, language),
  );
  const output = [...churchTerms[language]];
  const seen = new Set(output.map((term) => term.toLocaleLowerCase(language)));
  let characters = output.join('').length;
  for (const term of ranked) {
    const key = term.text.toLocaleLowerCase(language);
    if (seen.has(key) || characters + term.text.length > 1_500) continue;
    output.push(term.text);
    seen.add(key);
    characters += term.text.length;
    if (output.length === 64) break;
  }
  return output;
}
