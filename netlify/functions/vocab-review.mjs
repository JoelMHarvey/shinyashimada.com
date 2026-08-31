/* ==========================================================================
   /api/vocab-review — mark a sentence Shin wrote using one of his words.

   POST { term, definition, sentence }
     -> { correct, usedWell, corrected, notes: [...], better }

   The typing exercises mark themselves — a term either matches or it does
   not. A written sentence cannot be marked that way, so this asks Claude,
   with a schema so the page gets fields to render rather than prose to
   parse.

   What it is asked to judge is deliberately narrow: whether the sentence is
   correct Spanish, and whether *this word* is used the way a native speaker
   would use it. A C1 candidate is not helped by "¡Muy bien!" on a sentence
   that is grammatical but idiomatically wrong.

   Environment:
     ANTHROPIC_API_KEY   required — the review is refused without it
     SITE_PASSCODE       required, always: this endpoint costs money per call
     VOCAB_REVIEW_MODEL  optional override, defaults to claude-opus-5
   ========================================================================== */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import { corsHeaders, preflight } from '../lib/cors.mjs';
import { secretsMatch } from '../lib/records.mjs';

const MODEL = process.env.VOCAB_REVIEW_MODEL || 'claude-opus-5';
const MAX_SENTENCE = 600;

const Review = z.object({
  correct: z.boolean().describe('Is the Spanish grammatically correct?'),
  usedWell: z.boolean().describe('Is the target word used the way a native speaker would use it?'),
  corrected: z.string().describe('The sentence with errors fixed. Identical to the input when nothing is wrong.'),
  notes: z
    .array(
      z.object({
        issue: z.string().describe('What is wrong, in one short phrase, in Spanish.'),
        why: z.string().describe('Why, in one sentence, in English.')
      })
    )
    .describe('One entry per real mistake. Empty when the sentence is correct. Never invent problems.'),
  better: z
    .string()
    .describe('A more idiomatic version at C1/C2 level, or an empty string if the sentence is already good.')
});

const SYSTEM = `You mark single Spanish sentences written by a learner preparing for the DELE C1/C2 exams.

He is given one word or expression and asked to write a sentence using it. Judge two things:
  1. Is the Spanish correct — grammar, agreement, prepositions, mood, accents?
  2. Is the target word used the way a native speaker would actually use it?

The second matters as much as the first. A sentence can be perfectly grammatical and still use the word wrongly: the wrong register, the wrong collocation, a literal sense where the expression is idiomatic. Say so when that happens.

Be exact and be brief. Report only real mistakes — never invent a problem to seem thorough, and do not restate a correct sentence as an error. If the sentence is right, say it is right and leave the notes empty.

Accents are errors. This is an exam skill.

Write "issue" in Spanish and "why" in English.`;

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(req)
    }
  });
}

/** Always gated: every call spends money on the site owner's key. */
function isAuthed(req) {
  const expected = process.env.SITE_PASSCODE;
  if (!expected) return false;
  return secretsMatch(req.headers.get('x-store-passcode'), expected);
}

export default async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, req);
  if (!isAuthed(req)) return json({ error: 'unauthorized' }, 401, req);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'no_api_key' }, 503, req);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_json' }, 400, req);
  }

  const term = String(body?.term ?? '').trim().slice(0, 120);
  const definition = String(body?.definition ?? '').trim().slice(0, 2000);
  const sentence = String(body?.sentence ?? '').trim();

  if (!term) return json({ error: 'no_term' }, 400, req);
  if (!sentence) return json({ error: 'no_sentence' }, 400, req);
  if (sentence.length > MAX_SENTENCE) {
    return json({ error: 'too_long', maxChars: MAX_SENTENCE }, 413, req);
  }

  const client = new Anthropic();

  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { format: zodOutputFormat(Review) },
      messages: [
        {
          role: 'user',
          content:
            `Palabra: ${term}\n` +
            (definition ? `Definición de su cuaderno: ${definition}\n` : '') +
            `\nFrase escrita por el estudiante:\n${sentence}`
        }
      ]
    });

    if (!response.parsed_output) {
      console.error('[vocab-review] no parsed output', response.stop_reason);
      return json({ error: 'no_review' }, 502, req);
    }

    return json(response.parsed_output, 200, req);
  } catch (err) {
    // Typed first, so a rate limit is not reported as a broken key.
    if (err instanceof Anthropic.AuthenticationError) {
      console.error('[vocab-review] bad API key');
      return json({ error: 'bad_api_key' }, 502, req);
    }
    if (err instanceof Anthropic.RateLimitError) {
      return json({ error: 'rate_limited' }, 429, req);
    }
    if (err instanceof Anthropic.APIError) {
      console.error('[vocab-review] API error', err.status, err.message);
      return json({ error: 'api_error', status: err.status }, 502, req);
    }
    console.error('[vocab-review] failed', err);
    return json({ error: 'review_failed' }, 500, req);
  }
};
