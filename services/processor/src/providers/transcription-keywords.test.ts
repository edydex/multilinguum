import { describe, expect, it } from 'vitest';
import { transcriptionKeywords } from './transcription-keywords.js';

describe('sermon recognition vocabulary', () => {
  it('keeps Russian sermon terms when sentence starters would fill the hint budget', () => {
    const connectiveWords = `Когда Однако Потому Почему Поэтому Сегодня Теперь Тогда Также
      Только Чтобы Если Хотя Даже Ведь Лишь Уже Ещё Еще Очень Более Менее Снова Всегда
      Иногда Никогда Здесь Там Туда Оттуда Отсюда Куда Где Как Что Кто Который Которая
      Которое Которые Которых Этого Этому Этим Этими Этот Эта Эти Это Того Тому Тем
      Тех Такой Такая Такое Такие Таких Наш Наша Наше Наши Ваш Ваша Ваше Ваши Нас
      Нам Нами Вас Вам Вами Его Ему Него Нему Её Ей Неё Ней Они Она Оно Их Им Ими
      Для При Без Над Под Про Между Через После Перед Будет Будем Будут Был Была
      Было Были Есть Можно Нужно Надо Может Могут Должен Должны`;
    const notes = `${connectiveWords
      .split(/\s+/)
      .map((word) => `${word} мы продолжаем.`)
      .join(' ')}
      Иезекииль и Навуходоносор. Снисхождение Бога: снисхождение и долготерпение.
      Снисхождение связано с милосердием, а долготерпение не отменяет праведность.`;

    const hints = transcriptionKeywords('ru', [notes]).map((word) => word.toLowerCase());
    expect(hints).toEqual(
      expect.arrayContaining([
        'иезекииль',
        'навуходоносор',
        'снисхождение',
        'долготерпение',
        'милосердием',
      ]),
    );
    for (const word of ['когда', 'однако', 'почему', 'потому', 'что', 'для', 'будем']) {
      expect(hints).not.toContain(word);
    }
  });

  it('filters both languages in bilingual notes without removing theological vocabulary', () => {
    const notes = [
      'There are words that have been repeated because they were important. ' +
        'Иезекииль and Ezekiel: resurrection and воскресение. ' +
        'Поэтому мы читаем о воскресении. Because resurrection matters, mercy and милосердие matter.',
    ];
    for (const language of ['en', 'ru'] as const) {
      const hints = transcriptionKeywords(language, notes).map((word) => word.toLowerCase());
      expect(hints).toEqual(
        expect.arrayContaining([
          'иезекииль',
          'ezekiel',
          'resurrection',
          'воскресение',
          'милосердие',
        ]),
      );
      for (const word of ['there', 'are', 'have', 'been', 'because', 'were', 'поэтому']) {
        expect(hints).not.toContain(word);
      }
      expect(hints.length).toBeLessThanOrEqual(64);
      expect(hints.join('').length).toBeLessThanOrEqual(1_500);
    }
  });
});
