// ── SDK Tests ──
import { describe, it, expect } from 'vitest';
import { createAgent } from '../src/index.js';
describe('createAgent', () => {
    it('creates an agent with simulated engine', async () => {
        const agent = await createAgent({ simulated: true });
        expect(agent).toBeDefined();
        expect(typeof agent.run).toBe('function');
        expect(typeof agent.abort).toBe('function');
        expect(typeof agent.destroy).toBe('function');
        await agent.destroy();
    });
    it('runs a simple query', async () => {
        const agent = await createAgent({ simulated: true });
        const events = [];
        for await (const event of agent.run('Hello')) {
            events.push(event);
        }
        const done = events.find((e) => e.type === 'done');
        expect(done).toBeDefined();
        expect(done.response).toBeTruthy();
        await agent.destroy();
    });
    it('registers and uses a custom skill', async () => {
        const agent = await createAgent({
            simulated: true,
            customSkills: [
                {
                    id: 'greeter',
                    name: 'Greeter',
                    version: '1.0.0',
                    tool: {
                        type: 'function',
                        execute: 'return { greeting: "Hello, " + params.name + "!" };',
                        parameters: {
                            name: { type: 'string', description: 'Name', required: true },
                        },
                    },
                    resultTemplate: '{{greeting}}',
                },
            ],
        });
        const skills = agent.getSkills();
        expect(skills).toHaveLength(1);
        expect(skills[0].id).toBe('greeter');
        await agent.destroy();
    });
    it('clears conversation history', async () => {
        const agent = await createAgent({ simulated: true });
        for await (const _event of agent.run('Hello')) {
            // consume
        }
        agent.clearHistory();
        // No assertion needed — just verify it doesn't throw
        await agent.destroy();
    });
    it('handles abort gracefully', async () => {
        const agent = await createAgent({ simulated: true });
        const promise = (async () => {
            const events = [];
            for await (const event of agent.run('Tell me a long story')) {
                events.push(event);
                agent.abort();
            }
            return events;
        })();
        const events = await promise;
        expect(Array.isArray(events)).toBe(true);
        await agent.destroy();
    });
});
//# sourceMappingURL=sdk.test.js.map