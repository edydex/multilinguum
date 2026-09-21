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
  `the this that these those then when where what which who why how and but for
   with from into our your their his her its we you he she they it god lord jesus
   christ holy spirit bible scripture gospel there are was were have has had been
   being because than them not also only about again can could would should
   когда однако потому почему поэтому сегодня теперь тогда также только чтобы
   если хотя даже ведь лишь уже ещё еще очень более менее снова всегда иногда
   никогда здесь там туда оттуда отсюда куда где как что кто который которая
   которое которые которых этого этому этим этими этот эта эти это того тому тем
   тех такой такая такое такие таких наш наша наше наши ваш ваша ваше ваши нас
   нам нами вас вам вами его ему него нему её ей неё ней они она оно их им ими
   для при без над под про между через после перед будет будем будут был была
   было были есть можно нужно надо может могут должен должны`
    .trim()
    .split(/\s+/),
);

/** Local extraction: no notes or API key are sent to another model. Hints are vocabulary, not instructions. */
export function transcriptionKeywords(language: 'en' | 'ru', texts: readonly string[]): string[] {
  const terms = new Map<string, { text: string; count: number; proper: boolean }>();
  for (const text of texts) {
    // Bound processing independently of the upload limit. Include every selected document.
    for (const word of text.slice(0, 64_000).match(/[\p{L}][\p{L}\p{M}’'-]{2,59}/gu) ?? []) {
      const key = word.toLocaleLowerCase(language);
      // Notes can be bilingual. Filter both languages before ranking: Russian
      // sentence starters otherwise outrank useful terms and exhaust the hints.
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
