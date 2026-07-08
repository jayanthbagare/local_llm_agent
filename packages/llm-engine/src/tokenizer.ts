// ── Tokenizer ──
// Approximate token counting and chat template rendering.
// A real deployment would use the model's actual tokenizer.json
// but this provides usable estimates for context management.

import type { Message } from './types';

const AVG_CHARS_PER_TOKEN = 4;
const SPECIAL_RE = /<\|[^|]+\|>|<\/?s>|\[INST\]|\[\/INST\]/g;

/** Estimate token count for a string */
export function countTokens(text: string): number {
  if (!text) return 0;
  const specials = (text.match(SPECIAL_RE) || []).length;
  const clean = text.replace(SPECIAL_RE, ' ').trim();
  if (!clean) return specials;
  const words = clean.split(/\s+/);
  let n = specials;
  for (const w of words) n += Math.max(1, Math.ceil(w.length / AVG_CHARS_PER_TOKEN));
  return n;
}

/** Count tokens across messages */
export function countMessageTokens(msgs: Message[]): number {
  return msgs.reduce((sum, m) => sum + 3 + countTokens(m.content), 0);
}

// ── Chat Templates ──

export const CHAT_TEMPLATES: Record<string, string> = {
  'phi-3':
    '{% for m in messages %}<|{{m.role}}|>\n{{m.content}}<|end|>\n{% endfor %}{% if gen %}<|assistant|>\n{% endif %}',
  'llama-3':
    '<|begin_of_text|>{% for m in messages %}<|start_header_id|>{{m.role}}<|end_header_id|>\n\n{{m.content}}<|eot_id|>{% endfor %}{% if gen %}<|start_header_id|>assistant<|end_header_id|>\n\n{% endif %}',
  gemma:
    '{% for m in messages %}{% if m.role == "user" %}<start_of_turn>user\n{{m.content}}<end_of_turn>\n{% elif m.role == "assistant" %}<start_of_turn>model\n{{m.content}}<end_of_turn>\n{% elif m.role == "system" %}<start_of_turn>system\n{{m.content}}<end_of_turn>\n{% elif m.role == "tool" %}<start_of_turn>tool\n{{m.content}}<end_of_turn>\n{% endif %}{% endfor %}{% if gen %}<start_of_turn>model\n{% endif %}',
  chatml:
    '{% for m in messages %}<|im_start|>{{m.role}}\n{{m.content}}<|im_end|>\n{% endfor %}{% if gen %}<|im_start|>assistant\n{% endif %}',
};

/**
 * Apply a chat template to an array of messages.
 * Supports a simplified Jinja2 subset:
 *   {% for m in messages %}...{% endfor %}
 *   {% if m.role == "X" %}...{% elif m.role == "Y" %}...{% else %}...{% endif %}
 *   {% if gen %}...{% endif %}
 *   {{m.role}}  {{m.content}}
 */
export function applyChatTemplate(
  template: string,
  messages: { role: string; content: string }[],
  addGenerationPrompt = true,
): string {
  // Extract for-loop body
  const forRe = /\{%\s*for\s+m\s+in\s+messages\s*%\}([\s\S]*?)\{%\s*endfor\s*%\}/;
  const forMatch = template.match(forRe);
  let rendered = '';

  if (forMatch) {
    const body = forMatch[1];
    for (const m of messages) {
      rendered += renderMessageBlock(body, m);
    }
    // Replace the for block
    template = template.slice(0, forMatch.index!) + rendered + template.slice(forMatch.index! + forMatch[0].length);
  }

  // Handle {% if gen %}...{% endif %}
  template = template.replace(/\{%\s*if\s+gen\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g, (_, content) =>
    addGenerationPrompt ? content : '',
  );

  return template.trim();
}

function renderMessageBlock(body: string, m: { role: string; content: string }): string {
  // Parse if/elif/else chain: {% if m.role == "X" %}...{% elif ... %}...{% else %}...{% endif %}
  const branches: { role: string | null; content: string }[] = [];
  const branchRe = /\{%\s*(if\s+m\.role\s*==\s*"(\w+)"|elif\s+m\.role\s*==\s*"(\w+)"|else|endif)\s*%\}/g;
  let match: RegExpExecArray | null;
  let lastIdx = 0;
  let currentRole: string | null = null;

  while ((match = branchRe.exec(body)) !== null) {
    if (match.index > lastIdx && currentRole !== undefined) {
      // Capture content between tags
    }
    const tag = match[1];
    if (tag.startsWith('if')) {
      currentRole = match[2];
      lastIdx = match.index + match[0].length;
    } else if (tag.startsWith('elif')) {
      if (currentRole !== null) {
        branches.push({ role: currentRole, content: body.slice(lastIdx, match.index) });
      }
      currentRole = match[3];
      lastIdx = match.index + match[0].length;
    } else if (tag === 'else') {
      if (currentRole !== null) {
        branches.push({ role: currentRole, content: body.slice(lastIdx, match.index) });
      }
      currentRole = null; // null = else branch
      lastIdx = match.index + match[0].length;
    } else if (tag === 'endif') {
      branches.push({ role: currentRole, content: body.slice(lastIdx, match.index) });
      currentRole = undefined as any;
    }
  }

  if (branches.length > 0) {
    const found = branches.find(b => b.role === m.role) || branches.find(b => b.role === null);
    const chosen = found ? found.content : '';
    return chosen.replace(/\{\{\s*m\.role\s*\}\}/g, m.role).replace(/\{\{\s*m\.content\s*\}\}/g, m.content);
  }

  // No conditionals — direct substitution
  return body.replace(/\{\{\s*m\.role\s*\}\}/g, m.role).replace(/\{\{\s*m\.content\s*\}\}/g, m.content);
}
