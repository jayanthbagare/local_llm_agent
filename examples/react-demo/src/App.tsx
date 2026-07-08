// ── React Demo: Local LLM Agent Chat ──
// Demonstrates using the AgentProvider and hooks.

import React, { useState, useRef, useEffect } from 'react';
import {
  AgentProvider,
  useAgent,
  useAgentResponse,
  useAgentTools,
} from '../../packages/react/src/index.js';

// ── Chat UI Component ──

function ChatBox() {
  const { isReady, isRunning, error, run, clearHistory } = useAgent();
  const { response } = useAgentResponse();
  const toolCalls = useAgentTools();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([]);
  const chatRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages, response]);

  const handleSend = async () => {
    if (!input.trim() || isRunning) return;

    const userMsg = input.trim();
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setInput('');

    try {
      await run(userMsg);
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'error',
        content: err instanceof Error ? err.message : String(err),
      }]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Update messages when agent responds
  useEffect(() => {
    if (response) {
      setMessages(prev => {
        // Replace or append
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && last.content !== response) {
          return [...prev.slice(0, -1), { role: 'assistant', content: response }];
        }
        if (last?.role === 'assistant') return prev;
        return [...prev, { role: 'assistant', content: response }];
      });
    }
  }, [response]);

  if (!isReady) {
    return (
      <div style={styles.loading}>
        <p>🔄 Loading model... This may take a moment.</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>🤖 Local LLM Agent</h2>
        <div style={styles.stats}>
          {toolCalls.length > 0 && (
            <span style={styles.badge}>🔧 {toolCalls.length} tool call(s)</span>
          )}
          <button onClick={clearHistory} style={styles.clearBtn} title="Clear chat">
            🗑️
          </button>
        </div>
      </div>

      {error && (
        <div style={styles.error}>
          ⚠️ {error}
        </div>
      )}

      <div ref={chatRef} style={styles.chat}>
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              ...styles.message,
              ...(msg.role === 'user' ? styles.userMsg : {}),
              ...(msg.role === 'error' ? styles.errorMsg : {}),
              ...(msg.role === 'assistant' ? styles.assistantMsg : {}),
            }}
          >
            <div style={styles.roleLabel}>
              {msg.role === 'user' ? 'You' : msg.role === 'error' ? 'Error' : 'Agent'}
            </div>
            <div style={styles.content}>{msg.content}</div>
          </div>
        ))}
        {isRunning && !response && (
          <div style={styles.thinking}>Thinking...</div>
        )}
      </div>

      <div style={styles.inputRow}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything... (e.g., 'Calculate 256 * 128')"
          style={styles.textarea}
          disabled={isRunning}
          rows={2}
        />
        <button
          onClick={handleSend}
          disabled={isRunning || !input.trim()}
          style={{
            ...styles.sendBtn,
            opacity: isRunning || !input.trim() ? 0.5 : 1,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

// ── App ──

export default function App() {
  return (
    <AgentProvider
      simulated={true}
      customSkills={[
        {
          id: 'calculator',
          name: 'Calculator',
          version: '1.0.0',
          description: 'Evaluates mathematical expressions',
          tool: {
            type: 'function',
            execute: 'return eval(params.expression);',
            parameters: {
              expression: { type: 'string', description: 'Math expression', required: true },
            },
          },
          resultTemplate: '{{expression}} = {{result}}',
        },
      ]}
      systemPrompt="You are a helpful, concise assistant running locally in the browser. Use tools when beneficial."
    >
      <ChatBox />
    </AgentProvider>
  );
}

// ── Styles ──

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 700,
    margin: '0 auto',
    padding: 20,
    fontFamily: 'system-ui, sans-serif',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: {
    margin: 0,
    fontSize: 24,
    color: '#58a6ff',
  },
  stats: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  badge: {
    background: '#0d3326',
    color: '#3fb950',
    padding: '4px 10px',
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 600,
  },
  clearBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontSize: 18,
    padding: 4,
  },
  chat: {
    border: '1px solid #30363d',
    borderRadius: 8,
    height: 400,
    overflowY: 'auto',
    padding: 16,
    background: '#161b22',
    marginBottom: 16,
  },
  message: {
    marginBottom: 12,
    padding: '8px 12px',
    borderRadius: 8,
    maxWidth: '85%',
  },
  userMsg: {
    background: '#1f6feb',
    color: '#fff',
    marginLeft: 'auto',
  },
  assistantMsg: {
    background: '#21262d',
    color: '#c9d1d9',
  },
  errorMsg: {
    background: '#490202',
    border: '1px solid #da3633',
    color: '#f85149',
  },
  roleLabel: {
    fontSize: 11,
    fontWeight: 600,
    marginBottom: 4,
    opacity: 0.7,
    textTransform: 'uppercase',
  },
  content: {
    fontSize: 14,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  thinking: {
    color: '#8b949e',
    fontStyle: 'italic',
    fontSize: 14,
    animation: 'pulse 1s infinite',
  },
  error: {
    background: '#490202',
    border: '1px solid #da3633',
    color: '#f85149',
    padding: '8px 16px',
    borderRadius: 8,
    marginBottom: 16,
    fontSize: 14,
  },
  inputRow: {
    display: 'flex',
    gap: 8,
  },
  textarea: {
    flex: 1,
    padding: 12,
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 8,
    color: '#c9d1d9',
    fontSize: 14,
    resize: 'none',
    fontFamily: 'system-ui, sans-serif',
  },
  sendBtn: {
    padding: '12px 24px',
    background: '#238636',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
    alignSelf: 'flex-end',
  },
  loading: {
    textAlign: 'center',
    padding: 60,
    color: '#8b949e',
    fontSize: 18,
  },
};
