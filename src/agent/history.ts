import type { Message } from '../llm/provider.js';

const RECENT_STEPS_LIMIT = 8;

export class ConversationHistory {
  private messages: Message[] = [];
  private stepSummaries: string[] = [];
  private stepCount = 0;

  /** Total number of agent steps taken */
  getStepCount(): number {
    return this.stepCount;
  }

  /** Add any message to history */
  addMessage(message: Message): void {
    this.messages.push(message);
  }

  /** Record a completed tool step and generate a one-line summary */
  recordStep(toolName: string, toolArgs: Record<string, unknown>, resultData: string): void {
    this.stepCount++;
    const argsStr = summarizeArgs(toolName, toolArgs);
    this.stepSummaries.push(`Step ${this.stepCount}: ${toolName}(${argsStr}) → ${truncate(resultData, 80)}`);
  }

  /**
   * Build the message array for the next LLM call.
   * Strategy:
   *   - System message (added externally)
   *   - User task message (first user message)
   *   - If > RECENT_STEPS_LIMIT messages: older steps compressed into summaries
   *   - Last RECENT_STEPS_LIMIT assistant+tool pairs kept in full
   *   - Current page state appended as final user message (added externally)
   */
  buildMessages(): Message[] {
    if (this.messages.length === 0) return [];

    // Find the system message and initial user task
    const systemMsg = this.messages.find(m => m.role === 'system');
    const taskMsg = this.messages.find(m => m.role === 'user');

    // Conversation messages (after system + task): assistant/tool pairs
    const convMessages = this.messages.filter(
      m => m !== systemMsg && m !== taskMsg
    );

    const result: Message[] = [];

    if (systemMsg) result.push(systemMsg);
    if (taskMsg) result.push(taskMsg);

    // Group conversation into "turns": each turn starts with an assistant message
    // and includes all following tool results + the next user message (page state).
    // This ensures we never break assistant→tool pairs.
    const turns: Message[][] = [];
    let currentTurn: Message[] = [];

    for (const msg of convMessages) {
      if (msg.role === 'assistant' && currentTurn.length > 0) {
        turns.push(currentTurn);
        currentTurn = [];
      }
      currentTurn.push(msg);
    }
    if (currentTurn.length > 0) turns.push(currentTurn);

    if (turns.length > RECENT_STEPS_LIMIT) {
      // Compress old steps into a summary
      const oldStepsCount = Math.max(0, this.stepSummaries.length - RECENT_STEPS_LIMIT);
      if (oldStepsCount > 0) {
        const summaryText = this.stepSummaries.slice(0, oldStepsCount).join('\n');
        result.push({
          role: 'user',
          content: [{ type: 'text', text: `Previous actions summary:\n${summaryText}` }],
        });
      }

      // Keep recent turns in full (each turn = assistant + tools + user)
      const recentTurns = turns.slice(-RECENT_STEPS_LIMIT);
      for (const turn of recentTurns) {
        result.push(...turn);
      }
    } else {
      // Everything fits — keep all
      result.push(...convMessages);
    }

    return result;
  }

  /** Detect if the agent is looping (same tool+args 3+ times in a row) */
  isLooping(): boolean {
    if (this.stepSummaries.length < 3) return false;

    const last3 = this.stepSummaries.slice(-3);
    // Compare the action part (before "→")
    const actions = last3.map(s => s.split('→')[0].replace(/Step \d+: /, '').trim());
    return actions[0] === actions[1] && actions[1] === actions[2];
  }
}

function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'navigate':      return `"${args.url}"`;
    case 'click':         return `ref=${args.ref}`;
    case 'type_text':     return `ref=${args.ref}, "${args.text}"`;
    case 'select_option': return `ref=${args.ref}, "${args.option}"`;
    case 'scroll':        return `"${args.direction}"`;
    case 'wait':          return `${args.seconds}s`;
    case 'done':          return `"${truncate(String(args.result || ''), 50)}"`;
    default:              return JSON.stringify(args);
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}
