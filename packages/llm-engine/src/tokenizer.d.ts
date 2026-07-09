import type { Message } from './types';
/** Estimate token count for a string */
export declare function countTokens(text: string): number;
/** Count tokens across messages */
export declare function countMessageTokens(msgs: Message[]): number;
export declare const CHAT_TEMPLATES: Record<string, string>;
/**
 * Apply a chat template to an array of messages.
 * Supports a simplified Jinja2 subset:
 *   {% for m in messages %}...{% endfor %}
 *   {% if m.role == "X" %}...{% elif m.role == "Y" %}...{% else %}...{% endif %}
 *   {% if gen %}...{% endif %}
 *   {{m.role}}  {{m.content}}
 */
export declare function applyChatTemplate(template: string, messages: {
    role: string;
    content: string;
}[], addGenerationPrompt?: boolean): string;
//# sourceMappingURL=tokenizer.d.ts.map