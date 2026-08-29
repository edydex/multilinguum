import OpenAI from 'openai';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY is required.');

const model = process.env.OPENAI_TEXT_MODEL ?? 'gpt-5.6-terra';
const sourceText =
  'Благодать вам и мир. Если мы ошиблись, будем готовы признать это, исправить путь и снова ' +
  'искать мира. Господь укрепляет тех, кто уповает на Него.';
const client = new OpenAI({ apiKey });
const startedAt = Date.now();
const response = await client.responses.create({
  model,
  instructions:
    'Translate Russian church sermon speech faithfully into English. Preserve theological ' +
    'meaning exactly. Never strengthen an ordinary mistake into sin and never add commentary. ' +
    'Return only the translation.',
  input: [
    'Terminology:',
    'Благодать вам => Grace to you',
    'ошиблись => made a mistake / were wrong',
    'Господь => the Lord',
    '',
    `Translate:\n${sourceText}`,
  ].join('\n'),
});

process.stdout.write(
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      privacy: 'self-authored synthetic text; no preacher recording or voice profile',
      model,
      elapsedMs: Date.now() - startedAt,
      sourceText,
      translation: response.output_text.trim(),
      usage: response.usage,
    },
    null,
    2,
  )}\n`,
);
